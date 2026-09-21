/**
 * Хранилище «Креатива» в БД (Task 51) — глубина + зеркала медиа.
 *
 * Зачем: telesco.pe-ссылки временные и блокируются по регионам, а t.me может
 * вообще не отвечать. Поэтому каждый канал докапывается вглубь (до DEPTH_CAP
 * постов) и все медиа зеркалируются в постоянный Storage, после чего вкладка
 * читается из БД и НЕ зависит от Telegram.
 *
 * Хранилище: sync_status, по строке на канал:
 *   source = creative_depth_<ch>
 *   details = { posts: StoredCreativePost[], savedAt, complete, minMsgId, maxMsgId }
 *
 * Зеркала (легаси-конвенция системы): бакет `covers`, путь creative/<ch>-<msgId>-p<N>
 * и creative/<ch>-<msgId>-v для постера видео. Старые тайтлы каталога используют
 * те же постоянные URL — конвенцию не ломать.
 */
import sharp from 'sharp';
import { getDb } from '@/lib/db';
import { TG_CHANNELS, type TgRawPost } from '@/lib/telegram-arts';

// ─── Константы ─────────────────────────────────────────────────────────────

/** Максимум постов на канал в хранилище (глубина истории). */
export const DEPTH_CAP = 300;
/** Страница в режиме одного канала. */
export const PAGE_SIZE = 20;
/** Страница в режиме «все каналы» (6 × 20). */
export const MERGE_PAGE = 120;
/** Сколько фото одного поста зеркалим максимум (альбомы длиннее режем). */
export const MIRROR_MAX_PHOTOS = 9;
/** Тайтл канала по id (для отдачи метаданных клиенту). */
export function channelTitle(id: string): string {
  return TG_CHANNELS.find(c => c.id === id)?.title || id;
}

// ─── Типы ──────────────────────────────────────────────────────────────────

export interface StoredCreativePost {
  id: string;            // "<ch>/<msgId>" — глобальный дедуп-ключ
  channel: string;
  channelTitle: string;
  msgId: number;
  date: string;          // ISO; пустая строка если t.me не дал время
  caption: string;
  photos: string[];      // зеркала (если mirrored) либо исходные telesco URL
  videoPoster?: string;  // зеркальный постер видео
  postUrl: string;       // https://t.me/<ch>/<msgId>
  origPhotos?: string[]; // исходные URL (заполняется при зеркалировании)
  origPoster?: string;
  mirrored: boolean;     // все медиа поста в постоянном Storage
}

export interface ClientCreativePost {
  id: string;
  channel: string;
  channelTitle: string;
  msgId: number;
  date: string;
  caption: string;
  photos: string[];
  videoPoster?: string;
  postUrl: string;
}

export interface DepthRow {
  posts: StoredCreativePost[];
  complete: boolean;
  minMsgId: number;
  maxMsgId: number;
}

// ─── Нормализация / слияние ────────────────────────────────────────────────

/** URL в нашем Storage (постоянные зеркала)? */
export function isOwnStorageUrl(u: string): boolean {
  return u.includes('/storage/v1/object/public/covers/creative/');
}

/** TgRawPost -> StoredCreativePost (без зеркалирования; mirrored по URL). */
export function normalizePost(raw: TgRawPost, channel: string): StoredCreativePost {
  const photos = raw.photos || [];
  const mirrored =
    photos.length > 0 &&
    photos.every(isOwnStorageUrl) &&
    (!raw.videoPoster || isOwnStorageUrl(raw.videoPoster));
  return {
    id: `${channel}/${raw.msgId}`,
    channel,
    channelTitle: channelTitle(channel),
    msgId: raw.msgId,
    date: raw.date || '',
    caption: raw.caption || '',
    photos,
    videoPoster: raw.videoPoster,
    postUrl: `https://t.me/${channel}/${raw.msgId}`,
    mirrored,
  };
}

/** Stored -> клиентский формат (JSON без undefined-полей). */
export function toClientPost(p: StoredCreativePost | ClientCreativePost): ClientCreativePost {
  const out: ClientCreativePost = {
    id: p.id,
    channel: p.channel,
    channelTitle: p.channelTitle || channelTitle(p.channel),
    msgId: p.msgId,
    date: p.date,
    caption: p.caption || '',
    photos: p.photos || [],
    postUrl: p.postUrl,
  };
  if (p.videoPoster) out.videoPoster = p.videoPoster;
  return out;
}

/**
 * Слияние двух списков постов по msgId (больше — свежее).
 * Уже хранимый зеркалированный пост НЕ перезаписывается входящим
 * (иначе повторный прогон затирал бы зеркала исходными ссылками).
 */
export function mergePosts(
  a: StoredCreativePost[],
  b: StoredCreativePost[],
): StoredCreativePost[] {
  const byId = new Map<string, StoredCreativePost>();
  const put = (p: StoredCreativePost) => {
    const prev = byId.get(p.id);
    if (!prev || (p.mirrored && !prev.mirrored)) byId.set(p.id, p);
  };
  // b считается «свежесобранным», a — хранилищем: зеркала хранилища приоритетны
  for (const p of b) put(p);
  for (const p of a) put(p);
  return [...byId.values()].sort((x, y) => y.msgId - x.msgId);
}

// ─── Глубина: load / save ──────────────────────────────────────────────────

export function depthRowKey(channel: string): string {
  return `creative_depth_${channel}`;
}

