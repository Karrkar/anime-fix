import { NextRequest, NextResponse } from 'next/server';
// F-08: 6.1 МБ data.ts больше не импортируется статически — только лениво ниже
import { withRateLimit } from '@/lib/with-rate-limit';
import { validateAnimeId } from '@/lib/validate';

function toCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = v;
  }
  return out;
}

async function episodesHandler(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const animeId = validateAnimeId(searchParams.get('animeId'));

    if (!animeId) {
      return NextResponse.json({ error: 'animeId is required' }, { status: 400 });
    }

    // F-08: ленивая загрузка статических данных
    const { findAnimeById } = await import('@/lib/data');
    const anime = findAnimeById(animeId);
    if (!anime) {
      return NextResponse.json({ error: 'Anime not found' }, { status: 404 });
    }

    const episodes = (anime as unknown as Record<string, unknown>).anime_episodes;
    if (!episodes || !Array.isArray(episodes)) {
      return NextResponse.json({ episodes: [] });
    }

    const camelEpisodes = episodes.map(ep => toCamel(ep as Record<string, unknown>));
    return NextResponse.json({ episodes: camelEpisodes });
  } catch (error) {
    console.error('Anime episodes API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withRateLimit(episodesHandler, '/api/anime-episodes')
