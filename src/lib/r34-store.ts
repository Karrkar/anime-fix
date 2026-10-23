/**
 * Хранилище rule34-постов (вкладка «Арты» 18+) — ВСЕ посты 14 художников.
 *
 * КОНТЕКСТ (октябрь 2026, задача «все арты с указанных источников»):
 * Прежде вкладка была живым прокси к rule34.xxx: каждый просмотр тянул
 * страницу через Jina Reader (42 поста на художника). Это ломалось от
 * рейт-лимитов Jina (ключ 402, аноним 403 с датацентровых IP) и в принципе
 * не давало «всех артов»: суммарно у 14 художников ~143 000 постов,
 * из них пользователь видел максимум 588 за раз.
 *
 * РЕШЕНИЕ — полный бэкфилл в БД + отдача из БД:
 *   1) Полный обход всех страниц списка каждого художника (скрипт
 *      scripts/r34_full_scrape.mjs на машине оператора + dapi-синк
 *      через ключ пользователя) складывает посты в sync_status
 *      чанками (r34_store_<tag>_c<N> — 10 страниц = 420 постов на ряд).
 *   2) /api/rule34 читает чанк из БД (мс), а не ждёт Jina (секунды/502).
 *   3) /api/r34-sync (крон) добирает новые посты; счётчики художников
 *      обновляются из публичного autocomplete rule34.
 *
 * Точная структура rows (sync_status, details jsonb):
 *   r34_store_<tag>_c<N>  → { tag, chunk, posts: ParsedPost[] }  (N с нуля,
 *                           chunk N покрывает страницы 10N..10N+9)
 *   r34_meta_<tag>        → { tag, total_posts, total_pages, stored_posts,
 *                             stored_pages, complete, updated_at }
 *   r34_meta_all          → { artists: Record<tag, {total_posts, stored_posts,
 *                             complete}>, total_posts, updated_at }
 */

import { getDb } from './db';
import type { ParsedPost } from './client-types';

/** Художники «ссылок, что указал владелец» — единый список с роутом. */
export const R34_ARTISTS = [
  'arzagod', 'balecxi', 'kaistar', 'kinkimya', 'rognezart', 'hypet',
  'backdoorsenpai', 'milfhunter228', 'futarush', 'kiraamane', 'aliusnext',
  'meitabuu', 'maldo', 'duxvector',
] as const;

export type R34ArtistTag = (typeof R34_ARTISTS)[number];

export const PER_PAGE = 42;                 // как на rule34.xxx
export const PAGES_PER_CHUNK = 10;          // 420 постов в ряду БД
export const POSTS_PER_CHUNK = PER_PAGE * PAGES_PER_CHUNK;

export interface R34Meta {
  tag: string;
  total_posts: number;   // точный счётчик (autocomplete rule34)
  total_pages: number;
  stored_posts: number;
  stored_pages: number;
  complete: boolean;
  updated_at: string;
}

/* ── Кэш чтения (5 мин): чанки читаются при каждом просмотре страниц ── */

interface ChunkRow { posts: ParsedPost[]; fetchedAt: number }
const chunkCache = new Map<string, ChunkRow>(); // key: tag:c<N>
const CHUNK_TTL = 5 * 60_000;

const metaCache = new Map<string, R34Meta | null>(); // key: tag
const metaCacheAll = new Map<string, R34Meta[]>();
const META_TTL = 5 * 60_000;
const metaCacheTs = new Map<string, number>();

function chunkRowKey(tag: string, chunk: number) { return `r34_store_${tag}_c${chunk}`; }

async function readChunkRow(tag: string, chunk: number): Promise<ParsedPost[] | null> {
  const key = `${tag}:c${chunk}`;
  const hit = chunkCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CHUNK_TTL) return hit.posts;
  try {
    const db = getDb();
    const { data } = await db
      .from('sync_status')
      .select('details')
      .eq('source', chunkRowKey(tag, chunk))
      .maybeSingle();
    const posts = ((data?.details as { posts?: ParsedPost[] } | null)?.posts) || null;
    chunkCache.set(key, { posts: posts || [], fetchedAt: Date.now() });
    return posts;
  } catch {
    return hit ? hit.posts : null; // БД недоступна — отдаём протухший чанк
  }
}

