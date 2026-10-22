#!/usr/bin/env node
/**
 * Финальный ремонт «Креатива» после фикса аватаров.
 *
 * Контекст: telesco-URL протухают за дни, поэтому URL-маппинг «оригинал→зеркало»
 * работает только в день зеркалирования. Легаси-зеркала (-pN, созданные парсером
 * С аватаром) живы в Storage: аватар занимал позицию 0, реальные фото — позиции 1..N
 * под именами -p2..-p(N+1). После чистки парса позиция i соответствует легаси -p(i+2).
 *
 * Пайплайн по каналу:
 *  1) полный проход истории (до 250 страниц, стоп при отсутствии новых постов);
 *  2) пересборка постов из свежего парса (аватаров нет, видео-постеры настоящие);
 *     + URL-маппинг зеркал сегодняшних прогонов (origPhotos текущей строки);
 *     + адопция легаси-зеркал: telesco-позиция i -> HEAD covers/creative/<ch>-<msgId>-p(i+2);
 *  3) свежие зеркала остатков (бюджет MIRROR_BUDGET, имена -nN/-nv);
 *  4) бэкфилл размеров (Range 32КБ + sharp) для плиток;
 *  5) сохранение строки.
 *
 * Запуск: node scripts/repair_creative.mjs [ch ...]
 */
import sharp from 'sharp';

const SB = 'https://uymeyfnuxfbkwisggzdt.supabase.co';
const SK = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SK) { console.error('SUPABASE_SERVICE_ROLE_KEY не задан — экспортируйте переменную окружения'); process.exit(1); }

const DEPTH_CAP = 600;
const MIRROR_MAX_PHOTOS = 9;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MIRROR_BUDGET = process.argv.includes('--fast') ? 0 : 400; // новых картинок на канал

const TITLES = {
  pornofullp: 'PornoFull', art_Hub_ai: 'Art Hub AI', neuroart1215: 'NeuroArt',
  neyroanime: 'Neuro Anime', stefanfalkokmoth: 'Stefan Falk', simple_elf: 'Simple Elf',
  the_horny_ai: 'Horny AI', genshin3416: 'Genshin R34', StefanFalkokAI: 'Stefan Falk AI',
  ai_harem: 'AI Harem',
};
const ALL_CHANNELS = Object.keys(TITLES);
const targets = process.argv.slice(2).filter(a => !a.startsWith('--'));
const runTargets = targets.length ? targets : ALL_CHANNELS;

// ─── REST ──────────────────────────────────────────────────────────────────
async function rest(path, init = {}) {
  return fetch(`${SB}${path}`, {
    ...init,
    headers: {
      apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

async function loadDepthRow(ch) {
  const r = await rest(`/rest/v1/sync_status?select=details&source=eq.creative_depth_${encodeURIComponent(ch)}`);
  if (!r.ok) return null;
  const rows = await r.json();
  const d = rows?.[0]?.details;
  if (!d?.posts?.length) return null;
  return { posts: d.posts, complete: !!d.complete, minMsgId: Number(d.minMsgId || 0) };
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
      complete,
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
  else console.log(`  сохранено: ${capped.length} постов`);
}

// ─── Чистый парсер ─────────────────────────────────────────────────────────
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
const AVATAR_DIV_RE = /<div class="tgme_widget_message_user">[\s\S]*?<\/div>/i;
const REPLY_THUMB_RE = /<i class="tgme_widget_message_reply_thumb"[^>]*>[\s\S]*?<\/i>/gi;

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
    const block = html.slice(idx, end).replace(AVATAR_DIV_RE, '').replace(REPLY_THUMB_RE, '');
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

// ─── Утилиты ───────────────────────────────────────────────────────────────
const isOwn = u => typeof u === 'string' && u.includes('/storage/v1/object/public/covers/creative/');
const isTelesco = u => typeof u === 'string' && /cdn\d*\.telesco\.pe\/file\//.test(u);
const title = ch => TITLES[ch] || ch;
const smallDims = d => d && d.w > 0 && d.w <= 220 && d.h > 0 && d.h <= 220;
const publicUrl = name => `${SB}/storage/v1/object/public/covers/creative/${encodeURIComponent(name)}`;

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

async function headOk(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch { return false; }
}

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
        headers: { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
        body: out.data,
        signal: AbortSignal.timeout(30_000),
      });
      if (!up.ok && up.status !== 200) return null;
      return { url: publicUrl(name), w: out.info.width, h: out.info.height };
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
    const m = await mirrorImage(photos[i], `${post.channel}-${base}-n${i + 1}`);
    if (m) { photos[i] = m.url; photoDims[i] = { w: m.w, h: m.h }; images++; }
  }
  let videoPoster = post.videoPoster;
  let posterDims = post.posterDims || null;
  if (videoPoster && !isOwn(videoPoster)) {
    const m = await mirrorImage(videoPoster, `${post.channel}-${base}-nv`);
    if (m) { videoPoster = m.url; posterDims = { w: m.w, h: m.h }; images++; }
  }
  const origPhotos = post.origPhotos?.length ? post.origPhotos : post.photos;
  const origPoster = post.origPoster || post.videoPoster;
  const allMirrored = photos.length > 0 && photos.every(isOwn) && (!videoPoster || isOwn(videoPoster));
  return [{ ...post, photos, photoDims, videoPoster, posterDims, origPhotos, origPoster, mirrored: allMirrored }, images];
}

async function backfillDims(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-32767' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok && r.status !== 206) return null;
    const meta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
    if (meta.width && meta.height) return { w: meta.width, h: meta.height };
  } catch { /* полный файл ниже */ }
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const meta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
    return meta.width && meta.height ? { w: meta.width, h: meta.height } : null;
  } catch { return null; }
}

