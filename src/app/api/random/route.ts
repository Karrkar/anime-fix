import { NextResponse } from 'next/server';
import { mapToCamel, preferRussianTitle } from '@/lib/anime-utils';
import { withRateLimit } from '@/lib/with-rate-limit';
import { getDb } from '@/lib/db';

/**
 * GET /api/random — случайный тайтл из каталога (is_adult=false).
 *
 * DB-first: count → случайный offset → одна строка (два дешёвых запроса).
 * Если БД недоступна/пуста — случайный тайтл из статического массива.
 */
async function randomHandler() {
  try {
    const db = getDb();
    const { count } = await db
      .from('anime_catalog')
      .select('*', { count: 'exact', head: true })
      .eq('is_adult', false);

    if (count && count > 0) {
      const idx = Math.floor(Math.random() * count);
      const { data } = await db
        .from('anime_catalog')
        .select('*')
        .eq('is_adult', false)
        .range(idx, idx);
      const row = data?.[0] as Record<string, unknown> | undefined;
      if (row) {
        return NextResponse.json({
          anime: mapToCamel([{
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
          }])[0],
          source: 'database',
        });
      }
    }
  } catch (e) {
    console.error('Random DB error (falling back to static):', e);
  }

  // Статический fallback
  const { SFW_ANIME } = await import('@/lib/data');
  if (SFW_ANIME.length === 0) {
    return NextResponse.json({ error: 'Catalog is empty' }, { status: 404 });
  }
  const pick = SFW_ANIME[Math.floor(Math.random() * SFW_ANIME.length)];
  const pickRu = preferRussianTitle(pick as unknown as Record<string, unknown>);
  return NextResponse.json({ anime: mapToCamel([{ ...pick, ...pickRu }])[0], source: 'static' });
}

export const GET = withRateLimit(randomHandler, '/api/random');
