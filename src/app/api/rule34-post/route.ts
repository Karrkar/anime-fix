// F-23 fix: убран runtime = 'edge' — Edge Runtime объявлен платформой устаревшим,
// роут работает на стандартном Node.js-рантайме (API совместимы).
import { NextResponse } from 'next/server';
import { checkAdultAccess } from '@/lib/adult-access'; // 18+ = возраст + подписка
import { BoundedTTLCache } from '@/lib/cache';
import { logEvent } from '@/lib/logger';
import { R34_BASE, JINA_READER } from '@/lib/sources'; // F-27: домены из единого реестра

const CACHE_TTL = 30 * 60_000;

// F-20 fix: кэш ограничен (LRU + TTL)
const cache = new BoundedTTLCache<string, { data: Record<string, unknown>; ts: number }>(200, CACHE_TTL);

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

function fetchViaJina(targetUrl: string): Promise<string> {
  const encoded = JINA_READER + encodeURIComponent(targetUrl);
  return fetch(encoded, {
    headers: { 'Accept': 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  }).then(r => {
    if (!r.ok) throw new Error(`fetch failed`);
    return r.text();
  });
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
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    const targetUrl = `${R34_BASE}/index.php?page=post&s=view&id=${postId}`;
    const html = await fetchViaJina(targetUrl);

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

    // Detect video
    const videoMatch = html.match(/src="([^"]+\.(?:mp4|webm))"[^>]*type="video/) ||
                        html.match(/(?:source|video)[^>]*src="([^"]+\.(?:mp4|webm))/);
    const isVideo = !!videoMatch;
    if (isVideo && videoMatch) imageUrl = videoMatch[1].replace(/&amp;/g, '&');

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
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch post' });
  }
}
