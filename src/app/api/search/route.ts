import { NextRequest, NextResponse } from 'next/server';
import { mapToCamel, preferRussianTitle } from '@/lib/anime-utils'; // F-08: без 6.1 МБ data.ts в холодном старте
import { withRateLimit } from '@/lib/with-rate-limit';
import { sanitizeSearchQuery } from '@/lib/validate';
import { BoundedTTLCache } from '@/lib/cache';

// F-PERF: поиск идёт по СТАТИЧЕСКОМУ массиву (зашит в бандл, меняется только
// с деплоем) — результат запроса неизменен, кэшируем на 10 минут + CDN.
const searchCache = new BoundedTTLCache<string, string>(300, 10 * 60_000);
const SEARCH_CACHE_CTRL = 'public, max-age=600, s-maxage=600, stale-while-revalidate=1800';

async function searchHandler(request: NextRequest) {
  try {
    const q = sanitizeSearchQuery(new URL(request.url).searchParams.get('q'));
    if (!q.trim()) return NextResponse.json({ anime: [], total: 0 });

    const hit = searchCache.get(q);
    if (hit) {
      return new NextResponse(hit, {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': SEARCH_CACHE_CTRL },
      });
    }

    // F-08: статический массив грузится лениво
    const { SFW_ANIME } = await import('@/lib/data');
    const ql = q.toLowerCase();
    const results = SFW_ANIME.filter(
      a =>
        a.title.toLowerCase().includes(ql) ||
        (a.title_russian && a.title_russian.toLowerCase().includes(ql)) ||
        a.genres.toLowerCase().includes(ql)
    ).map(a => ({ ...a, ...preferRussianTitle(a as unknown as Record<string, unknown>) }));

    const body = JSON.stringify({ anime: mapToCamel(results), total: results.length });
    searchCache.set(q, body);
    return new NextResponse(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': SEARCH_CACHE_CTRL },
    });
  } catch (error) {
    console.error('Search API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withRateLimit(searchHandler, '/api/search')
