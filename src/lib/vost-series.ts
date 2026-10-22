/**
 * Список серий vost.pw через публичный API animevost (фикс 26.09.2026).
 *
 * ЧТО СЛОМАЛОСЬ: v13.vost.pw перестал вкладывать список серий в HTML-страницы
 * тайтлов — блок «var data = {...};» теперь приходит ПУСТЫМ («var data = ;»),
 * DOM-список серий на сайте строится скриптом из другого источника. Наш
 * player-proxy разбирал именно этот JSON → для любого тайтла вне кэша
 * пользователь получал «Не удалось загрузить серии» (плеер «сломан»).
 *
 * ГДЕ СЕРИИ ТЕПЕРЬ: публичный API animevost.org (тот самый, чей /GetInfo/{id}
 * сайт vost.pw использует для popup-ов). Поле data[0].series — но НЕ JSON:
 * это Питонья строка-словарь с одинарными кавычками:
 *   "{'1 серия':'791642107','2 серия':'374816613',…}"
 * Значения — те же id, что подставляются в /frame5.php?play=<id> (проверено
 * живыми запросами: и новые id из API, и старые из кэша БД дают прямые mp4).
 *
 * API быстрый (~0.3с), без анти-бота, без всплесковых банов — им и заменяем
 * основной путь. HTML-разбор оставлен фолбэком на случай недоступности API.
 */
import { ANIMEVOST_API_BASE } from '@/lib/sources';

const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Из URL страницы тайтла достаёт числовой id: «/tip/tv/4020-slug.html» → '4020'. */
export function extractVostId(pageUrl: string): string | null {
  try {
    const m = new URL(pageUrl).pathname.match(/\/tv\/(\d{1,7})(?:-|$)/);
    return m ? m[1] : null;
  } catch {
    const m = String(pageUrl).match(/\/tv\/(\d{1,7})(?:-|$)/);
    return m ? m[1] : null;
  }
}

/** Разбор series-строки API: «{'1 серия':'791642107',…}» → [['1 серия','791642107'],…]. */
export function parseApiSeries(raw: unknown): [string, string][] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const entries: [string, string][] = [];
  const re = /'([^']+)'\s*:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const label = m[1].trim();
    const id = m[2].trim();
    if (label && id) entries.push([label, id]);
  }
  return entries.length ? entries : null;
}

export interface ApiSeriesResult {
  /** Список серий (label → id для frame5.php) или null, если их нет. */
  entries: [string, string][] | null;
  /** true — API ответил, тайтл существует, но серий ещё нет (анонс). */
  announced: boolean;
  /** Заголовок тайтла как в API (для диагностики анонсов). */
  title?: string;
}

/**
 * Настоящий ли это анонс: источник помечает такие тайтлы маркером «Анонс»
 * в title («…[Анонс] [1 серия - 10 октября]»). Пустой series без маркера —
 * вероятная деградация API, ей доверять нельзя.
 */
export function isAnnouncedTitle(title: string): boolean {
  return /анонс/i.test(title);
}

/**
 * Список серий тайтла из API animevost.
 *
 * ПУСТОЙ series ≠ всегда «анонс»: API под нагрузкой может вернуть пустое
 * поле и для тайтла с вышедшими сериями. Настоящие анонсы источник помечает
 * в title маркером «[Анонс]» (например: «…[Анонс] [1 серия - 10 октября]»).
 * Пустой series БЕЗ маркера трактуем как деградацию API → null (звавший
 * фолбэкнется на просроченный кэш), чтобы не затирать хорошие данные
 * и не показывать пользователю ложное «серии ещё не вышли».
 *
 * @returns null — API недоступен/тайтл не найден/пустой series без маркера (звать HTML-фолбэк);
 *          { entries: null, announced: true } — серий нет, показываем «анонс».
 */
export async function fetchSeriesFromApi(
  vostId: string,
  timeoutMs = 8_000,
): Promise<ApiSeriesResult | null> {
  try {
    const resp = await fetch(`${ANIMEVOST_API_BASE}/${vostId}`, {
      headers: { 'User-Agent': FETCH_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { data?: Array<{ series?: unknown; title?: unknown }> };
    const info = json?.data?.[0];
    if (!info || typeof info !== 'object') return null;
    const entries = parseApiSeries(info.series);
    if (entries) return { entries, announced: false };
    const title = typeof info.title === 'string' ? info.title : '';
    if (!isAnnouncedTitle(title)) return null; // пусто без маркера — не верим
    return { entries: null, announced: true, title: title.slice(0, 120) };
  } catch {
    return null;
  }
}
