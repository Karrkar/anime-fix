/**
 * 2026-10-03: единая точка для заголовков Jina Reader.
 *
 * r.jina.ai блокирует анонимные запросы с датацентровых IP (401
 * AuthenticationRequiredError «bad IP reputation») — с Vercel это давало
 * ~40-50% отказов по всем синк-роутам. Бесплатный ключ jina.ai (10M токенов,
 * env JINA_API_KEY, ставится в Vercel → Settings → Environment Variables)
 * снимает блок целиком и поднимает рейт-лимит Reader API с 20 до 500 RPM.
 *
 * Ключ один на все продукты Jina; лимиты трекаются по ключу, а не по IP.
 *
 * 2026-10-04 fix «арты вообще не загружаются»: ключ с нулевым балансом
 * отвечает 402 InsufficientBalanceError на КАЖДЫЙ запрос — и, в отличие от
 * анонимного режима, блокирует нас на 100% (раньше анонимный Jina с Vercel
 * работал хотя бы частично). Лечение — авто-деградация: как только Jina
 * отвергает ключ (401/402), jinaHeaders() перестаёт его прикладывать и
 * модуль 30 минут работает анонимно; если баланс пополнят — ключ
 * автоматически возвращается в строй после кулдауна.
 */

/** Кулдаун «мёртвого» ключа: 30 минут анонимного режима после 401/402. */
const KEY_REJECT_COOLDOWN_MS = 30 * 60_000;
let keyDeadUntil = 0;

/** Заголовки Jina Reader + Authorization, если задан живой JINA_API_KEY. */
export function jinaHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'text/html',
    'X-Return-Format': 'html',
    'X-No-Cache': 'true',
  };
  const key = process.env.JINA_API_KEY?.trim();
  if (key && Date.now() >= keyDeadUntil) headers.Authorization = `Bearer ${key}`;
  return extra ? { ...headers, ...extra } : headers;
}

/**
 * Отметить, что Jina отверг запрос с ключом (401 аутентификация /
 * 402 баланс). Следующие 30 минут jinaHeaders() ходит анонимно —
 * частичный доступ лучше полного нуля. 429 НЕ отмечаем: это рейт-лимит
 * по ключу, у анонима он строже — ключ остаётся рабочим.
 */
export function markJinaKeyRejected(status: number): void {
  if (status === 401 || status === 402) {
    keyDeadUntil = Date.now() + KEY_REJECT_COOLDOWN_MS;
  }
}

/** Приложен ли сейчас Authorization (для логики немедленного ретрая). */
export function jinaKeyAttached(): boolean {
  const key = process.env.JINA_API_KEY?.trim();
  return !!key && Date.now() >= keyDeadUntil;
}
