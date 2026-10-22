/**
 * Механизм полного бэкфилла источников (октябрь 2026, задача «весь контент
 * без ограничений»).
 *
 * ПРОБЛЕМА. Кроны Vercel на Hobby-плане ограничены 60 сек на запуск, а
 * «мелкий» парсинг захватывал только верх источников: vost.pw — 2 страницы
 * из 361, hentaibaza — 1 из 10, feelex — 1-ю страницу каждой из 12
 * категорий (при 7 на категорию), xxx-igra — только главную при 86 страниц
 * (~4% покрытия!). База годами накапливала содержимое медленнее, чем
 * источники публикуют, и «хвосты» каталогов не попадали в БД вообще.
 *
 * РЕШЕНИЕ — два механизма, работающих вместе:
 *
 *   1) РЕЗЮМИРУЕМЫЙ КУРСОР. Прогресс обхода каждого источника хранится в
 *      sync_status (details.next_page) и переживает любые сбои: если цепочка
 *      умрёт на середине — следующий дневной крон автоматически продолжит
 *      с той же страницы, а не начнёт сначала.
 *
 *   2) САМОЦЕПОЧКА (chain). Отработав свой 60-секундный сегмент, функция
 *      ПОСЛЕ ОТДАЧИ ответа дёргает САМА СЕБЯ следующим отрезком (?from_page=N).
 *      Вызов уходит через публичный домен (custom domain не закрыт SSO
 *      Vercel-аутентификацией, в отличие от *.vercel.app) с Bearer CRON_SECRET —
 *      это документированный путь авторизации кронов (см. cron-auth.ts).
 *      Fire-and-forget: достаточно, чтобы запрос ушел в роутер платформы —
 *      новое инвоук-выполнение стартует независимо от того, что случится
 *      со старым контейнером. Каждое звено получает свежие 60 секунд,
 *      а суммарно за одну сессию проходится десятки страниц.
 *
 * БЮДЖЕТ ЧЕЙНА ограничен (chain_hops), чтобы одна сессия не съела весь
 * дневной лимит функции: недоведённый до конца обход продолжится со
 * следующего дня ровно с места остановки.
 *
 * СТОП-УСЛОВИЕ обхода: 2 подряд пустые страницы (за последней страницей
 * источники отдают HTTP 200 с пустой выдачей — проверено зонтированием
 * vost.pw/page/362 и hentaibaza/?page=11) + страховочный потолок страниц.
 */

import { getDb } from './db';

/** Публичный origin для самоцепочки.
 *  Кастомный домен обязателен: SSO Vercel Authentication (включена в
 *  проекте) закрывает *.vercel.app от неаутентифицированных вызовов,
 *  а custom domains явно исключены из защиты. Env-переопределение —
 *  на случай смены домена проекта без редеплоя кода. */
export const CHAIN_ORIGIN = (process.env.PUBLIC_SITE_URL || 'https://animeplatforma-new.online').replace(/\/$/, '');

export interface BackfillState {
  next_page: number;
  done: boolean;
  consecutive_empty: number;
  inserted: number;
  updated: number;
  pages_done: number;
  finished_at?: string;
  note?: string;
}

export function emptyBackfillState(nextPage = 2): BackfillState {
  // nextPage=2: первая страница уже покрывается ежедневным мелким проходом
  return { next_page: nextPage, done: false, consecutive_empty: 0, inserted: 0, updated: 0, pages_done: 0 };
}

/** Загрузка прогресса обхода из sync_status (source = например 'vost_backfill'). */
export async function loadBackfillState(source: string): Promise<BackfillState> {
  try {
    const db = getDb();
    const { data } = await db
      .from('sync_status')
      .select('details')
      .eq('source', source)
      .maybeSingle();
    const d = (data?.details as Partial<BackfillState> | null) || {};
    const st: BackfillState = {
      next_page: Number(d.next_page) >= 1 ? Math.floor(Number(d.next_page)) : 2,
      done: d.done === true,
      consecutive_empty: Number(d.consecutive_empty) || 0,
      inserted: Number(d.inserted) || 0,
      updated: Number(d.updated) || 0,
      pages_done: Number(d.pages_done) || 0,
      finished_at: d.finished_at,
      note: d.note,
    };
    return st;
  } catch {
    return emptyBackfillState();
  }
}

/** Сохранение прогресса (каждая страница — чтобы обрыв терял максимум одну). */
export async function saveBackfillState(
  source: string,
  st: BackfillState,
  runStatus: 'ok' | 'error' = 'ok',
): Promise<void> {
  try {
    const db = getDb();
    const { error } = await db.from('sync_status').upsert({
      source,
      last_run_at: new Date().toISOString(),
      last_status: runStatus,
      new_items: st.inserted,
      updated_items: st.updated,
      details: st as unknown as Record<string, unknown>,
      error: null,
    }, { onConflict: 'source' });
    if (error) console.error(`saveBackfillState(${source}):`, error.message);
  } catch (e) {
    console.error(`saveBackfillState(${source}) failed:`, e);
  }
}

/** URL следующего звена цепочки. */
export function buildChainUrl(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '' && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${CHAIN_ORIGIN}${path}${qs ? `?${qs}` : ''}`;
}

/**
 * Пнуть следующее звено. Fire-and-forget: ответ НЕ ждём телом — достаточно
 * факта маршрутизации запроса платформой (миллисекунды), дальше новое
 * инвоук-выполнение живёт своей жизнью. Если контейнер заморожен раньше,
 * чем придут заголовки ответа — не страшно: запрос уже в системе.
 * Прерывать/таймаутить нельзя — обрыв на нашей стороне не должен
 * касаться выполняющегося звена.
 */
export function fireChainNext(url: string): void {
  if (!url) return;
  const headers: Record<string, string> = { accept: 'application/json' };
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) headers.authorization = `Bearer ${secret}`;
  void fetch(url, { headers, redirect: 'follow' })
    .then(r => {
      // Заголовки пришли — звено ОТРАБОТАЛО и вернуло ответ; закрываем за собой
      try { r.body?.cancel(); } catch { /* уже закрыт */ }
    })
    .catch(() => { /* цепочка оборвалась — курсор в sync_status подхватит следующий крон */ });
}