/** Посты одной страницы художника (0-based) или null, если чанк ещё не залит. */
export async function getStoredPage(tag: string, page: number): Promise<ParsedPost[] | null> {
  if (page < 0) return null;
  const chunk = Math.floor(page / PAGES_PER_CHUNK);
  const posts = await readChunkRow(tag, chunk);
  if (posts === null) return null;
  const from = (page % PAGES_PER_CHUNK) * PER_PAGE;
  const slice = posts.slice(from, from + PER_PAGE);
  return slice.length > 0 ? slice : null;
}

/** Мета художника (null — ещё не синкали ни разу). */
export async function getMeta(tag: string): Promise<R34Meta | null> {
  const cached = metaCache.get(tag);
  const ts = metaCacheTs.get(tag) || 0;
  if (cached !== undefined && Date.now() - ts < META_TTL) return cached;
  try {
    const db = getDb();
    const { data } = await db
      .from('sync_status')
      .select('details')
      .eq('source', `r34_meta_${tag}`)
      .maybeSingle();
    const d = data?.details as Partial<R34Meta> | null | undefined;
    const meta: R34Meta | null = d && typeof d.total_posts === 'number'
      ? {
          tag: d.tag || tag,
          total_posts: d.total_posts,
          total_pages: d.total_pages || Math.ceil(d.total_posts / PER_PAGE),
          stored_posts: d.stored_posts || 0,
          stored_pages: d.stored_pages || 0,
          complete: d.complete === true,
          updated_at: d.updated_at || '',
        }
      : null;
    metaCache.set(tag, meta);
    metaCacheTs.set(tag, Date.now());
    return meta;
  } catch {
    return cached !== undefined ? cached : null;
  }
}

/** Мета всех художников (для агрегата «Все художники»). */
export async function getAllMetas(): Promise<R34Meta[]> {
  const cachedTs = metaCacheTs.get('__all__') || 0;
  if (Date.now() - cachedTs < META_TTL) {
    const all: R34Meta[] = [];
    for (const t of R34_ARTISTS) {
      const m = metaCache.get(t);
      if (m) all.push(m);
    }
    if (all.length) return all;
  }
  const metas = await Promise.all(R34_ARTISTS.map(t => getMeta(t)));
  const list = metas.filter((m): m is R34Meta => !!m);
  metaCacheTs.set('__all__', Date.now());
  return list;
}

export interface AggregatePage {
  posts: ParsedPost[];
  totalPages: number;   // max по художникам (как раньше в живом агрегате)
  totalPosts: number;   // сумма счётчиков художников
}

/**
 * Страница N агрегата «Все художники» — та же семантика, что была в живом
 * парсере: страница N каждого художника, объединение, сортировка по score.
 */
export async function getStoredAggregatePage(page: number): Promise<AggregatePage> {
  const metas = await Promise.all(R34_ARTISTS.map(t => getMeta(t)));
  const present = metas.filter((m): m is R34Meta => !!m && m.stored_pages > 0);
  if (present.length === 0) return { posts: [], totalPages: 0, totalPosts: 0 };

  const chunks = new Map<string, ParsedPost[] | null>();
  await Promise.all(R34_ARTISTS.map(async t => {
    const chunk = Math.floor(page / PAGES_PER_CHUNK);
    chunks.set(t, await readChunkRow(t, chunk));
  }));

  const all: ParsedPost[] = [];
  const seen = new Set<string>();
  for (const t of R34_ARTISTS) {
    const posts = chunks.get(t);
    if (!posts) continue;
    const from = (page % PAGES_PER_CHUNK) * PER_PAGE;
    for (const p of posts.slice(from, from + PER_PAGE)) {
      if (!seen.has(p.id)) { seen.add(p.id); all.push(p); }
    }
  }
  all.sort((a, b) => b.score - a.score);
  const totalPages = Math.max(...present.map(m => m.total_pages), 1);
  const totalPosts = present.reduce((a, m) => a + m.total_posts, 0);
  return { posts: all, totalPages, totalPosts };
}

/* ── Запись: используется /api/r34-ingest, /api/r34-sync и заливщиком ── */

export interface UpsertResult {
  tag: string;
  stored_posts: number;
  stored_pages: number;
  chunks: number;
  total_posts: number;
  complete: boolean;
}

