/**
 * 2026-10-03: r.jina.ai начал блокировать анонимные запросы с датацентровых IP
 * (401 AuthenticationRequiredError, «bad IP reputation»). С Vercel это давало
 * ~40-50% отказов: авторы в разделе «Арты» «пропадали» (фейковые нули),
 * агрегат «все художники» возвращал 4-6 авторов вместо 14, и фрагмент
 * кэшировался как полный результат.
 *
 * Лечение — проверяемая цепочка загрузки:
 *   Jina (с ретраями) → прямой запрос (вдруг IP не под CAPTCHA) →
 *   честная ошибка вместо фейкового «пусто».
 *
 * Опционально: env JINA_API_KEY — бесплатный ключ с jina.ai снимает
 * рейт-лимит/блок целиком (ставится в Vercel → Settings → Environment
 * Variables). Без ключа цепочка тоже работает, просто с ретраями.
 *
 * 2026-10-03 (ключ получен): + X-Target-Selector — выборка только нужных
 * элементов вместо всей страницы. Полный HTML списка ~412KB = 171K токенов
 * за запрос; с селектором «.content» — 98KB = 25K токенов (экономия 6.9x,
 * бюджет 10M бесплатных токенов растёт с ~58 до ~400 страниц). На пустых
 * тегах «chickens» остаётся внутри .content и честно детектится валидатором.
 */
import { JINA_READER } from '@/lib/sources';
import { jinaHeaders } from '@/lib/jina';

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function jinaFetch(targetUrl: string, timeoutMs: number, targetSelector?: string): Promise<string> {
  const headers = jinaHeaders(
    targetSelector ? { 'X-Target-Selector': targetSelector } : undefined,
  );
  const r = await fetch(JINA_READER + encodeURIComponent(targetUrl), {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`jina http ${r.status}`);
  return r.text();
}

/** Прямой запрос — на случай, если IP сервера не под CAPTCHA источника. */
async function directFetch(targetUrl: string, timeoutMs: number): Promise<string> {
  const r = await fetch(targetUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`direct http ${r.status}`);
  return r.text();
}

export interface FetchSourceOpts {
  /** Проверка пригодности ответа (отсекает CAPTCHA-страницы и JSON ошибок Jina). */
  validate: (html: string) => boolean;
  /** Попыток Jina, 1..3 (по умолчанию 2). */
  jinaAttempts?: number;
  /** Прямой запрос последней попыткой (по умолчанию true). */
  tryDirect?: boolean;
  /** Таймаут одного запроса, мс (по умолчанию 12000). */
  timeoutMs?: number;
  /** CSS-селектор(ы) X-Target-Selector — выборка нужных элементов вместо
   * всей страницы (экономия токенов Jina до 7x). Селектор обязан покрывать
   * всё, что проверяет validate и что парсит вызывающий код. */
  targetSelector?: string;
}

/**
 * Загружает страницу источника. Бросает Error только если ВСЕ попытки
 * отказали или вернули нечто непригодное для парсинга — вызывающий код
 * может честно ответить 502 / отдать stale-кэш, а не фейковое «пусто».
 */
export async function fetchSourcePage(targetUrl: string, opts: FetchSourceOpts): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const jinaAttempts = Math.max(1, Math.min(opts.jinaAttempts ?? 2, 3));
  const tryDirect = opts.tryDirect ?? true;
  let lastError = 'no attempt';

  for (let i = 0; i < jinaAttempts; i++) {
    try {
      const html = await jinaFetch(targetUrl, timeoutMs, opts.targetSelector);
      if (opts.validate(html)) return html;
      lastError = 'unparseable jina response';
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    // 2026-10-03: блок Jina коррелирует во времени (окно по IP) — короткие
    // паузы бесполезны; разводим попытки подальше друг от друга
    if (i < jinaAttempts - 1) await sleep(1500 + i * 1000);
  }

  if (tryDirect) {
    try {
      const html = await directFetch(targetUrl, 9000);
      if (opts.validate(html)) return html;
      lastError = 'unparseable direct response';
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  throw new Error(`source unavailable: ${lastError}`);
}

/**
 * Валидатор страниц-списков rule34: есть посты ИЛИ маркер честной пустоты
 * («Nobody here but us chickens!»). CAPTCHA-страница и JSON-ошибка Jina
 * не проходят проверку и считаются отказом, а не «тегом без контента».
 */
export function isListPageUsable(html: string): boolean {
  return html.includes('class="thumb"') || html.includes('chickens');
}

/** Селектор страниц-списков: .content содержит .image-list (thumbs),
 * #paginator (total) и «chickens» на пустых тегах — всё, что нужно
 * валидатору и парсеру. 25K токенов вместо 171K за запрос. */
export const R34_LIST_SELECTOR = '.content';

/** Селектор страниц постов: #post-view (tag-sidebar + опции + image/video),
 * og:image из head, video/source для видео-постов. 50K токенов вместо 142K. */
export const R34_POST_SELECTOR = "#post-view, meta[property='og:image'], video, source";

/** Валидатор страниц постов: характерные блоки карточки поста. */
export function isPostPageUsable(html: string): boolean {
  return (
    html.includes('tag-sidebar') ||
    html.includes('id="image"') ||
    html.includes('og:image') ||
    html.includes('Original image') ||
    /type="video/.test(html)
  );
}
