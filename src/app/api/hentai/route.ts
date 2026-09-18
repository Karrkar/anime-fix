import { NextRequest, NextResponse } from 'next/server';
import { mapToCamel, preferRussianTitle } from '@/lib/anime-utils'; // F-08: без 6.1 МБ data.ts в холодном старте
import { withRateLimit } from '@/lib/with-rate-limit';
import { sanitizeSearchQuery } from '@/lib/validate';
import { checkAdultAccess } from '@/lib/adult-access'; // 18+ = возраст + подписка
import { getDb } from '@/lib/db';

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
    is_adult: true,
    sourceUrl: row.embed_url || row.source_url || '',
  };
}

async function hentaiHandler(request: NextRequest) {
  try {
    // 18+ по подписке: серверная проверка возраста И активной подписки
    const access = await checkAdultAccess(request, '/api/hentai');
    if (!access.ok) return access.response;

    // F-08: статический массив грузится лениво (в этом роуте нужен всегда — merge DB+static)
    const { ALL_HENTAI } = await import('@/lib/data');
    const { searchParams } = new URL(request.url);
    const limit = Math.max(1, Math.min(parseInt(searchParams.get('limit') || '200') || 200, 200));
    const offset = Math.max(0, Math.min(parseInt(searchParams.get('offset') || '0') || 0, 10000));
    const genre = sanitizeSearchQuery(searchParams.get('genre'));
    const q = sanitizeSearchQuery(searchParams.get('q'));

    // Try DB first for new 18+ anime. F-17 fix: берём count всей выборки,
    // чтобы offset корректно проходил через стык DB/статика.
    //
    // ФИКС «плеер хентай не работает», часть 2: в anime_catalog накопился
    // мусор от старых синков — 255 записей 18+ с embed_url на t.me
    // (телеграм-спам: 〰️〰️ заголовки, нерабочие ссылки). Такие записи
    // не играются ни одним плеером и засоряли каталог. Показываем из DB
    // только записи с источником hentaibaza.com — их умеет играть
    // /api/hb-player (страницы /watch/N) и статика с CDN mp4.
    let dbAnime: Record<string, unknown>[] = [];
    let dbTotal = 0;
    try {
      const db = getDb();
      // F-24 fix: count задан в первом select (канонический порядок supabase-js)
      let query = db
        .from('anime_catalog')
        .select('*', { count: 'exact' })
        .eq('is_adult', true)
        .neq('type', 'Игра')
        .like('embed_url', 'https://hentaibaza.com/%') // только играбельное
        .order('created_at', { ascending: false });

      if (genre) query = query.ilike('genres', `%${genre}%`);
      if (q) query = query.or(`title.ilike.%${q}%,title_russian.ilike.%${q}%`);

      const { data, count } = await query.range(offset, offset + limit - 1);
      if (data) dbAnime = data as unknown as Record<string, unknown>[];
      dbTotal = count || 0;
    } catch (e) {
      console.error('DB hentai fetch error:', e);
    }

    // Статика: полный отфильтрованный список (фильтры — только на статике,
    // DB уже отфильтрован в SQL)
    let staticItems = [...ALL_HENTAI];
    if (genre) {
      staticItems = staticItems.filter((a) => {
        const genres = (a.genres || '').split(/[,;]\s*/).map((g: string) => g.trim().toLowerCase());
        return genres.includes(genre.toLowerCase());
      });
    }
    if (q) {
      const query = q.toLowerCase();
      staticItems = staticItems.filter((a: { title: string; title_russian?: string | null; genres: string }) =>
        a.title.toLowerCase().includes(query) ||
        (a.title_russian && a.title_russian.toLowerCase().includes(query)) ||
        (a.genres && a.genres.toLowerCase().includes(query))
      );
    }

    // F-17 fix: раньше offset применялся только к DB-части, а статика всегда
    // выдавалась с начала (paged = items.slice(0, limit)) — страницы 2+ показывали
    // те же статические элементы. Теперь offset делится между источниками:
    // первые dbTotal позиций — из DB, дальше — из статики.
    const total = dbTotal + staticItems.length;
    const staticStart = Math.max(0, offset - dbTotal);
    const takeStatic = Math.max(0, limit - dbAnime.length);
    const paged = [
      ...dbAnime.map(dbRowToAnime),
      ...staticItems.slice(staticStart, staticStart + takeStatic).map(a => ({ ...a, ...preferRussianTitle(a as unknown as Record<string, unknown>) })),
    ];

    // Extract unique genres
    const allGenres = new Set<string>();
    ALL_HENTAI.forEach(a => {
      (a.genres || '').split(/[,;]\s*/).forEach((g: string) => {
        const trimmed = g.trim();
        if (trimmed && trimmed !== '18+' && trimmed !== 'Хентай') allGenres.add(trimmed);
      });
    });

    return NextResponse.json({
      anime: mapToCamel(paged),
      total,
      offset,
      limit,
      genres: Array.from(allGenres).sort()
    });
  } catch (error) {
    console.error('Hentai API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withRateLimit(hentaiHandler, '/api/hentai')