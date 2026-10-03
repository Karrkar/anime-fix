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
 */
/** Заголовки Jina Reader + Authorization, если задан JINA_API_KEY. */
export function jinaHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'text/html',
    'X-Return-Format': 'html',
    'X-No-Cache': 'true',
  };
  const key = process.env.JINA_API_KEY?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return extra ? { ...headers, ...extra } : headers;
}
