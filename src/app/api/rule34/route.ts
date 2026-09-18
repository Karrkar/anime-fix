// F-23 fix: убран runtime = 'edge' — платформа объявила Edge Runtime устаревшим,
// роут работает на стандартном Node.js-рантайме (API совместимы).
import { NextResponse } from 'next/server';
import { checkAdultAccess } from '@/lib/adult-access'; // 18+ = возраст + подписка
import { BoundedTTLCache } from '@/lib/cache';
import { logEvent } from '@/lib/logger';
import { R34_BASE, JINA_READER } from '@/lib/sources'; // F-27: домены из единого реестра

interface ParsedPost {
  id: string;
  thumbnailUrl: string;
  tags: string[];
  artist: string;
  characters: string[];
  score: number;
  rating: string;
  title: string;
  postUrl: string;
}

const PER_PAGE = 42;

const ARTIST_TAGS = ['arzagod', 'balecxi', 'kaistar', 'kinkimya', 'rognezart', 'hypet', 'backdoorsenpai', 'milfhunter228'];

const CACHE_TTL = 5 * 60_000;

// F-20 fix: кэш ограничен (LRU + TTL) — раньше Map рос без границ в edge-инстансе
const cache = new BoundedTTLCache<string, { data: { posts: ParsedPost[]; totalPages: number; totalPosts: number }; ts: number }>(100, CACHE_TTL);

// In-memory rate limit (per-IP, 20 req/min) — работает и на Node-рантайме
const rlBuckets = new Map<string, number[]>();
function checkRateLimit(ip: string, max = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  let times = rlBuckets.get(ip);
  if (!times) {
    // F-20: граница на число корзин — защита от роста Map
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

function parseListPage(html: string, searchTag: string): { posts: ParsedPost[]; totalPages: number; totalPosts: number } {
  const posts: ParsedPost[] = [];
  const thumbRegex = /<span id="s(\d+)" class="thumb"[^>]*>\s*<a id="p(\d+)" href="([^"]+)">[\s\S]*?<img[^>]*src="([^"]+)"[^>]*title="([^"]+)"/g;
  let match;
  while ((match = thumbRegex.exec(html)) !== null) {
    const [, , postId, href, thumbSrc, titleAttr] = match;
    const titleText = titleAttr.trim();
    const tags: string[] = [];
    let score = 0;
    let rating = 'explicit';
    const parts = titleText.split(/\s+/);
    const seen = new Set<string>();
    for (const p of parts) {
      if (p.startsWith('score:')) { score = parseInt(p.replace('score:', ''), 10) || 0; }
      else if (p.startsWith('rating:')) { rating = p.replace('rating:', ''); }
      else if (p && !p.startsWith('(') && !p.startsWith(')')) {
        const normalized = p.replace(/_/g, ' ');
        if (!seen.has(normalized.toLowerCase())) { seen.add(normalized.toLowerCase()); tags.push(normalized); }
      }
    }
    const charTags = tags.filter(t => t.includes('('));
    const displayTitle = charTags.length > 0
      ? charTags.slice(0, 2).map(c => c.replace(/ \(.*\)$/, '')).join(', ')
      : tags.slice(0, 3).join(', ');
    const searchTagLower = searchTag.toLowerCase().replace(/_/g, ' ');
    const artistTag = tags.find(t => t.toLowerCase() === searchTagLower) ||
      tags.find(t => !t.includes('(') && t !== '1girl' && t !== '1boy' && !t.startsWith('ai '));
    const characterTags = tags.filter(t => t.includes('(') && !t.includes('fate') && !t.includes('series'));
    posts.push({
      id: postId, thumbnailUrl: thumbSrc, tags, artist: artistTag || 'Unknown',
      characters: characterTags.map(c => c.replace(/ \(.*\)$/, '')),
      score, rating, title: displayTitle,
      postUrl: `${R34_BASE}${href}`,
    });
  }

  let totalPages = 1;
  let totalPosts = posts.length;
  const lastPageHref = html.match(/href="[^"]*pid=(\d+)"[^>]*alt="last page"/);
  if (lastPageHref) {
    const lastPid = parseInt(lastPageHref[1], 10);
    totalPages = Math.floor(lastPid / PER_PAGE) + 1;
    totalPosts = lastPid + PER_PAGE;
  }
  return { posts, totalPages, totalPosts };
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

async function fetchAllArtists(pid: number): Promise<{ posts: ParsedPost[]; totalPages: number; totalPosts: number }> {
  const results = await Promise.allSettled(
    ARTIST_TAGS.map(async (tag) => {
      const url = `${R34_BASE}/index.php?page=post&s=list&tags=${encodeURIComponent(tag)}&pid=${pid}`;
      const html = await fetchViaJina(url);
      return parseListPage(html, tag);
    })
  );

  const allPosts: ParsedPost[] = [];
  let maxTotalPages = 1;
  let totalPosts = 0;
  const seenIds = new Set<string>();

  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const p of r.value.posts) {
        if (!seenIds.has(p.id)) {
          seenIds.add(p.id);
          allPosts.push(p);
        }
      }
      totalPosts += r.value.totalPosts;
      if (r.value.totalPages > maxTotalPages) maxTotalPages = r.value.totalPages;
    }
  }

  allPosts.sort((a, b) => b.score - a.score);
  return { posts: allPosts, totalPages: maxTotalPages, totalPosts };
}

