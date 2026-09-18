import { NextRequest, NextResponse } from 'next/server';
import { mapToCamel, preferRussianTitle } from '@/lib/anime-utils'; // F-08: без 6.1 МБ data.ts в холодном старте
import { withRateLimit } from '@/lib/with-rate-limit';
import { validateAnimeId } from '@/lib/validate';
import { getDb } from '@/lib/db';

function toCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null) {
      out[camel] = (v as Record<string, unknown>[]).map(toCamel);
    } else {
      out[camel] = v;
    }
  }
  return out;
}

function dbRowToAnime(row: Record<string, unknown>) {
  return {
    id: `db-${row.vost_id}`,
    // Русское название — основное, оригинал — в подзаголовок (preferRussianTitle)
    ...preferRussianTitle(row),
    title_japanese: null,
    description: row.description || '',
    image_url: row.image_url || '',
    type: row.type || 'ТВ',
    episodes: row.episodes || 0,
    genres: row.genres || '',
    status: '',
    score: row.score || 0,
    is_adult: false,
    sourceUrl: row.embed_url || row.source_url || '',
    // даты для бейджа «Обновлено сегодня» на карточках
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function animeHandler(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const limit = parseInt(searchParams.get('limit') || '0');
    const offset = parseInt(searchParams.get('offset') || '0');

    if (id) {
      const validId = validateAnimeId(id);
      if (!validId) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

      // Check DB first for dynamic anime
      if (validId.startsWith('db-')) {
        const vostId = parseInt(validId.replace('db-', ''), 10);
        const db = getDb();
        const { data } = await db.from('anime_catalog').select('*').eq('vost_id', vostId).maybeSingle();
        if (data) {
          return NextResponse.json({ anime: toCamel(dbRowToAnime(data as Record<string, unknown>)) });
        }
      }

      // F-08: статические данные грузим лениво, только если их реально запросили
      const { findAnimeById } = await import('@/lib/data');
      const anime = findAnimeById(validId);
      if (!anime) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ anime: toCamel(anime as unknown as Record<string, unknown>) });
    }

    // List mode with limit/offset — merge DB (new) + static
    if (limit > 0) {
      let dbAnime: Record<string, unknown>[] = [];
      try {
        const db = getDb();
        const { data } = await db
          .from('anime_catalog')
          .select('*')
          .eq('is_adult', false)
          .order('views', { ascending: false })
          .range(offset, offset + limit - 1);
        if (data) dbAnime = data as unknown as Record<string, unknown>[];
      } catch { /* fallback to static */ }

      if (dbAnime.length >= limit) {
        return NextResponse.json({
          anime: mapToCamel(dbAnime.map(dbRowToAnime)),
          total: dbAnime.length,
          source: 'database',
        });
      }

      // Fill remaining slots with static data (ленивый импорт — F-08)
      const { SFW_ANIME } = await import('@/lib/data');
      const staticOffset = Math.max(0, offset - dbAnime.length);
      const remaining = limit - dbAnime.length;
      const staticAnime = mapToCamel(SFW_ANIME.slice(staticOffset, staticOffset + remaining));
      const merged = [...mapToCamel(dbAnime.map(dbRowToAnime)), ...staticAnime];

      return NextResponse.json({
        anime: merged,
        total: merged.length,
        source: 'mixed',
      });
    }

    // F-08: ленивая загрузка статического массива вместо статического импорта
    const { SFW_ANIME } = await import('@/lib/data');
    return NextResponse.json({ anime: mapToCamel(SFW_ANIME), total: SFW_ANIME.length });
  } catch (error) {
    console.error('Anime API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withRateLimit(animeHandler, '/api/anime')
