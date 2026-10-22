// Серверные данные для главной (SSR).
//
// Зачем: раньше полки «Популярное» / «Свежее за неделю» / «Новинки» грузились
// ТОЛЬКО на клиенте (useEffect → /api/*), поэтому в HTML главной были одни
// скелетоны: если у посетителя не выполнялся JS (устаревший кэш чанков после
// деплоя, медленная сеть, сбой гидрации) — центральная область оставалась
// пустой. Теперь page.tsx запрашивает те же данные на сервере и отдаёт их
// прямо в HTML: контент виден мгновенно, JS только оживляет страницу.
//
// Логика повторяет API один-в-один, чтобы SSR и клиентский рефетч в HomePage
// показывали одно и то же (после гидрации данные бесшовно обновляются):
//   trending/recent → /api/anime?limit=12&offset=0|12  (is_adult=false, views desc)
//   fresh           → /api/catalog?sort=new&fresh=1     (обновлённое за 7 дней)
import { getDb } from '@/lib/db';
import { preferRussianTitle } from '@/lib/anime-utils';
import type { Anime, HomeInitialData } from '@/lib/client-types';

// Тот же маппинг полей, что dbRowToAnime (/api/anime) и dbAnimeToStatic
// (/api/catalog): через preferRussianTitle (кириллица = основное название)
// и в клиентской camelCase-форме (imageUrl, createdAt, sourceUrl…).
function rowToClientAnime(row: Record<string, unknown>): Anime {
  const ru = preferRussianTitle(row);
  return {
    id: `db-${row.vost_id}`,
    title: ru.title,
    titleRussian: ru.title_russian,
    titleJapanese: null,
    description: String(row.description || ''),
    imageUrl: String(row.image_url || ''),
    type: String(row.type || 'ТВ'),
    episodes: Number(row.episodes) || 0,
    genres: String(row.genres || ''),
    status: '',
    score: Number(row.score) || 0,
    isAdult: false,
    sourceUrl: String(row.embed_url || row.source_url || ''),
    createdAt: (row.created_at as string) || null,
    updatedAt: (row.updated_at as string) || null,
  };
}

const TTL_MS = 60_000; // как listCache в API: контент меняется только кронами синка
let cached: { at: number; data: HomeInitialData } | null = null;

export async function getHomeInitialData(): Promise<HomeInitialData | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;
  try {
    const db = getDb();
    const weekAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const list = () => db.from('anime_catalog').select('*').eq('is_adult', false);
    const [trendingRes, freshRes, recentRes] = await Promise.all([
      list().order('views', { ascending: false }).range(0, 11),
      list().or(`created_at.gte.${weekAgoIso},updated_at.gte.${weekAgoIso}`).order('updated_at', { ascending: false }).range(0, 11),
      list().order('views', { ascending: false }).range(12, 23),
    ]);
    const data: HomeInitialData = {
      trending: (trendingRes.data || []).map(rowToClientAnime),
      fresh: (freshRes.data || []).map(rowToClientAnime),
      recent: (recentRes.data || []).map(rowToClientAnime),
    };
    cached = { at: Date.now(), data };
    return data;
  } catch {
    // БД недоступна (сборка без env, авария Supabase) — главная откатывается
    // к прежнему поведению: клиентская загрузка через /api/* + скелетоны.
    return cached?.data ?? null;
  }
}
