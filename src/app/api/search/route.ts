import { NextRequest, NextResponse } from 'next/server';
import { mapToCamel, preferRussianTitle } from '@/lib/anime-utils'; // F-08: без 6.1 МБ data.ts в холодном старте
import { withRateLimit } from '@/lib/with-rate-limit';
import { sanitizeSearchQuery } from '@/lib/validate';

async function searchHandler(request: NextRequest) {
  try {
    const q = sanitizeSearchQuery(new URL(request.url).searchParams.get('q'));
    if (!q.trim()) return NextResponse.json({ anime: [], total: 0 });

    // F-08: статический массив грузится лениво
    const { SFW_ANIME } = await import('@/lib/data');
    const ql = q.toLowerCase();
    const results = SFW_ANIME.filter(
      a =>
        a.title.toLowerCase().includes(ql) ||
        (a.title_russian && a.title_russian.toLowerCase().includes(ql)) ||
        a.genres.toLowerCase().includes(ql)
    ).map(a => ({ ...a, ...preferRussianTitle(a as unknown as Record<string, unknown>) }));

    return NextResponse.json({ anime: mapToCamel(results), total: results.length });
  } catch (error) {
    console.error('Search API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withRateLimit(searchHandler, '/api/search')