function rowToDepth(d: Record<string, unknown> | null | undefined): DepthRow | null {
  const posts = (d?.posts as StoredCreativePost[] | undefined) || [];
  if (!Array.isArray(posts) || posts.length === 0) return null;
  return {
    posts,
    complete: !!d?.complete,
    minMsgId: Number(d?.minMsgId || posts[posts.length - 1]?.msgId || 0),
    maxMsgId: Number(d?.maxMsgId || posts[0]?.msgId || 0),
  };
}

/** Читает глубину канала. null — ничего не хранится. */
export async function loadDepth(channel: string): Promise<DepthRow | null> {
  try {
    const db = getDb();
    const { data } = await db
      .from('sync_status')
      .select('details')
      .eq('source', depthRowKey(channel))
      .maybeSingle();
    return rowToDepth((data?.details || null) as Record<string, unknown> | null);
  } catch (e) {
    console.error(`loadDepth(${channel}):`, e);
    return null;
  }
}

/** Пишет глубину канала (пустые списки не пишем — стирать историю нельзя). */
export async function saveDepth(
  channel: string,
  posts: StoredCreativePost[],
  complete: boolean,
): Promise<void> {
  if (!posts.length) return;
  const capped = posts.slice(0, DEPTH_CAP);
  try {
    const db = getDb();
    const row = {
      source: depthRowKey(channel),
      last_run_at: new Date().toISOString(),
      last_status: 'ok',
      new_items: 0,
      updated_items: 0,
      details: {
        posts: capped,
        savedAt: new Date().toISOString(),
        complete: complete && capped.length >= DEPTH_CAP ? true : complete,
        minMsgId: capped[capped.length - 1].msgId,
        maxMsgId: capped[0].msgId,
      },
      error: null,
    };
    const { error } = await db.from('sync_status').upsert(row, { onConflict: 'source' });
    if (error) console.error(`saveDepth(${channel}):`, error.message);
  } catch (e) {
    console.error(`saveDepth(${channel}) failed:`, e);
  }
}

// ─── Страницы для API ──────────────────────────────────────────────────────

export interface CreativePage {
  posts: ClientCreativePost[];
  hasMore: boolean;
  /** base64(JSON {b:{ch:msgId}}) — подставляется клиентом в ?cursor= */
  nextCursor: string | null;
}

function encodeCursor(b: Record<string, number>): string {
  return Buffer.from(JSON.stringify({ b })).toString('base64');
}

/**
 * Страница из одного канала. cursorB.ch — «покажи ниже этого msgId».
 * Хвостовой слой (limit+1) определяет hasMore.
 */
export function pageFromRow(
  depth: DepthRow | null,
  channel: string,
  beforeMsgId: number | undefined,
  limit: number,
): CreativePage & { seenCount: number } {
  const all = depth?.posts || [];
  const filtered = beforeMsgId
    ? all.filter(p => p.msgId < beforeMsgId)
    : all;
  const slice = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;
  return {
    posts: slice.map(toClientPost),
    hasMore,
    nextCursor: slice.length
      ? encodeCursor({ [channel]: slice[slice.length - 1].msgId })
      : null,
    seenCount: all.length,
  };
}

// ─── Зеркалирование медиа ──────────────────────────────────────────────────

function mirrorPath(name: string): string {
  return `creative/${name}`;
}

/**
 * Качает изображение из Telegram CDN, пережимает (800px, JPEG q74 mozjpeg)
 * и кладёт в постоянный Storage. Возвращает публичный URL или null.
 */
export async function mirrorImage(
  url: string,
  name: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Referer': 'https://t.me/',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      const out = await sharp(buf)
        .rotate()
        .resize({ width: 800, withoutEnlargement: true })
        .jpeg({ quality: 74, mozjpeg: true })
        .toBuffer();
      const db = getDb();
      const { error } = await db.storage
        .from('covers')
        .upload(mirrorPath(name), out, { contentType: 'image/jpeg', upsert: true });
      if (error) {
        console.error(`mirrorImage upload (${name}):`, error.message);
        return null;
      }
      const { data } = db.storage.from('covers').getPublicUrl(mirrorPath(name));
      return data?.publicUrl || null;
    } catch (e) {
      if (attempt === 1) console.error(`mirrorImage (${name}):`, e);
    }
  }
  return null;
}

/**
 * Зеркалирует медиа поста: фото (до MIRROR_MAX_PHOTOS) + постер видео.
 * Успешные позиции заменяются зеркалами, остальные остаются исходными URL.
 * mirrored=true только когда зазеркалено ВСЁ.
 */
export async function mirrorPostMedia(
  post: StoredCreativePost,
): Promise<StoredCreativePost> {
  const base = post.msgId; // путь: <ch>-<msgId>-pN / -v
  const photos = [...post.photos];
  for (let i = 0; i < Math.min(photos.length, MIRROR_MAX_PHOTOS); i++) {
    if (isOwnStorageUrl(photos[i])) continue;
    const mirrored = await mirrorImage(photos[i], `${post.channel}-${base}-p${i + 1}`);
    if (mirrored) photos[i] = mirrored;
  }
  let videoPoster = post.videoPoster;
  if (videoPoster && !isOwnStorageUrl(videoPoster)) {
    const m = await mirrorImage(videoPoster, `${post.channel}-${base}-v`);
    if (m) videoPoster = m;
  }
  const origPhotos = post.origPhotos?.length ? post.origPhotos : post.photos;
  const origPoster = post.origPoster || post.videoPoster;
  const allMirrored =
    photos.length > 0 &&
    photos.every(isOwnStorageUrl) &&
    (!videoPoster || isOwnStorageUrl(videoPoster));
  return {
    ...post,
    photos,
    videoPoster,
    origPhotos,
    origPoster,
    mirrored: allMirrored,
  };
}
