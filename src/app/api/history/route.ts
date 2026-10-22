import { NextRequest, NextResponse } from 'next/server'
import { authFromRequest, getDb } from '@/lib/db'
import { withRateLimit } from '@/lib/with-rate-limit'
import { preferRussianTitle } from '@/lib/anime-utils'
import { validateAnimeId, validateEpisodeNumber } from '@/lib/validate'

// ВАЖНО: таблица в Supabase называется `history` (НЕ watch_history) —
// подтверждено логами PGRST205 «Perhaps you meant the table 'public.history'».
// Колонки: id, user_id, anime_id, episode_number, watched_at.

// ─── Преобразование строк БД и статических элементов в общий формат ─────
function dbRowToHistoryItem(row: Record<string, unknown>, watchedAt: string, episodeNumber: number | null) {
  const t = preferRussianTitle(row);
  return {
    id: `db-${row.vost_id}`,
    // Русское название — основное, оригинал — в подзаголовок (preferRussianTitle)
    title: t.title,
    title_japanese: null,
    titleRussian: t.title_russian,
    description: row.description || '',
    imageUrl: row.image_url || '',
    type: row.type || 'ТВ',
    episodes: row.episodes || 0,
    genres: row.genres || '',
    status: '',
    score: row.score || 0,
    isAdult: false,
    sourceUrl: row.embed_url || row.source_url || '',
    watchedAt,
    episodeNumber,
  }
}

function staticItemToHistoryItem(item: Record<string, unknown>, watchedAt: string, episodeNumber: number | null) {
  const t = preferRussianTitle(item);
  return {
    id: item.id,
    title: t.title,
    title_japanese: item.title_japanese ?? null,
    titleRussian: t.title_russian,
    description: item.description || '',
    imageUrl: item.image_url || '',
    type: item.type || 'ТВ',
    episodes: item.episodes || 0,
    genres: item.genres || '',
    status: item.status || '',
    score: item.score || 0,
    isAdult: Boolean(item.is_adult),
    sourceUrl: item.sourceUrl || '',
    watchedAt,
    episodeNumber,
  }
}

// ─── GET /api/history ──────────────────────────────────────────────
async function historyGetHandler(request: NextRequest) {
  try {
    const user = await authFromRequest(request)
    if (!user) {
      return NextResponse.json({ error: 'Не авторизован' }, { status: 401 })
    }

    const db = getDb()
    const { data: historyItems, error } = await db
      .from('history')
      .select('anime_id, episode_number, watched_at')
      .eq('user_id', user.id)
      .order('watched_at', { ascending: false })
      .limit(100)

    if (error) {
      console.error('History GET error:', error)
      return NextResponse.json({ error: 'Ошибка БД' }, { status: 500 })
    }

    // F-16 fix: раньше — до 100 отдельных запросов к anime_catalog подряд.
    // Теперь один batch-запрос `.in('vost_id', ids)`.
    // F-18 fix: элементы со статическими ID (не db-*) больше не выпадают
    // молча — подтягиваются из статических данных ленивым import.
    const dbVostIds: number[] = []
    const staticIds: string[] = []
    for (const h of (historyItems || [])) {
      const aid = h.anime_id || ''
      if (aid.startsWith('db-')) {
        const vostId = parseInt(aid.slice(3), 10)
        if (vostId) dbVostIds.push(vostId)
        else staticIds.push(aid)
      } else if (aid) {
        staticIds.push(aid)
      }
    }

    const byKey = new Map<string, Record<string, unknown>>()

    if (dbVostIds.length > 0) {
      const { data: rows, error: rowsErr } = await db
        .from('anime_catalog')
        .select('vost_id, title, title_russian, image_url, type, genres, score, description, embed_url, source_url, episodes')
        .in('vost_id', dbVostIds)
      if (rowsErr) {
        console.error('History GET rows error:', rowsErr)
        return NextResponse.json({ error: 'Ошибка БД' }, { status: 500 })
      }
      for (const r of rows || []) {
        byKey.set(`db-${(r as Record<string, unknown>).vost_id}`, r as Record<string, unknown>)
      }
    }

    if (staticIds.length > 0) {
      const { SFW_ANIME, ALL_HENTAI } = await import('@/lib/data')
      for (const item of [...SFW_ANIME, ...ALL_HENTAI] as unknown as Record<string, unknown>[]) {
        if (staticIds.includes(item.id as string)) byKey.set(item.id as string, item)
      }
    }

    const history = (historyItems || [])
      .map((h: { anime_id: string; episode_number: number | null; watched_at: string }) => {
        const row = byKey.get(h.anime_id)
        if (!row) return null
        return typeof (row as Record<string, unknown>).vost_id !== 'undefined'
          ? dbRowToHistoryItem(row, h.watched_at, h.episode_number)
          : staticItemToHistoryItem(row, h.watched_at, h.episode_number)
      })
      .filter(Boolean)

    return NextResponse.json({ history })
  } catch (e) {
    console.error('History GET error:', e)
    return NextResponse.json({ error: 'Ошибка сервера' }, { status: 500 })
  }
}

// ─── POST /api/history (upsert) ──────────────────────────────────────
async function historyPostHandler(request: NextRequest) {
  try {
    const user = await authFromRequest(request)
    if (!user) {
      return NextResponse.json({ error: 'Не авторизован' }, { status: 401 })
    }

    const { animeId, episodeNumber } = await request.json()
    const validId = validateAnimeId(animeId)
    if (!validId) {
      return NextResponse.json({ error: 'Некорректный animeId' }, { status: 400 })
    }

    const db = getDb()
    const epNum = validateEpisodeNumber(episodeNumber) || 1

    const { data: existing } = await db
      .from('history')
      .select('id')
      .eq('user_id', user.id)
      .eq('anime_id', animeId)
      .maybeSingle()


    if (existing) {
      const { error } = await db
        .from('history')
        .update({
          episode_number: epNum,
          watched_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
      if (error) {
        console.error('History POST update error:', error)
        return NextResponse.json({ error: 'Ошибка БД' }, { status: 500 })
      }
    } else {
      const { error } = await db
        .from('history')
        .insert({
          user_id: user.id,
          anime_id: validId,
          episode_number: epNum,
        })
      if (error) {
        console.error('History POST insert error:', error)
        return NextResponse.json({ error: 'Ошибка БД' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('History POST error:', e)
    return NextResponse.json({ error: 'Ошибка сервера' }, { status: 500 })
  }
}

export const GET = withRateLimit(historyGetHandler, '/api/history')
export const POST = withRateLimit(historyPostHandler, '/api/history')
