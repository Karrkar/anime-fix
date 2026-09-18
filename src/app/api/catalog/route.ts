import { NextRequest, NextResponse } from 'next/server';
import { mapToCamel, preferRussianTitle } from '@/lib/anime-utils'; // F-08: mapToCamel больше не тянет за собой 6.1 МБ data.ts
import { withRateLimit } from '@/lib/with-rate-limit';
import { sanitizeSearchQuery } from '@/lib/validate';
import { getDb } from '@/lib/db';

// Сортировки каталога: whitelist (защита от произвольных column names)
const SORTS: Record<string, { column: string; ascending: boolean }> = {
  new: { column: 'created_at', ascending: false },
  popular: { column: 'views', ascending: false },
  score: { column: 'score', ascending: false },
  title: { column: 'title_russian', ascending: true },
  episodes: { column: 'episodes', ascending: false },
};

function dbAnimeToStatic(row: Record<string, unknown>) {
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
    // даты для бейджей «Обновлено сегодня» / полки «Свежее за неделю»
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function catalogHandler(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Math.min(parseInt(searchParams.get('page') || '1') || 1, 9999));
    const limit = Math.max(1, Math.min(parseInt(searchParams.get('limit') || '24') || 24, 100));
    const genre = sanitizeSearchQuery(searchParams.get('genre'));
    const type = sanitizeSearchQuery(searchParams.get('type'));
    const sortKey = searchParams.get('sort') || 'new';
    const sort = SORTS[sortKey] || SORTS.new;
    const fresh = searchParams.get('fresh') === '1';
    const offset = (page - 1) * limit;
    const weekAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Try to fetch new anime from Supabase first
    let dbAnime: Record<string, unknown>[] = [];
    let dbTotal = 0;
    let dbReachable = false;
    const hasFilters = !!genre || !!type || fresh || sortKey !== 'new';
    try {
      const db = getDb();

      // Get total count
      let countQuery = db
        .from('anime_catalog')
        .select('id', { count: 'exact', head: true })
        .eq('is_adult', false);
      if (genre) countQuery = countQuery.ilike('genres', `%${genre}%`);
      if (type) countQuery = countQuery.eq('type', type);
      if (fresh) countQuery = countQuery.or(`created_at.gte.${weekAgoIso},updated_at.gte.${weekAgoIso}`);
      const { count } = await countQuery;
      dbTotal = count || 0;
      dbReachable = true;

      // Get paginated results
      let query = db
        .from('anime_catalog')
        .select('*')
        .eq('is_adult', false);
      if (genre) query = query.ilike('genres', `%${genre}%`);
      if (type) query = query.eq('type', type);
      if (fresh) query = query.or(`created_at.gte.${weekAgoIso},updated_at.gte.${weekAgoIso}`);
      // Полка «Свежее за неделю»: сначала самые свежие обновления (у онгоингов
      // это вышедшие серии), новые тайтлы тоже наверху — у них updated_at = created_at.
      const orderCol = fresh ? 'updated_at' : sort.column;
      const orderAsc = fresh ? false : sort.ascending;
      const { data } = await query
        .order(orderCol, { ascending: orderAsc })
        .range(offset, offset + limit - 1);
      if (data) dbAnime = data as unknown as Record<string, unknown>[];

      // F-19 fix: БД, если она доступна, отвечает за ВСЕ страницы (глубокая
      // страница → пустой массив с корректным total). При применённых фильтрах
      // и пустом результате тоже отвечаем из БД (пусто — честный ответ, а не
      // нерелевантная статика). fresh=1 для статики неприменим — у статических
      // записей дат нет, полка «Свежее за неделю» строится только на БД.
      if (dbTotal > 0 || hasFilters) {
        return NextResponse.json({
          anime: mapToCamel(dbAnime.map(dbAnimeToStatic)),
          total: dbTotal, page,
          totalPages: Math.ceil(dbTotal / limit),
          source: 'database',
        });
      }
    } catch (e) {
      console.error('DB catalog fetch error (falling back to static):', e);
    }

    // Fallback to static data — F-08: 6.1 МБ data.ts загружается ТОЛЬКО здесь,
    // если БД недоступна/пуста. Холодный старт функции больше его не парсит.
    const { SFW_ANIME } = await import('@/lib/data');
    let filtered = SFW_ANIME;
    if (genre) {
      const gl = genre.toLowerCase();
      filtered = filtered.filter(a => a.genres.toLowerCase().includes(gl));
    }
    if (type) {
      filtered = filtered.filter(a => (a.type || '').toLowerCase() === type.toLowerCase());
    }
    if (fresh) filtered = []; // у статики нет дат — честный пустой ответ

    if (sortKey === 'title') filtered = [...filtered].sort((a, b) => (a.title_russian || a.title).localeCompare(b.title_russian || b.title, 'ru'));
    else if (sortKey === 'episodes') filtered = [...filtered].sort((a, b) => b.episodes - a.episodes);
    else if (sortKey === 'score') filtered = [...filtered].sort((a, b) => b.score - a.score);

    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit);

    return NextResponse.json({
      anime: mapToCamel(paged),
      total, page,
      totalPages: Math.ceil(total / limit),
      source: 'static',
    });
  } catch (error) {
    console.error('Catalog API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withRateLimit(catalogHandler, '/api/catalog')
