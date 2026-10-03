// F-23 fix: убран runtime = 'edge' — платформа объявила Edge Runtime устаревшим,
// роут работает на стандартном Node.js-рантайме (API совместимы).
// 2026-10-03 fix «пропавшие авторы»: r.jina.ai блокирует анонимные запросы
// с датацентровых IP (~40-50% отказов с Vercel) — арты arzagod/kaistar и др.
// «пропадали», а частичный агрегат кэшировался как полный. Лечение:
// fetchSourcePage с ретраями и валидацией HTML (lib/r34-fetch), чанкование
// агрегата, stale-кэш последнего успеха, честные 502 вместо фейковых «пусто».
import { NextResponse } from 'next/server';
import { checkAdultAccess } from '@/lib/adult-access'; // 18+ = возраст + подписка
import { BoundedTTLCache } from '@/lib/cache';
import { logEvent } from '@/lib/logger';
import { R34_BASE } from '@/lib/sources'; // F-27: домены из единого реестра
import { fetchSourcePage, isListPageUsable, sleep } from '@/lib/r34-fetch';

export const maxDuration = 60;

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

// 2026-10-01: +6 авторов (futarush, kiraamane, aliusnext, meitabuu, maldo, duxvector)
const ARTIST_TAGS = ['arzagod', 'balecxi', 'kaistar', 'kinkimya', 'rognezart', 'hypet', 'backdoorsenpai', 'milfhunter228', 'futarush', 'kiraamane', 'aliusnext', 'meitabuu', 'maldo', 'duxvector'];

const CACHE_TTL = 5 * 60_000;

// F-20 fix: кэш ограничен (LRU + TTL) — раньше Map рос без границ в edge-инстансе
const cache = new BoundedTTLCache<string, { posts: ParsedPost[]; totalPages: number; totalPosts: number }>(100, CACHE_TTL);

// 2026-10-03: stale-кэш последнего УСПЕШНОГО результата (горизонт 6ч) —
// страховка от фейков: если источник отказал, отдаём последнее живое,
// а не молчаливый ноль
const stale = new BoundedTTLCache<string, { posts: ParsedPost[]; totalPages: number; totalPosts: number }>(400, 6 * 60 * 60_000);

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

type ParsedList = { posts: ParsedPost[]; totalPages: number; totalPosts: number };

/** Загрузка одной страницы-списка. mode 'full' — для одиночного тега
 *  (3 попытки Jina + прямой), 'fast' — для агрегата (1 попытка, чанками). */
async function fetchListPage(targetUrl: string, mode: 'full' | 'fast'): Promise<{ html: string; empty: boolean }> {
  const html = await fetchSourcePage(targetUrl, {
    validate: isListPageUsable,
    jinaAttempts: mode === 'full' ? 3 : 1,
    tryDirect: mode === 'full',
    timeoutMs: 12_000,
  });
  // страница валидна: есть thumb-ы → контент; есть только «chickens» → тег честно пуст
  return { html, empty: !html.includes('class="thumb"') };
}

