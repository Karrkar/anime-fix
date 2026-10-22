#!/usr/bin/env node
/**
 * Реконсиляция «Креатива» после фикса аватаров.
 *
 * Что делает по каждому каналу:
 *  1) перечитывает ВСЮ хранимую историю t.me/s чистым парсером (без аватаров);
 *  2) строит карту «оригинальный telesco URL -> зеркало (наш Storage, +dims)»
 *     из origPhotos/origPoster хранимых постов;
 *  3. пересобирает каждый пост из свежего парса, подставляя зеркала там, где
 *     оригинал совпал — аватары (не встречаются в чистом парсе) выпадают сами,
 *     постеры видео восстанавливаются из чистого парса;
 *  4. добирает посты, которых нет в свежем парсе (удалённые из канала) —
 *     их чистим эвристикой: частый telesco URL = аватар, dims<=220 = аватар;
 *  5) зеркалит незеркалированные медиа (бюджет), сохраняет строку.
 *
 * Запуск: node scripts/reconcile_creative.mjs [ch1 ch2 ...]
 */
import sharp from 'sharp';

const SB = 'https://uymeyfnuxfbkwisggzdt.supabase.co';
const SK = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SK) { console.error('SUPABASE_SERVICE_ROLE_KEY не задан — экспортируйте переменную окружения'); process.exit(1); }

const DEPTH_CAP = 600;
const MIRROR_MAX_PHOTOS = 9;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const NEW_CHANNELS = ['genshin3416', 'StefanFalkokAI', 'ai_harem'];
const MIRROR_BUDGET = { default: 120, new: 300 };
const FRESH_MIRRORS = process.argv.includes('--fresh-mirrors');

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
  return { posts: d.posts, complete: !!d.complete, minMsgId: Number(d.minMsgId || 0), maxMsgId: Number(d.maxMsgId || 0) };
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

// ─── Чистый парсер (идентично проде с фиксом) ──────────────────────────────
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
    const block = html.slice(idx, end).replace(AVATAR_DIV_RE, '');
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
    // -nN: новые зеркала не должны конфликтовать с легаси -pN (позиции
    // сдвинулись после вырезания аватаров — -pN мог быть занят другим фото)
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
  const minStored = stored.minMsgId || storedPosts[storedPosts.length - 1].msgId;

  // 1) Перепрочитать всю историю чистым парсером (до minStored-1)
  const freshById = new Map();
  let html = await fetchLayerHtml(ch);
  let liveOk = html !== null;
  let pages = 0;
  let prevMin = Infinity;
  while (html && pages < 80) {
    const layer = parseTelegramHtml(html);
    if (!layer.length) break;
    for (const p of layer) freshById.set(p.msgId, p);
    pages++;
    const layerMin = Math.min(...layer.map(p => p.msgId));
    const layerMax = Math.max(...layer.map(p => p.msgId));
    if (layerMin < minStored) break;
    if (layerMax >= prevMin) break; // t.me не сдвинулся вниз — дно истории
    prevMin = layerMin;
    html = await fetchLayerHtml(ch, layerMin - 1);
  }
  console.log(`  чистый парс: ${freshById.size} постов (${pages} страниц, live=${liveOk})`);

  // 2) Карта оригинал -> зеркало по хранимым постам
  //    (--fresh-mirrors: игнорировать легаси-зеркала и перезеркалить всё заново)
  const mirrorMap = new Map(); // telescoUrl -> { url, dims }
  if (!FRESH_MIRRORS) {
    for (const p of storedPosts) {
      if (p.origPhotos) {
        p.origPhotos.forEach((ou, i) => {
          if (ou && isOwn(p.photos?.[i])) {
            mirrorMap.set(ou, { url: p.photos[i], dims: p.photoDims?.[i] || null });
          }
        });
      } else {
        p.photos?.forEach((su) => {
          if (isOwn(su)) mirrorMap.set(su, { url: su, dims: null, self: true });
        });
      }
      if (p.origPoster && isOwn(p.videoPoster)) {
        mirrorMap.set(p.origPoster, { url: p.videoPoster, dims: p.posterDims || null });
      }
    }
  }

  // 3) Частотный анализ telesco URL (аватары появляются почти в каждом посте)
  const freq = new Map();
  for (const p of storedPosts) {
    for (const u of p.photos || []) if (isTelesco(u)) freq.set(u, (freq.get(u) || 0) + 1);
    if (p.videoPoster && isTelesco(p.videoPoster)) freq.set(p.videoPoster, (freq.get(p.videoPoster) || 0) + 1);
  }
  const avatarUrls = new Set([...freq.entries()].filter(([, c]) => c >= 5).map(([u]) => u));
  console.log(`  аватар-URL (частые): ${avatarUrls.size}`);

  // 4) Пересборка
  const result = [];
  let rebuilt = 0, cleanedOnly = 0, lostMedia = 0;
  for (const sp of storedPosts) {
    const f = freshById.get(sp.msgId);
    if (f) {
      const np = normalizePost(f, ch);
      np.photos = f.photos.map(u => mirrorMap.has(u) ? mirrorMap.get(u).url : u);
      np.photoDims = f.photos.map(u => (mirrorMap.get(u)?.dims) || null);
      const anyMirror = np.photos.some(isOwn);
      if (anyMirror) np.origPhotos = f.photos;
      if (f.videoPoster) {
        const mp = mirrorMap.get(f.videoPoster);
        np.videoPoster = mp ? mp.url : f.videoPoster;
        np.posterDims = mp?.dims || null;
        if (isOwn(np.videoPoster)) np.origPoster = f.videoPoster;
      }
      np.mirrored = np.photos.length > 0 && np.photos.every(isOwn) && (!np.videoPoster || isOwn(np.videoPoster));
      result.push(np);
      rebuilt++;
    } else {
      // поста нет в свежем парсе (удалён/недоступен) — чистим эвристикой
      const videoOk = sp.videoPoster && !avatarUrls.has(sp.videoPoster) && !smallDims(sp.posterDims);
      const keepIdx = [];
      (sp.photos || []).forEach((u, i) => {
        if (avatarUrls.has(u)) return;
        if (smallDims(sp.photoDims?.[i])) return;
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
      if (!np.photos.length && !np.videoPoster) lostMedia++;
      result.push(np);
      cleanedOnly++;
    }
  }
  // свежие посты, которых не было в хранилище
  let added = 0;
  for (const [msgId, f] of freshById) {
    if (!storedPosts.some(sp => sp.msgId === msgId)) {
      result.push(normalizePost(f, ch));
      added++;
    }
  }
  console.log(`  пересобрано: ${rebuilt}, эвристически: ${cleanedOnly} (без медиа: ${lostMedia}), новых: ${added}`);
  result.sort((a, b) => b.msgId - a.msgId);

  // 5) Зеркальный бюджет
  const budget = NEW_CHANNELS.includes(ch) ? MIRROR_BUDGET.new : MIRROR_BUDGET.default;
  let left = budget;
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
    console.log(`  зеркалю (бюджет ${budget}, кандидатов ${tasks.length})…`);
    await pool(tasks, 5);
  }

  // 6) Бэкфилл размеров для плиток
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

  // 7) Сохранение
  const complete = stored.complete && result.length >= DEPTH_CAP ? true : stored.complete;
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
