/**
 * Парсер публичных Telegram-каналов (вкладка «Креатив») — Task 44/47/51.
 *
 * Источник: превью-страницы https://t.me/s/<channel> (без API, обычный HTML).
 * Task 47: серверный кэш свежего слоя в sync_status (creative_cache_<ch>) —
 * чтобы вкладка не зависела от прямых запросов к t.me при каждом открытии.
 * Task 51: добавлен fetchChannelLayerLive — чистый слой для синка глубины.
 *
 * Коды возврата fetch-слоёв (важно различать!):
 *   Post[]  — слой получен, посты внутри (может быть пустым массивом НЕТ:
 *             пустая страница => '' , см. ниже)
 *   ''      — страница получена, но постов нет (пол истории / неверный before)
 *   null    — сеть недоступна / троттлинг / ошибка парсинга
 */

export interface TgChannel { id: string; title: string }

/** Каналы вкладки «Креатив» — единый источник правды (сервер + метаданные API). */
export const TG_CHANNELS: TgChannel[] = [
  { id: 'pornofullp', title: 'PornoFull' },
  { id: 'art_Hub_ai', title: 'Art Hub AI' },
  { id: 'neuroart1215', title: 'NeuroArt' },
  { id: 'neyroanime', title: 'Neuro Anime' },
  { id: 'stefanfalkokmoth', title: 'Stefan Falk' },
  { id: 'simple_elf', title: 'Simple Elf' },
  { id: 'the_horny_ai', title: 'Horny AI' },
  { id: 'genshin3416', title: 'Genshin R34' },
  { id: 'StefanFalkokAI', title: 'Stefan Falk AI' },
  { id: 'ai_harem', title: 'AI Harem' },
];

export const TG_CHANNEL_IDS = TG_CHANNELS.map(c => c.id);

export function isKnownChannel(id: string | null | undefined): boolean {
  return !!id && TG_CHANNEL_IDS.includes(id);
}

export interface TgRawPost {
  msgId: number;
  date: string;          // ISO из <time datetime>
  photos: string[];      // прямые URL cdn*.telesco.pe
  videoPoster?: string;  // обложка видео (если пост — видео)
  caption: string;       // текст поста (теги сняты)
}

const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const TELESCO_RE = /https?:\/\/cdn\d*\.telesco\.pe\/file\/[A-Za-z0-9_-]+/g;
const DATA_POST_RE = /data-post="[^"]+\/(\d+)"/g;
const TIME_RE = /<time[^>]+datetime="([^"]+)"/i;
const VIDEO_RE = /tgme_widget_message_video_(?:player|thumb)/i;
const TEXT_BLOCK_RE = /<div[^>]+class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
// Аватар канала в шапке каждого сообщения тоже лежит на cdn*.telesco.pe.
// Без вырезания он попадает в photos[0] КАЖДОГО поста (160x160).
const AVATAR_DIV_RE = /<div class="tgme_widget_message_user">[\s\S]*?<\/div>/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Разбор HTML-страницы t.me/s/<ch> в список постов.
 * Пустая страница => [] (пол истории).
 */
export function parseTelegramHtml(html: string): TgRawPost[] {
  if (!html || !html.includes('tgme_widget_message')) return [];

  // Режем по якорям data-post, чтобы каждый пост получил свой кусок HTML
  const anchors: Array<{ idx: number; msgId: number }> = [];
  DATA_POST_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATA_POST_RE.exec(html)) !== null) {
    anchors.push({ idx: m.index, msgId: Number(m[1]) });
  }
  if (!anchors.length) return [];

  const posts: TgRawPost[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const { idx, msgId } = anchors[i];
    const end = i + 1 < anchors.length ? anchors[i + 1].idx : Math.min(html.length, idx + 30_000);
    // Вырезаем аватар канала ДО сбора URL — иначе он станет photos[0]
    const block = html.slice(idx, end).replace(AVATAR_DIV_RE, '');

    // Дедуп URL внутри поста (превью+фото часто дублируются)
    const urls: string[] = [];
    TELESCO_RE.lastIndex = 0;
    let u: RegExpExecArray | null;
    while ((u = TELESCO_RE.exec(block)) !== null) {
      if (!urls.includes(u[0])) urls.push(u[0]);
    }

    const timeMatch = block.match(TIME_RE);
    const isVideo = VIDEO_RE.test(block);
    // Видео: первый URL — обложка; фото: все URL — фото
    const textMatch = block.match(TEXT_BLOCK_RE);

    posts.push({
      msgId,
      date: timeMatch ? timeMatch[1] : '',
      photos: isVideo ? [] : urls,
      videoPoster: isVideo && urls.length ? urls[0] : undefined,
      caption: textMatch ? stripTags(textMatch[1]).slice(0, 600) : '',
    });
  }

  // Порядок в HTML — от свежих к старым; сортируем на всякий случай
  return posts.sort((a, b) => b.msgId - a.msgId);
}

