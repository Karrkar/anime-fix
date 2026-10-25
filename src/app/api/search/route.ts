import { NextRequest, NextResponse } from 'next/server';
import { mapToCamel, preferRussianTitle } from '@/lib/anime-utils';
import { withRateLimit } from '@/lib/with-rate-limit';
import { sanitizeSearchQuery } from '@/lib/validate';
import { getDb } from '@/lib/db';
import { BoundedTTLCache } from '@/lib/cache';

// ФИКС 26.10.2026 («поиск не находит 70% каталога»): раньше поиск шёл по
// СТАТИЧЕСКОМУ массиву SFW_ANIME (1558 тайтлов из бандла), который не знает
// про db-тайтлы из БД (5400+, весь архив vost.pw). Теперь — живой запрос
// к anime_catalog (ilike по title/title_russian/genres), статика остаётся
// фолбэком на случай недоступности БД.

// Кэш: запрос одинаковый → результат одинаковый до следующего деплоя/добавления
// тайтлов кронами. 10 минут в памяти + 10 минут на CDN (как раньше).
const searchCache = new BoundedTTLCache<string, string>(300, 10 * 60_000);
const SEARCH_CACHE_CTRL = 'public, max-age=600, s-maxage=600, stale-while-revalidate=1800';

const SEARCH_LIMIT = 50;
const SEARCH_COLUMNS =
  'vost_id, title_russian, title, description, image_url, type, episodes, genres, score, views, embed_url, source_url, created_at, updated_at';

// Маппинг строки БД в формат карточки — 1:1 с /api/catalog (dbAnimeToStatic),
// чтобы страница поиска рендерила карточки идентично каталогу
function dbAnimeToCard(row: Record<string, unknown>) {
  return {
    id: `db-${row.vost_id}`,
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
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

// Паттерн для PostgREST or-фильтра. Значения с запятыми/точками (названия
// тайтлов) обязаны идти в двойных кавычках, иначе запятая разорвёт фильтр.
// Кавычки и бэкслеши из пользовательского ввода вырезаются (sanitizer уже
// убрал скобки/звёздочки), % оставляем — это штатный LIKE-вейлдкард.
function orPattern(q: string): string {
  return `%${q.replace(/["\\]/g, '').trim()}%`;
}

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

    // 1) Живая БД: ilike по русскому/оригинальному названию и жанрам.
    //    Сортировка по просмотрам — популярное сверху (как «Популярное» каталога).
    try {
      const db = getDb();
      const p = orPattern(q);
      const { data, error } = await db
        .from('anime_catalog')
        .select(SEARCH_COLUMNS)
        .eq('is_adult', false)
        .or(`title.ilike."${p}",title_russian.ilike."${p}",genres.ilike."${p}"`)
        .order('views', { ascending: false })
        .limit(SEARCH_LIMIT);

      if (!error && data) {
        const body = JSON.stringify({
          anime: mapToCamel((data as unknown as Record<string, unknown>[]).map(dbAnimeToCard)),
          total: data.length,
          source: 'database',
        });
        searchCache.set(q, body);
        return new NextResponse(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': SEARCH_CACHE_CTRL },
        });
      }
      console.error('DB search error (falling back to static):', error);
    } catch (e) {
      console.error('DB search fetch error (falling back to static):', e);
    }

    // 2) Фолбэк на статику (БД недоступна) — прежняя логика без изменений
    const { SFW_ANIME } = await import('@/lib/data');
    const ql = q.toLowerCase();
    const results = SFW_ANIME.filter(
      a =>
        a.title.toLowerCase().includes(ql) ||
        (a.title_russian && a.title_russian.toLowerCase().includes(ql)) ||
        a.genres.toLowerCase().includes(ql)
    ).map(a => ({ ...a, ...preferRussianTitle(a as unknown as Record<string, unknown>) }));

    const body = JSON.stringify({ anime: mapToCamel(results), total: results.length, source: 'static' });
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
