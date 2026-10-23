// F-23 fix: убран runtime = 'edge' — роут на стандартном Node.js-рантайме.
//
// ОКТЯБРЬ 2026 — «ВСЕ АРТЫ»: полный размер БЕЗ Jina.
// Прежде роут рендерил страницу поста через Jina (18-22с, 25-50K токенов,
// полный отказ при 402 ключа). Новый основной путь — пробинг расширений на
// CDN rule34: миниатюра однозначно даёт bucket и hash полного файла
// (thumbnails/<b>/thumbnail_<hash>.jpg → images/<b>/<hash>.<ext>),
// перебираем jpg/jpeg/png/gif/webm/mp4, первый не-404 = полный размер.
// CDN доступен с Vercel напрямую (проверено диагностикой), Jina не нужен.
// Живой Jina-путь остаётся фолбэком для постов без thumb-параметра.
import { NextResponse } from 'next/server';
import { checkAdultAccess } from '@/lib/adult-access'; // 18+ = возраст + подписка
import { BoundedTTLCache } from '@/lib/cache';
import { logEvent } from '@/lib/logger';
import { R34_BASE } from '@/lib/sources'; // F-27: домены из единого реестра
import { fetchSourcePage, isPostPageUsable, R34_POST_SELECTOR } from '@/lib/r34-fetch';

export const maxDuration = 60;

const CACHE_TTL = 30 * 60_000;

// F-20 fix: кэш ограничен (LRU + TTL)
const cache = new BoundedTTLCache<string, { data: Record<string, unknown>; ts: number }>(400, CACHE_TTL);

// stale-кэш последнего успешного ответа (24ч) — повторное открытие арта
// не ждёт пробинг заново
const stale = new BoundedTTLCache<string, Record<string, unknown>>(1200, 24 * 60 * 60_000);

// In-memory rate limit (per-IP, 30 req/min)
const rlBuckets = new Map<string, number[]>();
function checkRateLimit(ip: string, max = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  let times = rlBuckets.get(ip);
  if (!times) {
    if (rlBuckets.size > 20_000) {
      const oldest = rlBuckets.keys().next().value;
      if (oldest !== undefined) rlBuckets.delete(oldest);
    }
    times = [];
    rlBuckets.set(ip, times);
  }
  while (times.length && now - times[0] > windowMs) times.shift();
  if (times.length >= max) return false;
  times.push(now);
  return true;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Расширения полного файла в порядке вероятности. */
const EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webm', 'mp4'] as const;
const VIDEO_EXTS = new Set(['webm', 'mp4']);

/**
 * Из URL миниатюры получает кандидатов полного файла.
 * https://wimg.rule34.xxx/thumbnails/3066/thumbnail_<hash>.jpg?123
 *   → https://wimg.rule34.xxx/images/3066/<hash>.{jpg,jpeg,png,gif,webm,mp4}
 * Возвращает null, если миниатюра не распознана.
 */
function fullUrlCandidates(thumbUrl: string): string[] {
  const m = thumbUrl.match(/^https?:\/\/([^/]+)\/thumbnails\/(\d+)\/thumbnail_([a-f0-9]+)\.jpg/i);
  if (!m) return [];
  const [, host, bucket, hash] = m;
  return EXTS.map(ext => `https://${host}/images/${bucket}/${hash}.${ext}`);
}

interface ProbeResult { imageUrl: string; isVideo: boolean }

/** Перебор расширений на CDN: первый не-404 ответ = полный файл. */
async function probeFullImage(thumbUrl: string): Promise<ProbeResult | null> {
  const candidates = fullUrlCandidates(thumbUrl);
  if (candidates.length === 0) return null;
  for (const url of candidates) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Referer: `${R34_BASE}/`,
          Range: 'bytes=0-0', // 1 байт: нужен только статус
        },
        signal: AbortSignal.timeout(8000),
      });
      // 404 = файла нет; 403 на этом CDN встречается и у несуществующих
      // webm/mp4 — не считаем попаданием, но и не прерываем перебор
      if (r.status === 200 || r.status === 206) {
        // тело не нужно — отдаём поток на удаление
        try { await r.body?.cancel(); } catch { /* уже закрыт */ }
        const isVideo = VIDEO_EXTS.has(url.split('.').pop() || '');
        return { imageUrl: url, isVideo };
      }
      try { await r.body?.cancel(); } catch { /* уже закрыт */ }
    } catch {
      // таймаут кандидата — пробуем следующее расширение
    }
  }
  return null;
}

