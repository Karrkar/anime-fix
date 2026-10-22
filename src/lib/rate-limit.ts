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
 * "unknown" (легитимные пользователи блокировали друг друга).
 *
 * ФИКС ОКТЯБРЬ 2026 (подтверждено аудитом: rate_limits в БД хранит только
 * IP Cloudflare — 172.71.x, 104.23.x, 162.158.x — и реальный клиент под
 * этим не виден): у сайта включён прокси Cloudflare (оранжевое облако в
 * DNS), поэтому С ВЕРСИ VERCEL ФУНКЦИИ «клиентом» выглядит край CDN
 * Cloudflare. x-forwarded-for на Vercel содержит адрес СОЕДИНЕНИЯ
 * (edge-ноду Cloudflare), а не посетителя: все пользователи сайта
 * делят несколько корзин чужих IP -> массовые ложные 429 и обратимый
 * злоумышленником лимит. Решение — тот же заголовок, которым пользуется
 * сам Cloudflare: CF-Connecting-IP. Cloudflare гарантированно
 * перезаписывает его значением реального посетителя (подделка снаружи
 * через CF-путь невозможна), поэтому он проверяется ПЕРВЫМ.
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

// ─── F-11 + CF-фикс: корректный адрес клиента ─────────────────────────────
// Порядок доверия (первый непустой валидный выигрывает):
//   1) cf-connecting-ip — ставит Cloudflare, перезаписывая клиентское
//      значение: реальный посетитель для любого запроса через наш домен
//      (прокси-облако в DNS включено). Основной источник.
//   2) true-client-ip — Cloudflare Enterprise (задел на будущее).
//   3) x-real-ip — не платформенный на Vercel, но сохранил совместимость
//      со старым кодом; приоритет ниже, т.к. подделывается клиентом
//      при прямом заходе мимо Cloudflare.
//   4) x-forwarded-for (первая запись) — последний эшелон: без CF-прокси
//      Vercel кладёт сюда адрес соединения.
// Нигде не валидное значение (мусор/спуф) — пропускаем, чтобы мусор
// не отравлял корзину честного IP.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){1,7}$|^(?:::[0-9a-f:.]*)$/;

function isIpv4(s: string): boolean {
  const m = s.match(IPV4_RE);
  if (!m) return false;
  return [m[1], m[2], m[3], m[4]].every(o => Number(o) <= 255);
}

function isIpv6(s: string): boolean {
  if (!s.includes(':')) return false;
  // Прагматичная проверка: hex-группы + двоеточия (+ встроенный IPv4 хвост)
  return IPV6_RE.test(s) || /^[0-9a-f:]+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})?$/i.test(s) && (s.match(/::/g)?.length ?? 0) <= 1;
}

/** Нормализация кандидата: снять порт, проверить на валидный IP.
 *  Возвращает готовый к использованию адрес или null (не IP вовсе). */
export function normalizeIpCandidate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim();
  if (!v) return null;
  // Несколько значений в одном заголовке ("a, b") — берём первое
  const comma = v.indexOf(',');
  if (comma > -1) v = v.slice(0, comma).trim();
  if (!v) return null;
  // "[2001:db8::1]:5678" -> "2001:db8::1"
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end > -1) v = v.slice(1, end);
  }
  // "203.0.113.7:54321" -> "203.0.113.7" (голый IPv6 порта без скобок не бывает)
  const withPort = v.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/);
  if (withPort) v = withPort[1];
  if (!v) return null;
  if (isIpv4(v)) return v;
  const lower = v.toLowerCase();
  if (isIpv6(lower)) return lower;
  return null;
}

export function getClientIp(request: Request): string {
  // 1) cf-connecting-ip: Cloudflare перезаписывает — реальный посетитель.
  //    Пройдя через CF-прокси, ЛЮБОЙ другой заголовок адреса содержит
  //    edge-IP Cloudflare (что и виделось в БД как 172.71.x/104.23.x).
  const cfIp = normalizeIpCandidate(request.headers.get('cf-connecting-ip'));
  if (cfIp) return cfIp;

  // 2) true-client-ip (Cloudflare Enterprise)
  const tci = normalizeIpCandidate(request.headers.get('true-client-ip'));
  if (tci) return tci;

  // 3) x-real-ip (не платформенный; сохранён для совместимости — приоритет
  //    ниже, т.к. подделывается клиентом при прямом заходе мимо Cloudflare)
  const real = normalizeIpCandidate(request.headers.get('x-real-ip'));
  if (real) return real;

  // 4) x-forwarded-for: без CF-прокси Vercel кладёт сюда адрес соединения.
  //    Первая запись может быть подделана клиентом при прямом заходе,
  //    но валидация хотя бы отсекает мусор.
  const fwdFirst = request.headers.get('x-forwarded-for')?.split(',')[0];
  const fwdIp = normalizeIpCandidate(fwdFirst);
  if (fwdIp) return fwdIp;

  // 5) Без адреса: псевдо-ID из user-agent — анонимы не в одной корзине
  const ua = request.headers.get('user-agent') || '';
  const h = createHash('sha1').update(ua).digest('hex').slice(0, 16);
  return `anon-${h}`;
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
