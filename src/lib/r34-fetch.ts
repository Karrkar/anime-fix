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
 */
import { JINA_READER } from '@/lib/sources';

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function jinaFetch(targetUrl: string, timeoutMs: number): Promise<string> {
  const headers: Record<string, string> = {
    Accept: 'text/html',
    'X-Return-Format': 'html',
    'X-No-Cache': 'true',
  };
  const key = process.env.JINA_API_KEY?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
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
      const html = await jinaFetch(targetUrl, timeoutMs);
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