/** Прямой запрос слоя превью-канала. before — msgId, ниже которого нужен слой. */
async function fetchLayerHtml(channel: string, before?: number): Promise<string | null> {
  const url = before
    ? `https://t.me/s/${channel}/?before=${before}`
    : `https://t.me/s/${channel}/`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': FETCH_UA,
        'Referer': 'https://t.me/',
        'Accept-Language': 'ru,en;q=0.8',
      },
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

/**
 * Живой слой канала. Результат:
 *   TgRawPost[] — слой получен
 *   ''          — страница пуста (пол истории)
 *   null        — сеть/троттлинг (слой невалиден, отличать от пустого!)
 */
export async function fetchChannelLayerLive(
  channel: string,
  before?: number,
): Promise<TgRawPost[] | '' | null> {
  const html = await fetchLayerHtml(channel, before);
  if (html === null) return null;
  const posts = parseTelegramHtml(html);
  return posts.length ? posts : '';
}

// ─── Кэш свежего слоя (Task 47) ──────────────────────────────────────────

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 часа

interface CachedLayer {
  posts: TgRawPost[];
  savedAt: number;
}

const memCache = new Map<string, CachedLayer>();

function cacheRowKey(channel: string): string {
  return `creative_cache_${channel}`;
}

async function readCacheRow(channel: string): Promise<CachedLayer | null> {
  try {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const { data } = await db
      .from('sync_status')
      .select('details')
      .eq('source', cacheRowKey(channel))
      .maybeSingle();
    const d = (data?.details || {}) as { posts?: TgRawPost[]; saved_at?: string };
    if (!d.posts || !Array.isArray(d.posts)) return null;
    return { posts: d.posts, savedAt: d.saved_at ? new Date(d.saved_at).getTime() : 0 };
  } catch {
    return null;
  }
}

async function writeCacheRow(channel: string, posts: TgRawPost[]): Promise<void> {
  try {
    const { getDb } = await import('@/lib/db');
    const { recordSyncRun } = await import('@/lib/sync-status');
    await recordSyncRun(cacheRowKey(channel), {
      status: 'ok',
      details: { posts, saved_at: new Date().toISOString() },
    });
    void getDb; // getDb импортирован для единообразия; запись идёт через recordSyncRun
  } catch (e) {
    console.error(`telegram cache write (${channel}):`, e);
  }
}

/**
 * Свежий слой канала с серверным кэшем (вкладка «Креатив»/фолбэк).
 * Кэш считается годным CACHE_TTL_MS; при промахе тянем живой слой.
 * Возвращает посты или [] если источник недоступен.
 */
export async function fetchChannelPosts(channel: string): Promise<TgRawPost[]> {
  const mem = memCache.get(channel);
  if (mem && Date.now() - mem.savedAt < CACHE_TTL_MS) return mem.posts;

  const row = await readCacheRow(channel);
  if (row && Date.now() - row.savedAt < CACHE_TTL_MS) {
    memCache.set(channel, row);
    return row.posts;
  }

  const layer = await fetchChannelLayerLive(channel);
  if (layer && layer.length > 0) {
    memCache.set(channel, { posts: layer, savedAt: Date.now() });
    void writeCacheRow(channel, layer);
    return layer;
  }
  // Источник недоступен: отдаём что есть (старый кэш), не обновляя метки
  return row?.posts || [];
}
