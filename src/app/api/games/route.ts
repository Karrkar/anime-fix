import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withRateLimit } from '@/lib/with-rate-limit';
import { sanitizeSearchQuery } from '@/lib/validate';
import { checkAdultAccess } from '@/lib/adult-access'; // 18+ = возраст + подписка

async function gamesHandler(request: NextRequest) {
  try {
    // F-15 fix: игры — adult-контент (is_adult=true в БД), серверный гейт обязателен.
    // Усилено: теперь требуется ещё и активная подписка (18+ по подписке).
    const access = await checkAdultAccess(request, '/api/games');
    if (!access.ok) return access.response;
    const { searchParams } = new URL(request.url);
    const limit = Math.max(1, Math.min(parseInt(searchParams.get('limit') || '100') || 100, 200));
    const offset = Math.max(0, Math.min(parseInt(searchParams.get('offset') || '0') || 0, 5000));
    const q = sanitizeSearchQuery(searchParams.get('q'));

    const db = getDb();
    // F-24 fix: count задан в первом select (канонический порядок supabase-js);
    // вызов select после range не проходил проверку типов (TS2554)
    let query = db
      .from('anime_catalog')
      .select('*', { count: 'exact' })
      .eq('type', 'Игра')
      .eq('is_adult', true)
      .order('created_at', { ascending: false });

    if (q) query = query.or(`title.ilike.%${q}%,title_russian.ilike.%${q}%`);

    const { data, count } = await query.range(offset, offset + limit - 1);

    if (!data) {
      return NextResponse.json({ games: [], total: 0 });
    }

    const games = data.map((row: Record<string, unknown>) => {
      const genres = (row.genres || '') as string;
      let source = '';
      if (genres.includes('feelex')) source = 'feelex';
      else if (genres.includes('xxx-igra')) source = 'xxx-igra';

      return {
        id: `game-${row.vost_id}`,
        title: (row.title || '') as string,
        titleRussian: (row.title_russian || '') as string,
        description: (row.description || '') as string,
        imageUrl: (row.image_url || '') as string,
        sourceUrl: (row.embed_url || row.source_url || '') as string,
        source,
      };
    });

    return NextResponse.json({ games, total: count || games.length });
  } catch (error) {
    console.error('Games API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withRateLimit(gamesHandler, '/api/games');
