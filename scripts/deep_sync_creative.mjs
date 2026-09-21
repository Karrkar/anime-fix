#!/usr/bin/env node
/**
 * Локальный глубокий синк «Креатива» (без лимита maxDuration):
 *  - докапывает историю каждого канала до DEPTH_CAP=600 постов;
 *  - зеркалит картинки в Supabase Storage (бюджет в штуках на канал);
 *  - бэкфиллит photoDims/posterDims для уже зеркалированных постов
 *    (Range-запрос первых 32КБ + sharp metadata) — для masonry-резерва;
 *  - пишет creative_depth_<ch> строки в sync_status через REST.
 *
 * Запуск: node scripts/deep_sync_creative.mjs [ch1 ch2 ...]
 */
import sharp from 'sharp';

const SB = 'https://uymeyfnuxfbkwisggzdt.supabase.co';
const SK = 'REDACTED-ROTATE-KEY-IN-SUPABASE';

const DEPTH_CAP = 600;
const MIRROR_MAX_PHOTOS = 9;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const NEW_CHANNELS = ['genshin3416', 'StefanFalkokAI', 'ai_harem'];
const MIRROR_BUDGET = { default: 150, new: 600 };

const TITLES = {
  pornofullp: 'PornoFull', art_Hub_ai: 'Art Hub AI', neuroart1215: 'NeuroArt',
  neyroanime: 'Neuro Anime', stefanfalkokmoth: 'Stefan Falk', simple_elf: 'Simple Elf',
  the_horny_ai: 'Horny AI', genshin3416: 'Genshin R34', StefanFalkokAI: 'Stefan Falk AI',
  ai_harem: 'AI Harem',
};
const ALL_CHANNELS = Object.keys(TITLES);
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ALL_CHANNELS;

// ─── REST helpers ──────────────────────────────────────────────────────────
async function rest(path, init = {}) {
  const r = await fetch(`${SB}${path}`, {
    ...init,
    headers: {
      apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  return r;
}

async function loadDepthRow(ch) {
  const r = await rest(`/rest/v1/sync_status?select=details&source=eq.creative_depth_${encodeURIComponent(ch)}`);
  if (!r.ok) return null;
  const rows = await r.json();
  const d = rows?.[0]?.details;
  if (!d?.posts?.length) return null;
  return {
    posts: d.posts,
    complete: !!d.complete,
    minMsgId: Number(d.minMsgId || 0),
    maxMsgId: Number(d.maxMsgId || 0),
  };
}

async function saveDepthRow(ch, posts, complete) {
  const capped = posts.slice(0, DEPTH_CAP);
  const row = {
    source: `creative_depth_${ch}`,
    last_run_at: new Date().toISOString(),
    last_status: 'ok',
    new_items: 0,
    updated_items: 0,
    error: null,
    details: {
      posts: capped,
      savedAt: new Date().toISOString(),
      complete: complete && capped.length >= DEPTH_CAP ? true : complete,
      minMsgId: capped[capped.length - 1].msgId,
      maxMsgId: capped[0].msgId,
    },
  };
  const r = await rest('/rest/v1/sync_status?on_conflict=source', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(row),
  });
  if (!r.ok && r.status !== 201) console.error(`  !! save ${ch}: HTTP ${r.status}`, (await r.text()).slice(0, 200));
  else console.log(`  сохранено: ${capped.length} постов (complete=${complete})`);
}

// ─── t.me парсер (идентично проде) ─────────────────────────────────────────
async function fetchLayerHtml(channel, before) {
  const url = before ? `https://t.me/s/${channel}/?before=${before}` : `https://t.me/s/${channel}/`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://t.me/', 'Accept-Language': 'ru,en;q=0.8' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

const TELESCO_RE = /https?:\/\/cdn\d*\.telesco\.pe\/file\/[A-Za-z0-9_-]+/g;
const DATA_POST_RE = /data-post="[^"]+\/(\d+)"/g;
const TIME_RE = /<time[^>]+datetime="([^"]+)"/i;
const VIDEO_RE = /tgme_widget_message_video_(?:player|thumb)/i;
const TEXT_BLOCK_RE = /<div[^>]+class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i;

function decodeEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function parseTelegramHtml(html) {
  if (!html || !html.includes('tgme_widget_message')) return [];
  const anchors = [];
  DATA_POST_RE.lastIndex = 0;
  let m;
  while ((m = DATA_POST_RE.exec(html)) !== null) anchors.push({ idx: m.index, msgId: Number(m[1]) });
  if (!anchors.length) return [];
  const posts = [];
  for (let i = 0; i < anchors.length; i++) {
    const { idx, msgId } = anchors[i];
    const end = i + 1 < anchors.length ? anchors[i + 1].idx : Math.min(html.length, idx + 30000);
    const block = html.slice(idx, end);
    const urls = [];
    TELESCO_RE.lastIndex = 0;
    let u;
    while ((u = TELESCO_RE.exec(block)) !== null) if (!urls.includes(u[0])) urls.push(u[0]);
    const timeMatch = block.match(TIME_RE);
    const isVideo = VIDEO_RE.test(block);
    const textMatch = block.match(TEXT_BLOCK_RE);
    const caption = textMatch
      ? decodeEntities(textMatch[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 600)
      : '';
    posts.push({
      msgId,
      date: timeMatch ? timeMatch[1] : '',
      photos: isVideo ? [] : urls,
      videoPoster: isVideo && urls.length ? urls[0] : undefined,
      caption,
    });
  }
  return posts.sort((a, b) => b.msgId - a.msgId);
}

// ─── Нормализация / слияние (идентично проде) ──────────────────────────────
const isOwn = u => typeof u === 'string' && u.includes('/storage/v1/object/public/covers/creative/');
const title = ch => TITLES[ch] || ch;

function normalizePost(raw, channel) {
  const photos = raw.photos || [];
  const mirrored = photos.length > 0 && photos.every(isOwn) && (!raw.videoPoster || isOwn(raw.videoPoster));
  return {
    id: `${channel}/${raw.msgId}`,
    channel,
    channelTitle: title(channel),
    msgId: raw.msgId,
    date: raw.date || '',
    caption: raw.caption || '',
    photos,
    videoPoster: raw.videoPoster,
    postUrl: `https://t.me/${channel}/${raw.msgId}`,
    mirrored,
  };
}

function mergePosts(a, b) {
  const byId = new Map();
  const put = p => { const prev = byId.get(p.id); if (!prev || (p.mirrored && !prev.mirrored)) byId.set(p.id, p); };
  for (const p of b) put(p);
  for (const p of a) put(p);
  return [...byId.values()].sort((x, y) => y.msgId - x.msgId);
}

// ─── Зеркалирование ────────────────────────────────────────────────────────
async function mirrorImage(url, name) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://t.me/' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1024) return null;
      const out = await sharp(buf).rotate()
        .resize({ width: 800, withoutEnlargement: true })
        .jpeg({ quality: 74, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      const up = await fetch(`${SB}/storage/v1/object/covers/creative/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {
          apikey: SK, Authorization: `Bearer ${SK}`,
          'Content-Type': 'image/jpeg', 'x-upsert': 'true',
        },
        body: out.data,
        signal: AbortSignal.timeout(30_000),
      });
      if (!up.ok && up.status !== 200) {
        console.error(`  !! upload ${name}: HTTP ${up.status}`);
        return null;
      }
      return {
        url: `${SB}/storage/v1/object/public/covers/creative/${encodeURIComponent(name)}`,
        w: out.info.width, h: out.info.height,
      };
    } catch (e) {
      if (attempt === 1) console.error(`  !! mirror ${name}: ${e.message}`);
    }
  }
  return null;
}

async function mirrorPostMedia(post) {
  const base = post.msgId;
  const photos = [...post.photos];
  const photoDims = post.photoDims ? [...post.photoDims] : photos.map(() => null);
  while (photoDims.length < photos.length) photoDims.push(null);
  let images = 0;
  for (let i = 0; i < Math.min(photos.length, MIRROR_MAX_PHOTOS); i++) {
    if (isOwn(photos[i])) continue;
    const m = await mirrorImage(photos[i], `${post.channel}-${base}-p${i + 1}`);
    if (m) { photos[i] = m.url; photoDims[i] = { w: m.w, h: m.h }; images++; }
  }
  let videoPoster = post.videoPoster;
  let posterDims = post.posterDims || null;
  if (videoPoster && !isOwn(videoPoster)) {
    const m = await mirrorImage(videoPoster, `${post.channel}-${base}-v`);
    if (m) { videoPoster = m.url; posterDims = { w: m.w, h: m.h }; images++; }
  }
  const origPhotos = post.origPhotos?.length ? post.origPhotos : post.photos;
  const origPoster = post.origPoster || post.videoPoster;
  const allMirrored = photos.length > 0 && photos.every(isOwn) && (!videoPoster || isOwn(videoPoster));
  return [{ ...post, photos, photoDims, videoPoster, posterDims, origPhotos, origPoster, mirrored: allMirrored }, images];
}

// ─── Размеры уже зеркалированных (Range + sharp metadata) ──────────────────
async function backfillDims(url) {
  try {
    const r = await fetch(url, {
      headers: { Range: 'bytes=0-32767' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok && r.status !== 206) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const meta = await sharp(buf).metadata();
    if (meta.width && meta.height) return { w: meta.width, h: meta.height };
  } catch { /* попробуем полный файл */ }
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const meta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
    return meta.width && meta.height ? { w: meta.width, h: meta.height } : null;
  } catch { return null; }
}

// Пул конкурентных задач
async function pool(tasks, concurrency) {
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < tasks.length) {
      const t = tasks[i++];
      await t();
    }
  });
  await Promise.all(workers);
}

// ─── Основной ход по каналу ────────────────────────────────────────────────
async function processChannel(ch) {
  const t0 = Date.now();
  console.log(`\n=== ${ch} (${title(ch)}) ===`);
  const stored = await loadDepthRow(ch);
  let posts = stored?.posts || [];
  const before = posts.length;
  // complete из старых строк ставился при DEPTH_CAP=300 — переходим на 600:
  // уважаем флаг только если постов уже >= нового DEPTH_CAP.
  let complete = (stored?.complete && stored.posts.length >= DEPTH_CAP) || false;

  // 1) свежий слой
  const freshHtml = await fetchLayerHtml(ch);
  let freshOk = freshHtml !== null;
  if (freshHtml) {
    const fresh = parseTelegramHtml(freshHtml);
    if (fresh.length) posts = mergePosts(posts, fresh.map(r => normalizePost(r, ch)));
  }

  // 2) слои вглубь до DEPTH_CAP
  let layers = 0;
  while (posts.length < DEPTH_CAP && !complete) {
    const minSaved = posts.length ? posts[posts.length - 1].msgId : 0;
    if (!minSaved) break;
    const html = await fetchLayerHtml(ch, minSaved - 1);
    if (html === null) { console.log(`  сеть/троттлинг на слое ${layers + 1}, стоп`); break; }
    const layer = parseTelegramHtml(html);
    if (!layer.length) { complete = true; break; }
    const layerMax = layer[0]?.msgId || 0;
    if (layerMax >= minSaved) { complete = true; break; }
    const next = mergePosts(posts, layer.map(r => normalizePost(r, ch)));
    if (next.length === posts.length && layers > 0) { complete = true; break; }
    posts = next;
    layers++;
    if (layers % 10 === 0) console.log(`  глубина: ${posts.length} постов (${layers} слоёв)…`);
  }
  if (posts.length >= DEPTH_CAP) complete = true;
  console.log(`  история: ${before} -> ${posts.length} постов (${layers} слоёв, complete=${complete}, fresh=${freshOk})`);

  // 3) зеркальный бюджет
  const budget = NEW_CHANNELS.includes(ch) ? MIRROR_BUDGET.new : MIRROR_BUDGET.default;
  let left = budget;
  const mirrorTasks = [];
  for (let i = 0; i < posts.length && left > 0; i++) {
    if (posts[i].mirrored) continue;
    if (!posts[i].photos.length && !posts[i].videoPoster) continue;
    const idx = i;
    mirrorTasks.push(async () => {
      if (left <= 0) return;
      const [updated, images] = await mirrorPostMedia(posts[idx]);
      posts[idx] = updated;
      left -= images;
    });
  }
  if (mirrorTasks.length) {
    console.log(`  зеркалю (бюджет ${budget} картинок, постов-кандидатов ${mirrorTasks.length})…`);
    await pool(mirrorTasks, 5);
  }
  const mirroredCount = posts.filter(p => p.mirrored).length;
  console.log(`  зеркалировано постов: ${mirroredCount}/${posts.length} (бюджет остаток ${Math.max(0, left)})`);

  // 4) бэкфилл размеров для masonry (первое фото/постер)
  const dimsTasks = [];
  let dimsDone = 0;
  for (const p of posts) {
    const tile = p.photos.length ? p.photos[0] : p.videoPoster;
    if (!tile || !isOwn(tile)) continue;
    const hasDims = p.photos.length ? p.photoDims?.[0] : p.posterDims;
    if (hasDims) continue;
    dimsTasks.push(async () => {
      const d = await backfillDims(tile);
      if (!d) return;
      if (p.photos.length) {
        if (!p.photoDims || p.photoDims.length < p.photos.length) {
          p.photoDims = p.photos.map(() => null);
        }
        p.photoDims[0] = d;
      } else {
        p.posterDims = d;
      }
      dimsDone++;
    });
  }
  if (dimsTasks.length) {
    console.log(`  бэкфилл размеров: ${dimsTasks.length}…`);
    await pool(dimsTasks, 12);
  }
  console.log(`  размеры получены: ${dimsDone}`);

  // 5) сортировка + сохранение
  posts.sort((a, b) => b.msgId - a.msgId);
  await saveDepthRow(ch, posts, complete);
  console.log(`  канал готов за ${((Date.now() - t0) / 1000).toFixed(0)}с`);
}

(async () => {
  const t0 = Date.now();
  for (const ch of targets) {
    try { await processChannel(ch); }
    catch (e) { console.error(`!! канал ${ch} упал:`, e); }
  }
  console.log(`\nИТОГО: ${targets.length} каналов за ${((Date.now() - t0) / 60000).toFixed(1)} мин`);
})();