/** Все посты художника из чанков (для merge при инжесте). */
async function readAllStoredPosts(tag: string): Promise<ParsedPost[]> {
  const out: ParsedPost[] = [];
  for (let c = 0; c < 500; c++) {
    const posts = await readChunkRow(tag, c);
    if (!posts || posts.length === 0) break;
    out.push(...posts);
  }
  return out;
}

/**
 * MERGE-заливка постов художника.
 *
 * Вход НЕ обязан быть полным списком: новая партия объединяется с уже
 * хранимыми (дедуп по id, вход свежее), итог сортируется по id по убыванию
 * (порядок списков rule34) и раскладывается по чанкам заново. Инвариант
 * «новые посты в голове» сохраняется для любого порядка батчей.
 *
 * totalPosts — точный счётчик из autocomplete (если 0 — берём длину списка).
 */
export async function upsertArtistPosts(
  tag: string,
  posts: ParsedPost[],
  totalPosts?: number,
): Promise<UpsertResult> {
  const db = getDb();

  // валидные входные посты
  const incoming: ParsedPost[] = [];
  const seenIncoming = new Set<string>();
  for (const p of posts) {
    if (p && p.id && !seenIncoming.has(p.id) && typeof p.thumbnailUrl === 'string') {
      seenIncoming.add(p.id);
      incoming.push(p);
    }
  }
  if (incoming.length === 0) throw new Error('no valid posts in batch');

  // существующие + вход: вход перекрывает (свежее)
  const existing = await readAllStoredPosts(tag);
  const byId = new Map<string, ParsedPost>();
  for (const p of existing) byId.set(p.id, p);
  for (const p of incoming) byId.set(p.id, p);
  const unique = [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id));

  const chunkCount = Math.max(1, Math.ceil(unique.length / POSTS_PER_CHUNK));
  for (let c = 0; c < chunkCount; c++) {
    const chunkPosts = unique.slice(c * POSTS_PER_CHUNK, (c + 1) * POSTS_PER_CHUNK);
    const row = {
      source: chunkRowKey(tag, c),
      last_run_at: new Date().toISOString(),
      last_status: 'ok' as const,
      new_items: chunkPosts.length,
      updated_items: 0,
      details: { tag, chunk: c, posts: chunkPosts, saved_at: new Date().toISOString() },
      error: null,
    };
    const { error } = await db.from('sync_status').upsert(row, { onConflict: 'source' });
    if (error) throw new Error(`chunk upsert: ${error.message}`);
    chunkCache.delete(`${tag}:c${c}`);
  }

  // хвост лишних чанков (если список стал короче) — удалить
  const oldChunkCount = Math.max(1, Math.ceil(existing.length / POSTS_PER_CHUNK));
  for (let c = chunkCount; c < oldChunkCount; c++) {
    try {
      await db.from('sync_status').delete().eq('source', chunkRowKey(tag, c));
    } catch { /* не критично */ }
    chunkCache.delete(`${tag}:c${c}`);
  }

  const total = totalPosts && totalPosts > 0 ? totalPosts : Math.max(unique.length, existing.length);
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const storedPages = Math.ceil(unique.length / PER_PAGE);
  const meta: R34Meta = {
    tag,
    total_posts: total,
    total_pages: totalPages,
    stored_posts: unique.length,
    stored_pages: storedPages,
    complete: unique.length >= total,
    updated_at: new Date().toISOString(),
  };
  const { error: metaErr } = await db.from('sync_status').upsert({
    source: `r34_meta_${tag}`,
    last_run_at: meta.updated_at,
    last_status: 'ok',
    new_items: unique.length,
    updated_items: 0,
    details: meta as unknown as Record<string, unknown>,
    error: null,
  }, { onConflict: 'source' });
  if (metaErr) throw new Error(`meta upsert: ${metaErr.message}`);

  metaCache.set(tag, meta);
  metaCacheTs.set(tag, Date.now());
  metaCacheTs.delete('__all__');

  return {
    tag,
    stored_posts: unique.length,
    stored_pages: storedPages,
    chunks: chunkCount,
    total_posts: total,
    complete: meta.complete,
  };
}

