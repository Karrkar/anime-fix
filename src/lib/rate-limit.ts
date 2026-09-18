/**
 * Rate-limiting для serverless (патчи F-10 + F-11 из аудита, батч 3).
 *
 * F-10 (было): корзины жили в Map процесса -> лимит умножался на число
 * тёплых инстансов, а setInterval-очистка в лямбдах не гарантировалась
 * (плюс баг в самой очистке). Теперь счётчики первично хранятся в Supabase
 * (общее хранилище для всех инстансов) через атомарную RPC-функцию
 * check_rate_limit (см. scripts/create-rate-limit-table-v2.sql).
 *
 * Отказоустойчивость: если таблица/функция ещё не созданы в БД или Supabase
 * недоступен, limiter прозрачно падает обратно на in-memory sliding window
 * (хуже, чем ничего) + circuit breaker: после 3 подряд ошибок RPC не
 * вызывается 60 секунд, чтобы не удваивать latency каждого запроса.
 *
 * F-11 (было): getClientIp брал первую запись x-forwarded-for — клиентского
 * заголовка, который можно подделать, а всех без адреса клал в одну корзину
 * "unknown" (легитимные пользователи блокировали друг друга). Теперь:
 *  1) приоритет у x-real-ip — его проставляет сама платформа Vercel;
 *  2) fallback x-forwarded-for (первая запись — на Vercel это клиент);
 *  3) если адреса нет вовсе — псевдо-ID из user-agent, чтобы анонимы
 *     не делили одну корзину.
 */
import { createHash } from 'crypto'
import { getDb } from './db'
import { logEvent } from './logger'

export interface RateLimitConfig {
  windowMs: number    // окно в миллисекундах
  maxRequests: number // максимум запросов в окне
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 60,
}

// Строгие лимиты для чувствительных эндпоинтов
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  '/api/subscription': { windowMs: 60_000, maxRequests: 30 }, // F-29: было 10 — душит связку login/check/logout
  '/api/yoomoney-notify': { windowMs: 60_000, maxRequests: 30 },
  '/api/favorites': { windowMs: 60_000, maxRequests: 30 },
  '/api/history': { windowMs: 60_000, maxRequests: 30 },
  '/api/rule34': { windowMs: 60_000, maxRequests: 20 },
  '/api/search': { windowMs: 60_000, maxRequests: 30 },
  '/api/age-confirm': { windowMs: 60_000, maxRequests: 10 },
  '/api/chat': { windowMs: 60_000, maxRequests: 12 }, // чат с Лилит: LLM-вызовы дороги
}

// ─── F-11: корректный адрес клиента ────────────────────────────────────────
export function getClientIp(request: Request): string {
  // 1) x-real-ip ставит сама платформа Vercel — подделать нельзя
  const real = request.headers.get('x-real-ip')
  if (real && real.trim()) return real.trim()

  // 2) x-forwarded-for: на Vercel первая запись — фактический клиент
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) {
    const first = fwd.split(',')[0]?.trim()
    if (first) return first
  }

  // 3) Без адреса: псевдо-ID из user-agent — анонимы не в одной корзине
  const ua = request.headers.get('user-agent') || ''
  const h = createHash('sha1').update(ua).digest('hex').slice(0, 16)
  return `anon-${h}`
}

// ─── In-memory fallback (исправленный: без setInterval, с границей) ───────
interface Bucket {
  timestamps: number[]
}

const memoryBuckets = new Map<string, Bucket>()
const MEMORY_BUCKETS_CAP = 10_000 // защита от роста Map в долгоживущем инстансе

function memoryRateLimit(key: string, config: RateLimitConfig): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now()
  const windowStart = now - config.windowMs

  let bucket = memoryBuckets.get(key)
  if (!bucket) {
    if (memoryBuckets.size >= MEMORY_BUCKETS_CAP) {
      // Вытесняем самые старые по вставке записи (Map хранит порядок)
      let toDelete = Math.floor(MEMORY_BUCKETS_CAP / 4)
      for (const k of memoryBuckets.keys()) {
        if (toDelete-- <= 0) break
        memoryBuckets.delete(k)
      }
    }
    bucket = { timestamps: [] }
    memoryBuckets.set(key, bucket)
  }

  bucket.timestamps = bucket.timestamps.filter(t => t > windowStart)

  if (bucket.timestamps.length >= config.maxRequests) {
    const oldestInWindow = bucket.timestamps[0]
    return { allowed: false, remaining: 0, resetAt: oldestInWindow + config.windowMs }
  }

  bucket.timestamps.push(now)
  return { allowed: true, remaining: config.maxRequests - bucket.timestamps.length, resetAt: now + config.windowMs }
}

// ─── Circuit breaker для RPC ───────────────────────────────────────────────
let rpcConsecutiveFailures = 0
let rpcDisabledUntil = 0

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
  source: 'supabase' | 'memory'
}

/**
 * Проверка лимита. Первично — общая таблица в Supabase (все инстансы
 * считают один счётчик), при недоступности — in-memory fallback.
 */
export async function rateLimit(ip: string, pathname: string): Promise<RateLimitResult> {
  const config = RATE_LIMITS[pathname] || DEFAULT_CONFIG
  const now = Date.now()

  if (now >= rpcDisabledUntil) {
    try {
      const db = getDb()
      const { data, error } = await db.rpc('check_rate_limit', {
        p_bucket: pathname,
        p_ip: ip,
        p_max: config.maxRequests,
        p_window_ms: config.windowMs,
      })
      if (error) throw error
      const allowed = data === true
      rpcConsecutiveFailures = 0
      return {
        allowed,
        remaining: allowed ? Math.max(0, config.maxRequests - 1) : 0,
        resetAt: now + config.windowMs,
        source: 'supabase',
      }
    } catch (e) {
      rpcConsecutiveFailures++
      // Батч 6 (диагностика): раньше ошибка RPC глоталась молча — снаружи
      // fallback невозможно было отличить от рабочего Supabase. Теперь
      // каждое падение видно в Runtime Logs (не более ~3 строк/мин на
      // инстанс — дальше открывается circuit breaker).
      logEvent('rate_limit_db_error', {
        // PostgrestError — обычный объект (не Error): String() даёт
        // "[object Object]", поэтому сериализуем в JSON явно.
        message: (e instanceof Error
          ? e.message
          : (() => { try { return JSON.stringify(e); } catch { return String(e); } })()
        ).slice(0, 200),
        consecutive: rpcConsecutiveFailures,
      }, 'warn')
      if (rpcConsecutiveFailures >= 3) {
        // 60 секунд живём на in-memory, чтобы не гонять мёртвый RPC
        rpcDisabledUntil = now + 60_000
        rpcConsecutiveFailures = 0
      }
      // fall through -> memory
    }
  }

  const memory = memoryRateLimit(`${ip}:${pathname}`, config)
  return { ...memory, source: 'memory' }
}