export async function GET(request: Request) {
  // F-15 fix + 18+ по подписке: серверный гейт — возраст И активная подписка
  const access = await checkAdultAccess(request, '/api/rule34-post');
  if (!access.ok) return access.response;

  // Rate limit (F-11 fix: приоритет x-real-ip)
  const ip = request.headers.get('x-real-ip')?.trim()
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
  if (!checkRateLimit(ip, 30)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const postId = searchParams.get('id');
  if (!postId || !/^\d+$/.test(postId)) {
    return NextResponse.json({ error: 'Missing or invalid id' }, { status: 400 });
  }
  // 2026-10-23: клиент передаёт миниатюру — она однозначно определяет
  // полный файл (bucket+hash), рендерить страницу поста не нужно
  const thumb = searchParams.get('thumb') || '';

  const cached = cache.get(postId);
  if (cached) {
    return NextResponse.json(cached.data);
  }

  /* ── Основной путь: пробинг расширений на CDN ───────────────────── */
  if (thumb) {
    try {
      const probe = await probeFullImage(thumb);
      if (probe) {
        const data: Record<string, unknown> = {
          id: postId,
          imageUrl: probe.imageUrl,
          isVideo: probe.isVideo,
          postUrl: `${R34_BASE}/index.php?page=post&s=view&id=${postId}`,
          tags: [], // теги у клиента уже есть из списка — не затираем
          score: 0,
        };
        cache.set(postId, { data, ts: Date.now() });
        stale.set(postId, data);
        return NextResponse.json(data);
      }
    } catch (e) {
      logEvent('r34_probe_fail', { id: postId, err: String(e).slice(0, 120) });
    }
  }

  /* ── Фолбэк: живой рендер страницы поста (Jina) — как раньше ────── */
  try {
    const targetUrl = `${R34_BASE}/index.php?page=post&s=view&id=${postId}`;
    const html = await fetchSourcePage(targetUrl, {
      validate: isPostPageUsable,
      jinaAttempts: 2,
      tryDirect: true,
      timeoutMs: 22_000,
      targetSelector: R34_POST_SELECTOR,
    });

    let imageUrl = '';
    const origLink = html.match(/href="([^"]+)"[^>]*>[^<]*Original image/);
    if (origLink) imageUrl = origLink[1].replace(/&amp;/g, '&');
    if (!imageUrl) {
      const ogMatch = html.match(/property="og:image"[^>]*content="([^"]+)"/);
      if (ogMatch) imageUrl = ogMatch[1].replace(/&amp;/g, '&');
    }
    if (!imageUrl) {
      const imgMatch = html.match(/id="image"[^>]*src="([^"]+)"/) ||
                        html.match(/src="([^"]+)"[^>]*id="image"/);
      if (imgMatch) imageUrl = imgMatch[1].replace(/&amp;/g, '&');
    }
    if (imageUrl && imageUrl.includes('/samples/')) {
      imageUrl = imageUrl.replace('/samples/', '/images/').replace(/sample_/, '').replace(/\.jpg\?/, '.jpeg?');
    }
    imageUrl = imageUrl.replace(/(https?:\/\/[^\/]+)\/\//, '$1/');

    const isRule34Media = (u: string): boolean => {
      try {
        return new URL(u).hostname.endsWith('rule34.xxx');
      } catch {
        return false;
      }
    };
    const videoMatch = html.match(/src="([^"]+\.(?:mp4|webm))"[^>]*type="video/) ||
                        html.match(/(?:source|video)[^>]*src="([^"]+\.(?:mp4|webm))/);
    const realVideoUrl =
      videoMatch && isRule34Media(videoMatch[1]) ? videoMatch[1].replace(/&amp;/g, '&') : '';
    const isVideo =
      !!realVideoUrl || (imageUrl !== '' && /\.(?:mp4|webm)(?:\?|$)/i.test(imageUrl));
    if (realVideoUrl) imageUrl = realVideoUrl;

    const tags: string[] = [];
    const tagSidebar = html.match(/<ul id="tag-sidebar">([\s\S]*?)<\/ul>/);
    if (tagSidebar) {
      const tagRegex = /<a[^>]*href="[^"]*tags=([^"]+)"[^>]*>([^<]*)<\/a>/g;
      let tm;
      while ((tm = tagRegex.exec(tagSidebar[1])) !== null) {
        const decoded = decodeURIComponent(tm[1]).replace(/_/g, ' ');
        if (decoded && !tags.includes(decoded)) tags.push(decoded);
      }
    }

    const data: Record<string, unknown> = {
      id: postId, imageUrl, isVideo,
      postUrl: `${R34_BASE}/index.php?page=post&s=view&id=${postId}`,
      tags, score: 0,
    };

    cache.set(postId, { data, ts: Date.now() });
    stale.set(postId, data);
    return NextResponse.json(data);
  } catch (e) {
    logEvent('r34_post_fail', { id: postId, err: String(e).slice(0, 120) });
    // источник отказал — последнее живое (до 24ч), иначе честный 502;
    // клиент покажет миниатюру через прокси и кнопку «Повторить»
    const st = stale.get(postId);
    if (st) {
      return NextResponse.json(st, { headers: { 'X-Data-Stale': '1' } });
    }
    return NextResponse.json({ error: 'Source unavailable', detail: String(e).slice(0, 200) }, { status: 502 });
  }
}