/** Обновить только счётчики художника (autocomplete) — без заливки постов. */
export async function updateMetaCounts(tag: string, totalPosts: number): Promise<R34Meta | null> {
  const db = getDb();
  const existing = await getMeta(tag);
  const meta: R34Meta = existing
    ? { ...existing, total_posts: totalPosts, total_pages: Math.max(1, Math.ceil(totalPosts / PER_PAGE)), complete: existing.stored_posts >= totalPosts, updated_at: new Date().toISOString() }
    : { tag, total_posts: totalPosts, total_pages: Math.max(1, Math.ceil(totalPosts / PER_PAGE)), stored_posts: 0, stored_pages: 0, complete: false, updated_at: new Date().toISOString() };
  const { error } = await db.from('sync_status').upsert({
    source: `r34_meta_${tag}`,
    last_run_at: meta.updated_at,
    last_status: 'ok',
    new_items: 0,
    updated_items: 0,
    details: meta as unknown as Record<string, unknown>,
    error: null,
  }, { onConflict: 'source' });
  if (error) return existing;
  metaCache.set(tag, meta);
  metaCacheTs.set(tag, Date.now());
  metaCacheTs.delete('__all__');
  return meta;
}

/** Сброс кэшей чтения (после инжеста из другого инстанса). */
export function resetStoreCaches(): void {
  chunkCache.clear();
  metaCache.clear();
  metaCacheTs.clear();
}

/* ── ИНКРЕМЕНТАЛЬНЫЕ СЛИЯНИЯ (октябрь 2026, ежедневный крон arts-sync) ──
 *
 * upsertArtistPosts перечитывает и перезаписывает ВСЕ чанки тега — для
 * balecxi (33k постов = 79 чанков) это десятки секунд. Для ежедневного
 * крона:
 *
 *   FRESH (новые посты дня) — сам upsertArtistPosts, но по РОТАЦИИ
 *   (2-3 тега за звено): все 14 обновляются за несколько звеньев цепочки.
 *
 *   appendTailPosts — бэкфилл истории (хвост): читает только последний
 *   чанк и дописывает новые в конец, O(1) к размеру тега. Это главный
 *   путь «всех ~143k постов»: сотни страниц хвоста без перелива головы. */

async function writeChunkRow(tag: string, chunk: number, posts: ParsedPost[]): Promise<void> {
  const db = getDb();
  const { error } = await db.from('sync_status').upsert({
    source: chunkRowKey(tag, chunk),
    last_run_at: new Date().toISOString(),
    last_status: 'ok',
    new_items: posts.length,
    updated_items: 0,
    details: { tag, chunk, posts, saved_at: new Date().toISOString() },
    error: null,
  }, { onConflict: 'source' });
  if (error) throw new Error(`chunk upsert: ${error.message}`);
  chunkCache.set(`${tag}:c${chunk}`, { posts, fetchedAt: Date.now() });
}

async function saveMetaRow(meta: R34Meta): Promise<void> {
  const db = getDb();
  meta.updated_at = new Date().toISOString();
  const { error } = await db.from('sync_status').upsert({
    source: `r34_meta_${meta.tag}`,
    last_run_at: meta.updated_at,
    last_status: 'ok',
    new_items: meta.stored_posts,
    updated_items: 0,
    details: meta as unknown as Record<string, unknown>,
    error: null,
  }, { onConflict: 'source' });
  if (error) throw new Error(`meta upsert: ${error.message}`);
  metaCache.set(meta.tag, meta);
  metaCacheTs.set(meta.tag, Date.now());
  metaCacheTs.delete('__all__');
}

/** Слить два списка постов (дедуп по id, вход b приоритетнее), id desc. */
function dedupeSort(a: ParsedPost[], b: ParsedPost[]): ParsedPost[] {
  const byId = new Map<string, ParsedPost>();
  for (const p of a) if (p && p.id) byId.set(p.id, p);
  for (const p of b) if (p && p.id) byId.set(p.id, p); // b перекрывает
  return [...byId.values()].sort((x, y) => Number(y.id) - Number(x.id));
}

export interface IncrementalResult {
  tag: string;
  added: number;         // сколько НОВЫХ постов действительно вошло
  stored_posts: number;
  stored_pages: number;
  complete: boolean;
}

/** ХВОСТОВОЕ слияние: бэкфилл истории (посты старше хранимых). Читает
 *  только последний чанк, дописывает новые в конец. O(1) к размеру тега. */
