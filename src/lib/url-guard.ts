/**
 * Node-only URL-гард с проверкой через DNS (F-14, батч 3).
 *
 * Отдельно от validate.ts, потому что `dns/promises` нельзя даже
 * динамически импортировать в Edge Runtime — бандлер кладёт модуль
 * в edge-чанк и сборка падает. этот модуль импортируют ТОЛЬКО Node-маршруты
 * (player-proxy). Edge-роуты используют validate.ts (литеральные проверки).
 */
import { isPrivateIp } from './validate'

/**
 * Полная валидация внешнего URL:
 *  1) протокол http/https;
 *  2) блоклист литералов IPv4/IPv6 и локальных имён + десятичная запись IP;
 *  3) DNS-резолв хоста и проверка КАЖДОГО полученного адреса
 *     (закрывает десятичные/шестнадцатеричные/восьмеричные варианты,
 *     которые getaddrinfo разворачивает, и частично DNS-rebinding);
 *  4) неразрешаемый хост -> null (fail-closed).
 */
export async function validateExternalUrlWithDns(input: unknown): Promise<string | null> {
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

  // DNS-резолв: проверяем ВСЕ адреса
  try {
    const dns = await import('dns/promises')
    const addrs = await dns.lookup(host, { all: true, verbatim: true })
    if (!addrs || addrs.length === 0) return null
    for (const a of addrs) {
      if (isPrivateIp(a.address)) return null
    }
  } catch {
    return null // не резолвится — не пускаем
  }

  return url.toString()
}
