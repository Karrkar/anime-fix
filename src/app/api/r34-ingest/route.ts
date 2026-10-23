/**
 * ПРИЁМ ДАННЫХ rule34 В ХРАНИЛИЩЕ (задача «все арты с указанных источников»).
 *
 * POST { tag, posts: ParsedPost[], totalPosts?: number }
 *
 * Кто пишет:
 *  1) Клиентский сборщик вкладки «Арты» (браузер пользователя с его
 *     rule34 user_id+api_key дергает dapi напрямую — CORS у api.rule34.xxx
 *     открыт (Access-Control-Allow-Origin: *), а с резидентного IP
 *     Cloudflare не челленджит) и батчами присылает посты сюда.
 *  2) Ручной заливщик scripts/r34_upload.mjs (service-role из песочницы).
 *
 * Гейт: 18+ (возраст + подписка) — тот же, что у /api/rule34.
 */
import { NextResponse } from 'next/server';
import { checkAdultAccess } from '@/lib/adult-access';
import { logEvent } from '@/lib/logger';
import { upsertArtistPosts, R34_ARTISTS } from '@/lib/r34-store';

export const maxDuration = 60;

interface IncomingPost {
  id?: unknown;
  thumbnailUrl?: unknown;
  tags?: unknown;
  artist?: unknown;
  characters?: unknown;
  score?: unknown;
  rating?: unknown;
  title?: unknown;
  postUrl?: unknown;
}

/** Валидация и нормализация поста от клиента (никогда не доверяем вводу). */
function normalizePost(p: IncomingPost) {
  if (!p || typeof p !== 'object') return null;
  const id = typeof p.id === 'string' && /^\d{1,12}$/.test(p.id) ? p.id : null;
  const thumb = typeof p.thumbnailUrl === 'string' ? p.thumbnailUrl : '';
  if (!id || !/^https?:\/\/[a-z0-9.-]+\.rule34\.xxx\//i.test(thumb)) return null;
  const tags = Array.isArray(p.tags)
    ? p.tags.filter((t): t is string => typeof t === 'string').slice(0, 120).map(t => t.slice(0, 80))
    : [];
  const characters = Array.isArray(p.characters)
    ? p.characters.filter((t): t is string => typeof t === 'string').slice(0, 40).map(t => t.slice(0, 80))
    : [];
  return {
    id: id as string,
    thumbnailUrl: thumb.slice(0, 300),
    tags,
    artist: typeof p.artist === 'string' ? p.artist.slice(0, 80) : 'Unknown',
    characters,
    score: typeof p.score === 'number' && Number.isFinite(p.score) ? Math.trunc(p.score) : 0,
    rating: typeof p.rating === 'string' ? p.rating.slice(0, 20) : 'explicit',
    title: typeof p.title === 'string' ? p.title.slice(0, 160) : '',
    postUrl: typeof p.postUrl === 'string' && /^https?:\/\/rule34\.xxx\//i.test(p.postUrl)
      ? p.postUrl.slice(0, 200)
      : `https://rule34.xxx/index.php?page=post&s=view&id=${id}`,
  };
}

export async function POST(request: Request) {
  const access = await checkAdultAccess(request, '/api/r34-ingest');
  if (!access.ok) return access.response;

  let body: { tag?: unknown; posts?: unknown; totalPosts?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const tag = typeof body.tag === 'string' ? body.tag.toLowerCase() : '';
  if (!(R34_ARTISTS as readonly string[]).includes(tag)) {
    return NextResponse.json({ error: 'Unknown artist tag', allowed: R34_ARTISTS }, { status: 400 });
  }
  if (!Array.isArray(body.posts) || body.posts.length === 0) {
    return NextResponse.json({ error: 'posts must be a non-empty array' }, { status: 400 });
  }
  if (body.posts.length > 1200) {
    return NextResponse.json({ error: 'Too many posts per request (max 1200)' }, { status: 413 });
  }
  const totalPosts = typeof body.totalPosts === 'number' && body.totalPosts > 0
    ? Math.min(Math.trunc(body.totalPosts), 500_000)
    : undefined;

  const normalized = (body.posts as IncomingPost[])
    .map(normalizePost)
    .filter((p): p is NonNullable<ReturnType<typeof normalizePost>> => p !== null);

  if (normalized.length === 0) {
    return NextResponse.json({ error: 'No valid posts in batch' }, { status: 400 });
  }

  try {
    const result = await upsertArtistPosts(tag, normalized, totalPosts);
    logEvent('r34_ingest', { tag, received: body.posts.length, accepted: normalized.length, stored: result.stored_posts });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    logEvent('r34_ingest_fail', { tag, err: String(e).slice(0, 160) });
    return NextResponse.json({ error: 'Store upsert failed', detail: String(e).slice(0, 160) }, { status: 500 });
  }
}
