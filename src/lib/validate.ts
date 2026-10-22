/**
 * Input validation & sanitization utilities.
 */

// ─── Sanitizers ──────────────────────────────────────────────────────────

/** Strip HTML tags, keep only safe text */
export function sanitizeString(input: unknown, maxLength = 500): string {
  if (typeof input !== 'string') return ''
  return input
    .replace(/<[^>]*>/g, '')       // strip HTML tags
    .replace(/[\x00-\x1F\x7F]/g, '') // strip control chars
    .trim()
    .slice(0, maxLength)
}

/** Validate and sanitize email */
export function sanitizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const email = input.toLowerCase().trim()
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(email)) return null
  return email
}

/** Validate password — вход: любой непустой пароль до 128 символов.
 *  Мягкие правила для LOGIN: старые пользователи могут иметь короткие пароли
 *  (раньше фронт пускал minLength 4). Жёсткая проверка для регистрации —
 *  см. validatePasswordStrict. */
export function validatePassword(input: unknown): string | null {
  if (typeof input !== 'string') return null
  if (input.length < 1 || input.length > 128) return null
  return input
}

/** Validate password для РЕГИСТРАЦИИ (F-09 fix: min 8 симв., буквы + цифры) */
export function validatePasswordStrict(input: unknown): string | null {
  if (typeof input !== 'string') return null
  if (input.length < 8 || input.length > 128) return null
  if (!/[a-zA-Zа-яА-ЯёЁ]/.test(input)) return null // хотя бы одна буква
  if (!/\d/.test(input)) return null               // хотя бы одна цифра
  return input
}

/** Validate animeId — alphanumeric + dash + underscore */
export function validateAnimeId(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const id = input.trim()
  if (!/^[a-zA-Z0-9\-_]+$/.test(id)) return null
  return id.slice(0, 100)
}

/** Validate plan ID */
export function validatePlanId(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const validPlans = ['1m', '3m', '6m', '1y']
  if (!validPlans.includes(input)) return null
  return input
}

/** Validate episode number */
export function validateEpisodeNumber(input: unknown): number | null {
  const n = Number(input)
  if (!Number.isFinite(n) || n < 1 || n > 9999) return null
  return Math.floor(n)
}

// ─── F-14: полный SSRF-блоклист + DNS-резолв ──────────────────────────────
// Старая версия проверяла только литералы localhost/127.0.0.1/10.x/192.168.x/
// 169.254.x и пропускала: 172.16/12, CGNAT 100.64/10, IPv6 ULA fc00::/7,
// IPv4-mapped ::ffff:127.0.0.1, десятичную запись (http://2130706433) и
// DNS-rebinding. Теперь: расширенный блоклист + проверка ВСЕХ адресов,
// в которые резолвится хост (ленивый import dns/promises — модуль остаётся
// edge-совместимым, т.к. без top-level Node-импортов).

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const s of parts) {
    const v = Number(s)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = n * 256 + v
  }
  return n
}

function v4InCidr(n: number, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/')
  const bits = Number(bitsStr)
  const baseInt = v4ToInt(base)
  if (baseInt === null || Number.isNaN(bits) || bits < 0 || bits > 32) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((n & mask) >>> 0) === ((baseInt & mask) >>> 0)
}

/** Приватные/служебные диапазоны IPv4 и IPv6 (RFC 1918/4193/6598 + special-use) */
export function isPrivateIp(ip: string): boolean {
  const raw = ip.trim().toLowerCase()

  // IPv4-литерал
  const v4 = v4ToInt(raw)
  if (v4 !== null) {
    const blocked = [
      '0.0.0.0/8',        // "this network"
      '10.0.0.0/8',       // private (RFC 1918)
      '100.64.0.0/10',    // CGNAT (RFC 6598)
      '127.0.0.0/8',      // loopback
      '169.254.0.0/16',   // link-local
      '172.16.0.0/12',    // private (RFC 1918) — раньше пропускался!
      '192.0.0.0/24',     // IETF protocol assignments
      '192.0.2.0/24',     // TEST-NET-1
      '192.168.0.0/16',   // private (RFC 1918)
      '198.18.0.0/15',    // benchmarking
      '198.51.100.0/24',  // TEST-NET-2
      '203.0.113.0/24',   // TEST-NET-3
      '224.0.0.0/4',      // multicast
      '240.0.0.0/4',      // reserved
    ]
    return blocked.some(cidr => v4InCidr(v4, cidr))
  }

  // IPv6 (практические эвристики по префиксам/включениям)
  if (raw === '::' || raw === '::1') return true                     // unspecified / loopback
  if (raw.startsWith('fc') || raw.startsWith('fd')) return true      // fc00::/7 ULA
  if (/^fe[89ab]/.test(raw)) return true                             // fe80::/10 link-local
  if (raw.startsWith('ff')) return true                              // ff00::/8 multicast
  if (raw.startsWith('2001:db8')) return true                        // documentation
  if (raw.startsWith('64:ff9b')) return true                         // NAT64 well-known
  // IPv4-mapped (::ffff:a.b.c.d) — проверяем вложенный IPv4
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mapped) return isPrivateIp(mapped[1])
  return false
}

/**
 * Синхронная валидация внешнего URL по литералам (edge-совместимая):
 * протокол + расширенный блоклист IPv4/IPv6/локальных имён + десятичная запись.
 * Для Node-маршрутов используйте validateExternalUrlWithDns из '@/lib/url-guard' —
 * она дополнительно резолвит DNS и проверяет полученные адреса.
 * (DNS-версия вынесена в отдельный модуль: dns/promises нельзя класть
 * в edge-чанки, сборка падает.)
 */
export function validateExternalUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (!['https:', 'http:'].includes(url.protocol)) return null

  let host = url.hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!host) return null

  // Локальные имена
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) return null

  // Десятичная запись IP (http://2130706433 -> 127.0.0.1)
  if (/^\d{7,10}$/.test(host)) {
    const n = Number(host)
    if (n <= 4294967295) {
      const asV4 = `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`
      if (isPrivateIp(asV4)) return null
    }
  }

  // Литералы IPv4/IPv6
  if (isPrivateIp(host)) return null

  return url.toString()
}

// ─── F-15: серверная проверка возрастного гейта ───────────────────────────
/** Cookie anime_age_confirmed=1 ставит POST /api/age-confirm (TTL 24ч). */
export function isAgeVerifiedFromRequest(request: Request): boolean {
  const cookie = request.headers.get('cookie') || ''
  return /(?:^|;\s*)anime_age_confirmed=1(?:;|$)/.test(cookie)
}

/** Validate search query */
export function sanitizeSearchQuery(input: unknown): string {
  if (typeof input !== 'string') return ''
  return input
    .replace(/[<>{}\[\]\(\)\*\^$]/g, '') // strip special chars
    .trim()
    .slice(0, 200)
}
