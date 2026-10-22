import { NextRequest, NextResponse } from 'next/server'
import { authFromRequest, getDb } from '@/lib/db'
import { withRateLimit } from '@/lib/with-rate-limit'
import { preferRussianTitle } from '@/lib/anime-utils'
import { validateAnimeId } from '@/lib/validate'

// ─── Преобразование строк БД и статических элементов в общий формат ─────
function dbRowToFavorite(row: Record<string, unknown>) {
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
  }
}

function staticItemToFavorite(item: Record<string, unknown>) {
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
  }
}

// ─── GET /api/favorites ──────────────────────────────────────
async function favoritesGetHandler(request: NextRequest) {
  try {
    const user = await authFromRequest(request)
    if (!user) {
      return NextResponse.json({ error: 'Не авторизован' }, { status: 401 })
    }

    const db = getDb()
    const { data: favs, error } = await db
      .from('favorites')
      .select('anime_id')
      .eq('user_id', user.id)

    if (error) {
      console.error('Favorites GET error:', error)
      return NextResponse.json({ error: 'Ошибка БД' }, { status: 500 })
    }

    // F-16 fix: раньше — по одному запросу на каждую позицию (до 100 запросов
    // подряд). Теперь один batch-запрос `.in('vost_id', ids)`.
    // F-18 fix: позиции со статическими ID (не db-*) больше не теряются —
    // подтягиваются из статических данных ленивым import.
    const favIds = (favs || []).map((f: { anime_id: string }) => f.anime_id)

    const dbVostIds: number[] = []
    const staticIds: string[] = []
    for (const fid of favIds) {
      if (typeof fid === 'string' && fid.startsWith('db-')) {
        const n = parseInt(fid.slice(3), 10)
        if (Number.isFinite(n)) dbVostIds.push(n)
        else staticIds.push(fid)
      } else if (typeof fid === 'string') {
        staticIds.push(fid)
      }
    }

    const byKey = new Map<string, Record<string, unknown>>()

    if (dbVostIds.length > 0) {
      const { data: rows, error: rowsErr } = await db
        .from('anime_catalog')
        .select('vost_id, title, title_russian, description, image_url, type, episodes, genres, score, embed_url, source_url')
        .in('vost_id', dbVostIds)
      if (rowsErr) {
        console.error('Favorites GET rows error:', rowsErr)
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

    // Порядок сохраняем исходный (как записано в favorites)
    const favorites = favIds
      .filter((fid: string) => byKey.has(fid))
      .map((fid: string) => {
        const row = byKey.get(fid)!
        return typeof (row as Record<string, unknown>).vost_id !== 'undefined'
          ? dbRowToFavorite(row)
          : staticItemToFavorite(row)
      })

    return NextResponse.json({ favorites })
  } catch (e) {
    console.error('Favorites GET error:', e)
    return NextResponse.json({ error: 'Ошибка сервера' }, { status: 500 })
  }
}

// ─── POST /api/favorites (add) ───────────────────────────────────────
async function favoritesPostHandler(request: NextRequest) {
  try {
    const user = await authFromRequest(request)
    if (!user) {
      return NextResponse.json({ error: 'Не авторизован' }, { status: 401 })
    }

    const { animeId } = await request.json()
    const validId = validateAnimeId(animeId)
    if (!validId) {
      return NextResponse.json({ error: 'Некорректный animeId' }, { status: 400 })
    }

    const db = getDb()
    const { error } = await db
      .from('favorites')
      .upsert({ user_id: user.id, anime_id: validId }, { onConflict: 'user_id,anime_id' })

    if (error) {
      const { error: insertErr } = await db
        .from('favorites')
        .insert({ user_id: user.id, anime_id: validId })
      if (insertErr) {
        console.error('Favorites POST error:', insertErr)
        return NextResponse.json({ error: 'Ошибка БД' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Favorites POST error:', e)
    return NextResponse.json({ error: 'Ошибка сервера' }, { status: 500 })
  }
}

// ─── DELETE /api/favorites ───────────────────────────────────────────
async function favoritesDeleteHandler(request: NextRequest) {
  try {
    const user = await authFromRequest(request)
    if (!user) {
      return NextResponse.json({ error: 'Не авторизован' }, { status: 401 })
    }

    const { animeId } = await request.json()
    const validId = validateAnimeId(animeId)
    if (!validId) {
      return NextResponse.json({ error: 'Некорректный animeId' }, { status: 400 })
    }

    const db = getDb()
    const { error } = await db
      .from('favorites')
      .delete()
      .eq('user_id', user.id)
      .eq('anime_id', validId)

    if (error) {
      console.error('Favorites DELETE error:', error)
      return NextResponse.json({ error: 'Ошибка БД' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Favorites DELETE error:', e)
    return NextResponse.json({ error: 'Ошибка сервера' }, { status: 500 })
  }
}

export const GET = withRateLimit(favoritesGetHandler, '/api/favorites')
export const POST = withRateLimit(favoritesPostHandler, '/api/favorites')
export const DELETE = withRateLimit(favoritesDeleteHandler, '/api/favorites')