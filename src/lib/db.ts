import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

let _sb: SupabaseClient | null = null

export function getDb(): SupabaseClient {
  if (!_sb) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error('Supabase credentials not configured')
    }
    _sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  }
  return _sb
}

// ─── Password hashing ──────────────────────────────────────────────────────
// F-05 fix: раньше пароли хэшировались голым SHA-256+salt — снимается GPU-перебором.
// Теперь scrypt (memory-hard KDF, рекомендован OWASP): N=2^14, r=8, p=1, 64-байтный ключ.
// Формат: scrypt$N$r$p$<salt hex>$<hash hex>.
// Существующие пользователи с SHA-256 (salt:hash) продолжают работать, а после первого
// успешного входа хэш прозрачно обновляется на scrypt (см. passwordNeedsRehash).
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 64

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$')
    if (parts.length !== 6) return false
    const [, nStr, rStr, pStr, saltHex, hashHex] = parts
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    try {
      const computed = scryptSync(password, salt, expected.length, {
        N: Number(nStr), r: Number(rStr), p: Number(pStr),
      })
      return timingSafeEqual(computed, expected)
    } catch {
      return false
    }
  }
  // Legacy SHA-256 (salt:hash) — старые пользователи до миграции на scrypt
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const computed = createHash('sha256').update(salt + password).digest('hex')
  const a = Buffer.from(computed, 'utf8')
  const b = Buffer.from(hash, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b) // теперь constant-time
}

/** true, если хэш в старом формате (SHA-256) и его надо перехэшировать при следующем входе */
export function passwordNeedsRehash(stored: string): boolean {
  return !stored.startsWith('scrypt$')
}

// ─── Session token ─────────────────────────────────────────────────────
export async function generateToken(): Promise<string> {
  const crypto = await import('crypto')
  return crypto.randomBytes(32).toString('hex')
}

// ─── User by auth token (joins sessions + users + subscriptions) ───────
export async function getUserByToken(token: string) {
  const db = getDb()
  const { data: session, error: sErr } = await db
    .from('sessions')
    .select('user_id, created_at')
    .eq('token', token)
    .single()

  if (sErr || !session) return null

  // Session expiry: 30 days
  const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
  const sessionAge = Date.now() - new Date(session.created_at).getTime()
  if (sessionAge > SESSION_MAX_AGE_MS) {
    // Auto-expire old sessions
    const db = getDb()
    await db.from('sessions').delete().eq('token', token)
    return null
  }

  const { data: user, error: uErr } = await db
    .from('users')
    .select('*')
    .eq('id', session.user_id)
    .single()

  if (uErr || !user) return null

  // Get active subscription
  const { data: sub } = await db
    .from('subscriptions')
    .select('*')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.created_at,
    subscription: sub ? {
      planId: sub.plan_id,
      activatedAt: new Date(sub.activated_at).getTime(),
      expiresAt: new Date(sub.expires_at).getTime(),
      isActive: true,
      remainingDays: Math.max(0, Math.ceil((new Date(sub.expires_at).getTime() - Date.now()) / 86400000)),
    } : null,
  }
}

// ─── Activate subscription (called from YooMoney webhook) ──────────────
export async function activateSubscription(userId: string, planId: string) {
  const db = getDb()
  const planMonths: Record<string, number> = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }
  const months = planMonths[planId] || 1

  // Check existing active subscription
  const { data: existing } = await db
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  const now = new Date()
  const baseDate = existing ? new Date(existing.expires_at) : now
  const expiresAt = new Date(baseDate.getTime() + months * 30 * 86400000)

  // Deactivate old subscriptions
  if (existing) {
    await db.from('subscriptions').update({ is_active: false }).eq('id', existing.id)
  }

  const { error } = await db.from('subscriptions').insert({
    user_id: userId,
    plan_id: planId,
    activated_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    is_active: true,
  })

  if (error) throw new Error(`Failed to activate subscription: ${error.message}`)
  return { planId, expiresAt: expiresAt.getTime() }
}

// ─── Get user by email ─────────────────────────────────────────────────
export async function getUserByEmail(email: string) {
  const db = getDb()
  const { data, error } = await db
    .from('users')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .maybeSingle()
  if (error || !data) return null
  return data
}

// ─── F-13: жизненный цикл сессий ───────────────────────────────────────
// Раньше истёкшие сессии удалялись только лениво — если пользователь пришёл
// со своим старым токеном; сессии, по которым никто не приходил, копились
// в таблице вечно. Теперь: (1) ежедневная очистка в кроне sync-anime,
// (2) лимит 10 активных сессий на пользователя с вытеснением старых
// (вызывается при каждом login).

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Удалить все сессии старше 30 дней. Возвращает число удалённых записей. */
export async function cleanupExpiredSessions(): Promise<number> {
  const db = getDb()
  const cutoff = new Date(Date.now() - SESSION_MAX_AGE_MS).toISOString()
  const { count, error } = await db
    .from('sessions')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff)
  if (error) throw new Error(`cleanupExpiredSessions: ${error.message}`)
  return count || 0
}

/** Оставить пользователю не более maxSessions самых свежих сессий. */
export async function capUserSessions(userId: string, maxSessions = 10): Promise<void> {
  const db = getDb()
  const { data, error } = await db
    .from('sessions')
    .select('token')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error || !data) return
  if (data.length <= maxSessions) return
  const stale = data.slice(maxSessions).map((r: { token: string }) => r.token)
  if (stale.length === 0) return
  await db.from('sessions').delete().in('token', stale)
}

// ─── Auth from request ─────────────────────────────────────────────────
// F-07 fix: принимаем и Authorization: Bearer (legacy), и httpOnly cookie
// anime_platform_token — основной способ после миграции.
export async function authFromRequest(request: Request) {
  let token: string | null = null

  const auth = request.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) token = auth.slice(7)

  if (!token) {
    const cookieHeader = request.headers.get('cookie') || ''
    const m = cookieHeader.match(/(?:^|;\s*)anime_platform_token=([^;]+)/)
    if (m) token = m[1]
  }

  if (!token) return null
  return getUserByToken(token)
}