async function pool(tasks, concurrency) {
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < tasks.length) await tasks[i++]();
  }));
}

// ─── Ход по каналу ─────────────────────────────────────────────────────────
async function processChannel(ch) {
  const t0 = Date.now();
  console.log(`\n=== ${ch} (${title(ch)}) ===`);
  const stored = await loadDepthRow(ch);
  if (!stored) { console.log('  нет строки, пропускаю'); return; }
  const storedPosts = stored.posts;

  // 1) Полный проход истории
  const freshById = new Map();
  let html = await fetchLayerHtml(ch);
  let pages = 0;
  while (html && pages < 250) {
    const layer = parseTelegramHtml(html);
    if (!layer.length) break;
    const newCount = layer.filter(p => !freshById.has(p.msgId)).length;
    if (newCount === 0 && pages > 0) break;
    for (const p of layer) freshById.set(p.msgId, p);
    pages++;
    const layerMin = Math.min(...layer.map(p => p.msgId));
    const layerMax = Math.max(...layer.map(p => p.msgId));
    if (layerMax >= (freshById._prevMin ?? Infinity)) break;
    freshById._prevMin = layerMin;
    html = await fetchLayerHtml(ch, layerMin - 1);
  }
  console.log(`  свежий парс: ${freshById.size} постов (${pages} страниц)`);

  // 2) URL-карта зеркал из текущей строки (зеркала сегодняшних прогонов)
  const urlMap = new Map();
  for (const p of storedPosts) {
    if (p.origPhotos) {
      p.origPhotos.forEach((ou, i) => {
        if (ou && isOwn(p.photos?.[i])) urlMap.set(ou, { url: p.photos[i], dims: p.photoDims?.[i] || null });
      });
    }
    if (p.origPoster && isOwn(p.videoPoster)) urlMap.set(p.origPoster, { url: p.videoPoster, dims: p.posterDims || null });
  }

  // 3) Пересборка + адопция легаси-зеркал
  const result = [];
  let rebuilt = 0, adopted = 0, urlMapped = 0, heuristic = 0, noMedia = 0, added = 0;
  const freq = new Map();
  for (const p of storedPosts) {
    for (const u of p.photos || []) if (isTelesco(u)) freq.set(u, (freq.get(u) || 0) + 1);
    if (p.videoPoster && isTelesco(p.videoPoster)) freq.set(p.videoPoster, (freq.get(p.videoPoster) || 0) + 1);
  }
  const avatarUrls = new Set([...freq.entries()].filter(([, c]) => c >= 5).map(([u]) => u));
  // Легаси-зеркало аватара всегда на пути -p1 (аватар занимал позицию 0),
  // легаси-аватар-постер видео — на -v. Новые зеркала — только -nN/-nv, адопция — -p>=2.
  const lastSeg = u => (u.split('/').pop() || '');
  const isLegacyAvatarMirror = u => isOwn(u) && /-p1$/.test(lastSeg(u));
  const isLegacyAvatarPoster = u => isOwn(u) && /-v$/.test(lastSeg(u));

  const rebuildTasks = storedPosts.map(sp => async () => {
    const f = freshById.get(sp.msgId);
    if (f) {
      const np = normalizePost(f, ch);
      // адопция: параллельные HEAD по telesco-позициям
      const adopts = f.photos.map((u, i) => {
        const um = urlMap.get(u);
        if (um) { urlMapped++; return Promise.resolve({ url: um.url, dims: um.dims }); }
        if (!isTelesco(u)) return Promise.resolve(null);
        const legacy = publicUrl(`${ch}-${sp.msgId}-p${i + 2}`); // сдвиг +2: аватар + позиция с 1
        return headOk(legacy).then(ok => {
          if (ok) { adopted++; return { url: legacy, dims: null }; }
          return null;
        });
      });
      const maps = await Promise.all(adopts);
      np.photos = f.photos.map((u, i) => (maps[i] ? maps[i].url : u));
      np.photoDims = f.photos.map((u, i) => (maps[i]?.dims) || null);
      const anyMirror = np.photos.some(isOwn);
      if (anyMirror) np.origPhotos = f.photos;
      if (f.videoPoster) {
        const mp = urlMap.get(f.videoPoster);
        np.videoPoster = mp ? mp.url : f.videoPoster;
        np.posterDims = mp?.dims || null;
        if (isOwn(np.videoPoster)) np.origPoster = f.videoPoster;
      }
      np.mirrored = np.photos.length > 0 && np.photos.every(isOwn) && (!np.videoPoster || isOwn(np.videoPoster));
      result.push(np);
      rebuilt++;
    } else {
      const videoOk = sp.videoPoster && !avatarUrls.has(sp.videoPoster) && !smallDims(sp.posterDims) && !isLegacyAvatarPoster(sp.videoPoster);
      const keepIdx = [];
      (sp.photos || []).forEach((u, i) => {
        if (avatarUrls.has(u)) return;
        if (smallDims(sp.photoDims?.[i])) return;
        if (isLegacyAvatarMirror(u)) return;
        keepIdx.push(i);
      });
      const np = {
        ...sp,
        photos: keepIdx.map(i => sp.photos[i]),
        photoDims: keepIdx.map(i => sp.photoDims?.[i] ?? null),
        origPhotos: sp.origPhotos ? keepIdx.map(i => sp.origPhotos[i]).filter(Boolean) : undefined,
        videoPoster: videoOk ? sp.videoPoster : undefined,
        posterDims: videoOk ? (sp.posterDims || null) : null,
        origPoster: videoOk ? sp.origPoster : undefined,
      };
      np.mirrored = np.photos.length > 0 && np.photos.every(isOwn) && (!np.videoPoster || isOwn(np.videoPoster));
      if (!np.photos.length && !np.videoPoster) noMedia++;
      result.push(np);
      heuristic++;
    }
  });
  await pool(rebuildTasks, 8);
  for (const [msgId, f] of freshById) {
    if (!storedPosts.some(sp => sp.msgId === msgId)) { result.push(normalizePost(f, ch)); added++; }
  }
  console.log(`  пересобрано ${rebuilt} (urlMap ${urlMapped}, adopt ${adopted}), эвристика ${heuristic} (без медиа ${noMedia}), новых ${added}`);
  result.sort((a, b) => b.msgId - a.msgId);

  // 4) Свежие зеркала остатков
  let left = MIRROR_BUDGET;
  const tasks = [];
  for (const p of result) {
    if (p.mirrored) continue;
    if (!p.photos.length && !p.videoPoster) continue;
    tasks.push(async () => {
      if (left <= 0) return;
      const idx = result.indexOf(p);
      const [updated, images] = await mirrorPostMedia(p);
      result[idx] = updated;
      left -= images;
    });
  }
  if (tasks.length) {
    console.log(`  свежие зеркала: кандидатов ${tasks.length}, бюджет ${MIRROR_BUDGET}…`);
    await pool(tasks, 5);
  }

  // 5) Бэкфилл размеров
  const dimsTasks = [];
  let dimsDone = 0;
  for (const p of result) {
    const tile = p.photos.length ? p.photos[0] : p.videoPoster;
    if (!tile || !isOwn(tile)) continue;
    const hasDims = p.photos.length ? p.photoDims?.[0] : p.posterDims;
    if (hasDims) continue;
    dimsTasks.push(async () => {
      const d = await backfillDims(tile);
      if (!d) return;
      if (p.photos.length) {
        if (!p.photoDims || p.photoDims.length < p.photos.length) p.photoDims = p.photos.map(() => null);
        p.photoDims[0] = d;
      } else p.posterDims = d;
      dimsDone++;
    });
  }
  if (dimsTasks.length) {
    console.log(`  бэкфилл размеров: ${dimsTasks.length}…`);
    await pool(dimsTasks, 12);
  }
  console.log(`  размеры: +${dimsDone}`);

  // 6) Сохранение
  const complete = stored.complete || false;
  await saveDepthRow(ch, result, complete);
  const withMedia = result.filter(p => p.photos.length || p.videoPoster).length;
  console.log(`  с медиа: ${withMedia}/${result.length} | зеркал: ${result.filter(p => p.mirrored).length} | за ${((Date.now() - t0) / 1000).toFixed(0)}с`);
}

(async () => {
  const t0 = Date.now();
  for (const ch of runTargets) {
    try { await processChannel(ch); }
    catch (e) { console.error(`!! канал ${ch} упал:`, e); }
  }
  console.log(`\nИТОГО: ${runTargets.length} каналов за ${((Date.now() - t0) / 60000).toFixed(1)} мин`);
})();
