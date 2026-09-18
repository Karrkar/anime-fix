import { NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/with-rate-limit';
import { getDb } from '@/lib/db';

/**
 * GET /api/facets — справочник фильтров каталога: жанры, типы, счётчик свежего.
 *
 * Один лёгкий запрос select('genres,type,created_at') по is_adult=false
 * (агрегация жанров по строке через запятую делается в JS — значений ~тысячи,
 * это дешевле, чем материализованные таблицы). Результат для /api/catalog UI.
 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function facetsHandler() {
  try {
    const db = getDb();
    const { data, error } = await db
      .from('anime_catalog')
      .select('genres, type, created_at, updated_at')
      .eq('is_adult', false)
      .limit(5000);

    if (error || !data) {
      return NextResponse.json({ genres: [], types: [], fresh: 0, source: 'database-error' });
    }

    const genreCounts = new Map<string, number>();
    const typeCounts = new Map<string, number>();
    const weekAgo = Date.now() - WEEK_MS;
    let fresh = 0;

    for (const row of data as { genres: string | null; type: string | null; created_at: string | null; updated_at: string | null }[]) {
      const g = String(row.genres || '');
      if (g) {
        for (const raw of g.split(/[,;]\s*/)) {
          const name = raw.trim();
          if (!name || name === '18+' || name.toLowerCase() === 'хентай') continue;
          genreCounts.set(name, (genreCounts.get(name) || 0) + 1);
        }
      }
      const t = String(row.type || '').trim();
      if (t) typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
      // Свежее = добавлено ИЛИ обновлено за неделю (у онгоингов обновления = вышедшие серии)
      const c = row.created_at ? new Date(row.created_at).getTime() : 0;
      const u = row.updated_at ? new Date(row.updated_at).getTime() : 0;
      if ((c && c >= weekAgo) || (u && u >= weekAgo)) fresh++;
    }

    const genres = Array.from(genreCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));

    const types = Array.from(typeCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));

    return NextResponse.json({ genres, types, fresh, source: 'database' });
  } catch (e) {
    console.error('Facets DB error:', e);
    return NextResponse.json({ genres: [], types: [], fresh: 0, source: 'database-error' });
  }
}

export const GET = withRateLimit(facetsHandler, '/api/facets');