async function fetchAllArtists(pid: number): Promise<ParsedList & { coverage: number }> {
  const allPosts: ParsedPost[] = [];
  let maxTotalPages = 1;
  let totalPosts = 0;
  let okTags = 0;
  let staleTags = 0;
  const seenIds = new Set<string>();

  const merge = (parsed: ParsedList) => {
    for (const p of parsed.posts) {
      if (!seenIds.has(p.id)) {
        seenIds.add(p.id);
        allPosts.push(p);
      }
    }
    totalPosts += parsed.totalPosts;
    if (parsed.totalPages > maxTotalPages) maxTotalPages = parsed.totalPages;
  };

  // 2026-10-03: вместо 14 параллельных запросов (пакет как раз и ловил блок)
  // — чанки по 5 с паузами; отказавший тег добираем из stale-кэша
  const CHUNK = 5;
  for (let i = 0; i < ARTIST_TAGS.length; i += CHUNK) {
    const chunkTags = ARTIST_TAGS.slice(i, i + CHUNK);
    const settled = await Promise.allSettled(
      chunkTags.map(async (tag) => {
        const url = `${R34_BASE}/index.php?page=post&s=list&tags=${encodeURIComponent(tag)}&pid=${pid}`;
        const { html, empty } = await fetchListPage(url, 'fast');
        return { tag, empty, parsed: empty ? null : parseListPage(html, tag) };
      })
    );
    settled.forEach((r, idx) => {
      const tag = chunkTags[idx];
      if (r.status === 'fulfilled' && r.value.parsed) {
        okTags++;
        stale.set(`${tag}:${pid}`, r.value.parsed);
        merge(r.value.parsed);
      } else if (r.status === 'rejected') {
        // источник отказал — последнее живое вместо молчаливого пропуска автора
        const st = stale.get(`${tag}:${pid}`);
        if (st && st.posts.length > 0) {
          staleTags++;
          merge(st);
        }
        logEvent('r34_tag_fail', { tag, pid, err: String(r.reason).slice(0, 120) });
      }
      // «честно пустой» тег (chickens) — ничего не делаем
    });
    if (i + CHUNK < ARTIST_TAGS.length) await sleep(400);
  }

  allPosts.sort((a, b) => b.score - a.score);
  return { posts: allPosts, totalPages: maxTotalPages, totalPosts, coverage: (okTags + staleTags) / ARTIST_TAGS.length };
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
    if (cached) {
      return NextResponse.json({
        posts: cached.posts, total: cached.totalPosts,
        page, totalPages: cached.totalPages, tags: 'all',
      });
    }
    try {
      const fresh = await fetchAllArtists(pid);
      const st = stale.get(cacheKey);
      // покрытие ≥75% — кэшируем как полный; хуже — не кэшируем фрагмент,
      // но отдаём лучший из (фрагмент, stale) вариантов
      if (fresh.coverage >= 0.75 || !st || st.posts.length <= fresh.posts.length) {
        if (fresh.coverage >= 0.75) {
          cache.set(cacheKey, fresh);
          stale.set(cacheKey, fresh);
        }
        if (fresh.posts.length === 0) {
          return NextResponse.json(
            { error: 'Source unavailable', posts: [], total: 0, page, totalPages: 0, tags: 'all' },
            { status: 502 }
          );
        }
        return NextResponse.json({ posts: fresh.posts, total: fresh.totalPosts, page, totalPages: fresh.totalPages, tags: 'all' });
      }
      return NextResponse.json({ posts: st.posts, total: st.totalPosts, page, totalPages: st.totalPages, tags: 'all' });
    } catch {
      const st = stale.get(cacheKey);
      if (st) {
        return NextResponse.json({ posts: st.posts, total: st.totalPosts, page, totalPages: st.totalPages, tags: 'all' }, { headers: { 'X-Data-Stale': '1' } });
      }
      return NextResponse.json({ error: 'Source unavailable', posts: [], total: 0, page, totalPages: 0, tags: 'all' }, { status: 502 });
    }
  }

  const cacheKey = `${tags}:${pid}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return NextResponse.json({
      posts: cached.posts, total: cached.totalPosts,
      page, totalPages: cached.totalPages, tags,
    });
  }

  try {
    const targetUrl = `${R34_BASE}/index.php?page=post&s=list&tags=${encodeURIComponent(tags)}&pid=${pid}`;
    const { html, empty } = await fetchListPage(targetUrl, 'full');

    if (empty) {
      // честно пустой тег («Nobody here but us chickens») — не ошибка и не кэш
      return NextResponse.json({ posts: [], total: 0, page, totalPages: 0, tags });
    }

    const parsed = parseListPage(html, tags);
    if (parsed.posts.length === 0) {
      return NextResponse.json({ posts: [], total: 0, page, totalPages: 0, tags });
    }

    cache.set(cacheKey, parsed);
    stale.set(cacheKey, parsed);
    return NextResponse.json({ posts: parsed.posts, total: parsed.totalPosts, page, totalPages: parsed.totalPages, tags });
  } catch (e) {
    // все попытки отказали: отдаём последнее живое (stale), иначе честный 502 —
    // раньше здесь возвращался фейковый «пустой» ответ, и авторы «пропадали»
    logEvent('r34_fetch_fail', { tags, pid, err: String(e).slice(0, 120) });
    const st = stale.get(cacheKey);
    if (st) {
      return NextResponse.json({ posts: st.posts, total: st.totalPosts, page, totalPages: st.totalPages, tags }, { headers: { 'X-Data-Stale': '1' } });
    }
    return NextResponse.json({ error: 'Source unavailable', posts: [], total: 0, page, totalPages: 0, tags }, { status: 502 });
  }
}