export async function GET(request: Request) {
  // F-15 fix + 18+ по подписке: серверный гейт — возраст И активная подписка
  const access = await checkAdultAccess(request, '/api/rule34');
  if (!access.ok) return access.response;

  // Rate limit (F-11 fix: приоритет у x-real-ip, который ставит платформа)
  const ip = request.headers.get('x-real-ip')?.trim()
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
  if (!checkRateLimit(ip, 20)) {
    return NextResponse.json({ error: 'Too many requests', posts: [], total: 0, page: 1, totalPages: 0 }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const tags = searchParams.get('tags') || '';
  const pid = Math.max(0, Math.min(parseInt(searchParams.get('pid') || '0', 10) || 0, 100000));
  const page = Math.floor(pid / PER_PAGE) + 1;

  // Validate tags input (only allow alphanumeric, spaces, underscores, hyphens)
  if (tags && tags !== 'all' && !/^[a-zA-Z0-9_\-\s]+$/.test(tags)) {
    return NextResponse.json({ error: 'Invalid tags', posts: [], total: 0, page: 1, totalPages: 0, tags }, { status: 400 });
  }

  if (tags === 'all' || tags === '') {
    const cacheKey = `all:${pid}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return NextResponse.json({
        posts: cached.data.posts, total: cached.data.totalPosts,
        page, totalPages: cached.data.totalPages, tags: 'all',
      });
    }
    try {
      const { posts, totalPages, totalPosts } = await fetchAllArtists(pid);
      cache.set(cacheKey, { data: { posts, totalPages, totalPosts }, ts: Date.now() });
      return NextResponse.json({ posts, total: totalPosts, page, totalPages, tags: 'all' });
    } catch {
      return NextResponse.json({ error: 'Failed to load', posts: [], total: 0, page: 1, totalPages: 0, tags: 'all' });
    }
  }

  const cacheKey = `${tags}:${pid}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({
      posts: cached.data.posts, total: cached.data.totalPosts,
      page, totalPages: cached.data.totalPages, tags,
    });
  }

  try {
    const targetUrl = `${R34_BASE}/index.php?page=post&s=list&tags=${encodeURIComponent(tags)}&pid=${pid}`;
    const html = await fetchViaJina(targetUrl);
    const { posts, totalPages, totalPosts } = parseListPage(html, tags);

    if (posts.length === 0) {
      return NextResponse.json({ posts: [], total: 0, page, totalPages: 0, tags });
    }

    cache.set(cacheKey, { data: { posts, totalPages, totalPosts }, ts: Date.now() });
    return NextResponse.json({ posts, total: totalPosts, page, totalPages, tags });
  } catch {
    return NextResponse.json({ error: 'Failed to load', posts: [], total: 0, page: 1, totalPages: 0, tags });
  }
}