export async function appendTailPosts(
  tag: string,
  batch: ParsedPost[],
  totalPosts?: number,
): Promise<IncrementalResult> {
  const meta = await getMeta(tag);
  const before = meta?.stored_posts || 0;

  // Последний существующий чанк: по мете, с фолбэком на перебор (защита
  // от расхождения меты при сбоях)
  let lastChunk = meta && before > 0 ? Math.max(0, Math.ceil(before / POSTS_PER_CHUNK) - 1) : -1;
  if (lastChunk >= 0) {
    const probe = await readChunkRow(tag, lastChunk);
    if (!probe || probe.length === 0) {
      for (let c = lastChunk; c >= 0; c--) {
        const p = await readChunkRow(tag, c);
        if (p && p.length > 0) { lastChunk = c; break; }
        if (c === 0) lastChunk = -1;
      }
    }
  }

  let merged: ParsedPost[];
  if (lastChunk >= 0) {
    const tail = (await readChunkRow(tag, lastChunk)) || [];
    merged = dedupeSort(tail, batch);
  } else {
    merged = dedupeSort([], batch);
    lastChunk = 0;
  }

  // Раскладка: lastChunk (перезапись) + новые чанки до конца
  const chunksToWrite: Array<[number, ParsedPost[]]> = [];
  for (let i = 0; i * POSTS_PER_CHUNK < merged.length; i++) {
    chunksToWrite.push([lastChunk + i, merged.slice(i * POSTS_PER_CHUNK, (i + 1) * POSTS_PER_CHUNK)]);
  }
  for (const [c, posts] of chunksToWrite) await writeChunkRow(tag, c, posts);

  const total = totalPosts && totalPosts > 0 ? totalPosts : (meta?.total_posts || merged.length);
  const stored = Math.max(before, lastChunk * POSTS_PER_CHUNK + merged.length);
  const newMeta: R34Meta = {
    tag,
    total_posts: total,
    total_pages: Math.max(1, Math.ceil(total / PER_PAGE)),
    stored_posts: stored,
    stored_pages: Math.ceil(stored / PER_PAGE),
    complete: stored >= total,
    updated_at: '',
  };
  await saveMetaRow(newMeta);
  return {
    tag,
    added: Math.max(0, stored - before),
    stored_posts: stored,
    stored_pages: newMeta.stored_pages,
    complete: newMeta.complete,
  };
}

/** Публичное чтение чанка (для arts-sync: проверка «все ли посты батча уже
 *  в c0» без полной переливки). null — чанк ещё не залит. */
export async function readChunkPublic(tag: string, chunk: number): Promise<ParsedPost[] | null> {
  return readChunkRow(tag, chunk);
}

/* ── КЭШ ДЕТАЛОК ПОСТА (лайтбокс, октябрь 2026) ──────────────────────
 * Файл поста immutable (хеш в URL) — один раз пробингнули/получили полный
 * URL, навсегда закэшировали в r34_post:<id>. Повторное открытие арта —
 * один дешёвый roundtrip к sync_status вместо перебора расширений CDN.
 * Формат details совместим со строками от 03.10 (details.data). */

export interface R34PostDetail {
  id: string;
  imageUrl: string;
  isVideo: boolean;
  postUrl: string;
  tags: string[];
  score: number;
}

export function postKey(postId: string | number): string {
  return `r34_post:${postId}`;
}

export async function loadPostDetail(postId: string): Promise<R34PostDetail | null> {
  try {
    const db = getDb();
    const { data } = await db.from('sync_status').select('details').eq('source', postKey(postId)).maybeSingle();
    const d = data?.details as { data?: R34PostDetail } | null;
    if (!d?.data || !d.data.imageUrl) return null;
    return d.data;
  } catch {
    return null;
  }
}

export async function savePostDetail(detail: R34PostDetail): Promise<void> {
  try {
    const db = getDb();
    const { error } = await db.from('sync_status').upsert({
      source: postKey(detail.id),
      last_run_at: new Date().toISOString(),
      last_status: 'ok',
      new_items: 0,
      updated_items: 0,
      details: { data: detail, savedAt: new Date().toISOString() } as unknown as Record<string, unknown>,
      error: null,
    }, { onConflict: 'source' });
    if (error) console.error(`savePostDetail(${detail.id}):`, error.message);
  } catch (e) {
    console.error(`savePostDetail(${detail.id}) failed:`, e);
  }
}
