import { NextRequest, NextResponse } from 'next/server';
import { mapToCamel, preferRussianTitle } from '@/lib/anime-utils';
import { withRateLimit } from '@/lib/with-rate-limit';
import { validateAnimeId, sanitizeSearchQuery } from '@/lib/validate';
import { getDb } from '@/lib/db';

/**
 * GET /api/similar?id=<animeId>&limit=12 — «Похожее» по пересечению жанров.
 *
 * Для db-тайтлов — один SQL-запрос: OR по ilike для топ-5 жанров,
 * исключая сам тайтл, сортировка по просмотрам.
 * Для статических ID — пересечение жанров в JS по SFW_ANIME.
 */
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
  };
}

function splitGenres(genres: string | null | undefined): string[] {
  if (!genres) return [];
  return String(genres)
    .split(/[,;]\s*/)
    .map(g => g.trim())
    .filter(Boolean);
}

async function similarHandler(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = validateAnimeId(searchParams.get('id'));
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
    const limit = Math.max(1, Math.min(parseInt(searchParams.get('limit') || '12') || 12, 24));

    // ── DB-тайтл ────────────────────────────────────────────────────
    if (id.startsWith('db-')) {
      const vostId = parseInt(id.slice(3), 10);
      const db = getDb();
      const { data: self } = await db
        .from('anime_catalog')
        .select('vost_id, genres, is_adult')
        .eq('vost_id', vostId)
        .maybeSingle();

      if (self) {
        const genres = splitGenres((self as Record<string, unknown>).genres as string)
          .filter(g => g !== '18+' && g !== 'Хентай' && g !== 'хентай')
          .slice(0, 5)
          .map(g => sanitizeSearchQuery(g).replace(/[,%()]/g, ''))
          .filter(Boolean);

        if (genres.length > 0) {
          const orExpr = genres.map(g => `genres.ilike.%${g}%`).join(',');
          const { data } = await db
            .from('anime_catalog')
            .select('*')
            .eq('is_adult', false)
            .neq('vost_id', vostId)
            .or(orExpr)
            .order('views', { ascending: false })
            .range(0, limit - 1);
          if (data) {
            return NextResponse.json({ anime: mapToCamel((data as unknown as Record<string, unknown>[]).map(dbRowToAnime)), source: 'database' });
          }
        }
        return NextResponse.json({ anime: [], source: 'database' });
      }
      // db-ID не найден — попробуем как статический ниже
    }

    // ── Статический тайтл ───────────────────────────────────────────
    const { findAnimeById, SFW_ANIME } = await import('@/lib/data');
    const self = findAnimeById(id);
    if (!self) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const myGenres = new Set(splitGenres((self as unknown as Record<string, unknown>).genres as string));
    if (myGenres.size === 0) return NextResponse.json({ anime: [] });

    const scored = SFW_ANIME
      .filter(a => a.id !== id)
      .map(a => {
        const shared = splitGenres(a.genres).filter(g => myGenres.has(g)).length;
        return { a, shared };
      })
      .filter(x => x.shared > 0)
      .sort((x, y) => y.shared - x.shared)
      .slice(0, limit)
      .map(x => x.a);

    return NextResponse.json({ anime: mapToCamel(scored), source: 'static' });
  } catch (error) {
    console.error('Similar API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withRateLimit(similarHandler, '/api/similar');
