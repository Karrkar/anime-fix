// F-23 fix: убран runtime = 'edge' — Edge Runtime объявлен платформой устаревшим,
// роут работает на стандартном Node.js-рантайме (API совместимы).
// 2026-10-03: переход на lib/r34-fetch — ретраи + валидация HTML + опциональный
// JINA_API_KEY (r.jina.ai блокирует анонимные датацентровые IP ~40-50% запросов)
import { NextResponse } from 'next/server';
import { checkAdultAccess } from '@/lib/adult-access'; // 18+ = возраст + подписка
import { BoundedTTLCache } from '@/lib/cache';
import { logEvent } from '@/lib/logger';
import { R34_BASE } from '@/lib/sources'; // F-27: домены из единого реестра
import { fetchSourcePage, isPostPageUsable, R34_POST_SELECTOR } from '@/lib/r34-fetch';

export const maxDuration = 60;

const CACHE_TTL = 30 * 60_000;

// F-20 fix: кэш ограничен (LRU + TTL)
const cache = new BoundedTTLCache<string, { data: Record<string, unknown>; ts: number }>(200, CACHE_TTL);

// 2026-10-04 fix «чёрный экран на телефоне»: stale-кэш последнего успешного
// ответа (24ч). Деталка через Jina занимает 18-22с и может вообще не прийти
// (лимит/блок) — повторное открытие того же арта не должно снова ждать и
// падать в пустоту: отдаём последнюю успешную версию (пусть и старую).
// Клиент при полном провале показывает миниатюру через прокси + «Повторить».
const stale = new BoundedTTLCache<string, Record<string, unknown>>(600, 24 * 60 * 60_000);

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

  const cached = cache.get(postId);
  if (cached) {
    return NextResponse.json(cached.data);
  }

  try {
    const targetUrl = `${R34_BASE}/index.php?page=post&s=view&id=${postId}`;
    const html = await fetchSourcePage(targetUrl, {
      validate: isPostPageUsable,
      jinaAttempts: 2,
      tryDirect: true,
      // 2026-10-03: X-Target-Selector — 25-50K токенов вместо 142K за пост.
      // НЮАНС: выборка требует полного рендера — пост-страница летит 18-20с
      // (без селектора 9-10с, но 142K токенов). Таймаут 22с: попытка успевает,
      // худший случай 2×22+1.5+9 ≈ 55с < maxDuration 60.
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

    // Detect video. 2026-10-03 fix: на страницах постов rule34 крутит рекламу
    // с собственными <video src="…bkcdn.net/….mp4"> — старый код считал их
    // видео поста и ЗАТИРАЛ правильный imageUrl рекламным URL. Теперь видео
    // поста = mp4/webm с домена rule34.xxx (ahrimp4/wimg) ИЛИ mp4/webm в
    // ссылке «Original image» (у видео-постов она указывает на сам файл).
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

    // Extract tags
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
