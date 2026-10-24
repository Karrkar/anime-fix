/**
 * СИНХРОНИЗАЦИЯ ХРАНИЛИЩА rule34 (крон, задача «все арты с источников»).
 *
 * GET /api/r34-sync[?full=1&idx=<artist index>]
 *
 * Авторизация: Vercel Cron (Bearer CRON_SECRET) / ?secret= / админ-сессия.
 *
 * Что делает:
 *  1) Входное звено (без chain=1) — обновляет счётчики постов всех 14
 *     художников из публичного autocomplete api.rule34.xxx (доступен с
 *     любого IP, CORS открыт). В мете появляется честное «сколько постов
 *     у художника сейчас».
 *  2) Если заданы env R34_USER_ID + R34_API_KEY (бесплатный ключ
 *     rule34.xxx: аккаунт → account options → API key) — тянет посты через
 *     официальный dapi (1000 постов/запрос, JSON) и заливает в хранилище:
 *       ?full=1 — полный обход всех страниц всех художников (самоцепочкой,
 *                 по художателю за звено, 60с на звено);
 *       без full — первые 2000 постов каждого (новые посты за сутки).
 *     Звенья самоцепочки идут с chain=1 (без обновления счётчиков — их
 *     обновляет входное звено; экономит ~13с бюджета на каждое звено).
 *  3) Без ключа — только счётчики + запись статуса (посты добирает
 *     клиентский сборщик вкладки «Арты» с ключом пользователя, либо
 *     заливщик оператора scripts/r34_upload.mjs).
 */
import { NextResponse } from 'next/server';
import { authFromRequest, getDb } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { logEvent } from '@/lib/logger';
import { recordSyncRun } from '@/lib/sync-status';
import { buildChainUrl, fireChainNext } from '@/lib/sync-chain';
import { upsertArtistPosts, updateMetaCounts, getMeta, getAllMetas, R34_ARTISTS, PER_PAGE } from '@/lib/r34-store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface DapiPost {
  id?: number | string;
  preview_url?: string;
  file_url?: string;
  tags?: string;
  score?: number;
  rating?: string;
}

/** Теги из dapi (строка через пробел, snake_case) → ParsedPost (как список). */
function dapiToParsed(posts: DapiPost[], artistTag: string): import('@/lib/client-types').ParsedPost[] {
  const out: import('@/lib/client-types').ParsedPost[] = [];
  for (const p of posts) {
    const id = p.id != null ? String(p.id) : '';
    const thumb = typeof p.preview_url === 'string' ? p.preview_url : '';
    if (!/^\d{1,12}$/.test(id) || !thumb) continue;
    const rawTags = typeof p.tags === 'string' ? p.tags.split(/\s+/).filter(Boolean) : [];
    const tags: string[] = [];
    const seen = new Set<string>();
    for (const t of rawTags) {
      const normalized = t.replace(/_/g, ' ');
      if (!seen.has(normalized.toLowerCase())) {
        seen.add(normalized.toLowerCase());
        tags.push(normalized);
      }
    }
    const charTags = tags.filter(t => t.includes('('));
    const displayTitle = charTags.length > 0
      ? charTags.slice(0, 2).map(c => c.replace(/ \(.*\)$/, '')).join(', ')
      : tags.slice(0, 3).join(', ');
    const searchTagLower = artistTag.toLowerCase().replace(/_/g, ' ');
    const artist = tags.find(t => t.toLowerCase() === searchTagLower) ||
      tags.find(t => !t.includes('(') && t !== '1girl' && t !== '1boy' && !t.startsWith('ai ')) || 'Unknown';
    out.push({
      id,
      thumbnailUrl: thumb,
      tags,
      artist,
      characters: charTags.filter(t => !t.includes('fate') && !t.includes('series')).map(c => c.replace(/ \(.*\)$/, '')),
      score: typeof p.score === 'number' ? p.score : 0,
      rating: typeof p.rating === 'string' ? p.rating : 'explicit',
      title: displayTitle,
      postUrl: `https://rule34.xxx/index.php?page=post&s=view&id=${id}`,
      // file_url: мгновенный лайтбокс (без /api/rule34-post) + видео-детект
      ...(typeof p.file_url === 'string' && /^https?:\/\/[a-z0-9.-]+\.rule34\.xxx\//i.test(p.file_url)
        ? { fullUrl: p.file_url, isVideo: /\.(mp4|webm)(?:\?|$)/i.test(p.file_url) || tags.some(t => t.toLowerCase() === 'animated') }
        : {}),
    });
  }
  return out;
}

/** Точный счётчик постов тега из публичного autocomplete. */
async function fetchTagCount(tag: string): Promise<number> {
  try {
    const r = await fetch(`https://api.rule34.xxx/autocomplete.php?q=${encodeURIComponent(tag)}`, {
      headers: { 'User-Agent': 'AnimePlatformaSyncChain/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return 0;
    const list = (await r.json()) as Array<{ label?: string; value?: string }>;
    const exact = list.find(x => x.value === tag);
    const m = exact?.label?.match(/\((\d+)\)/);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

/** Одна страница dapi (limit=1000). Возвращает массив постов. */
async function dapiPage(tag: string, pid: number, userId: string, apiKey: string): Promise<DapiPost[]> {
  const url = `https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1&limit=1000&pid=${pid}` +
    `&tags=${encodeURIComponent(tag)}&user_id=${encodeURIComponent(userId)}&api_key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'AnimePlatformaSyncChain/1.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 401 || r.status === 403) throw new Error(`dapi auth ${r.status}`);
  if (!r.ok) throw new Error(`dapi http ${r.status}`);
  const text = await r.text();
  if (!text.trim().startsWith('[')) return []; // «нет постов» или пусто
  return JSON.parse(text) as DapiPost[];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const user = await authFromRequest(request);

  if (!isCronAuthorized(request) && !(user && user.role === 'admin')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const full = url.searchParams.get('full') === '1';
  const chained = url.searchParams.get('chain') === '1'; // звено цепочки: Step 1 не нужен
  const idx = Math.max(0, parseInt(url.searchParams.get('idx') || '0', 10) || 0);
  const userId = process.env.R34_USER_ID?.trim() || '';
  const apiKey = process.env.R34_API_KEY?.trim() || '';
  const budget = Date.now() + 45_000; // запас на upsert в maxDuration 60с

  // ── Шаг 1: свежие счётчики всех художников ────────────────────────
  // Входное звено (крон/ручной запуск без chain=1) — 14 запросов
  // autocomplete + запись мет (~13с). Звенья цепочки (chain=1) счётчики
  // уже имеют — берут из мет без внешних вызовов (инцидент 24.10:
  // Step 1 + 2 страницы dapi + merge 80 чанков balecxi не влезали в 60с).
  const counts: Record<string, number> = {};
  if (chained) {
    const metas = await getAllMetas();
    for (const m of metas) {
      if (m.total_posts > 0) counts[m.tag] = m.total_posts;
    }
  } else {
    for (const tag of R34_ARTISTS) {
      const c = await fetchTagCount(tag);
      if (c > 0) {
        counts[tag] = c;
        await updateMetaCounts(tag, c);
      }
    }
  }

  // ── Шаг 2: dapi-синк постов (если есть ключ) ───────────────────────
  if (userId && apiKey && idx < R34_ARTISTS.length) {
    const tag = R34_ARTISTS[idx];
    const collected: import('@/lib/client-types').ParsedPost[] = [];
    try {
      const maxPages = full ? Math.ceil((counts[tag] || 1000) / 1000) : 2;
      for (let p = 0; p < maxPages; p++) {
        if (Date.now() > budget) break;
        const raw = await dapiPage(tag, p, userId, apiKey);
        const parsed = dapiToParsed(raw, tag);
        if (parsed.length === 0) break;
        collected.push(...parsed);
        if (parsed.length < 1000) break; // дно достигнуто
        await new Promise(r => setTimeout(r, 400)); // вежливость к API
      }
      if (collected.length > 0) {
        const res = await upsertArtistPosts(tag, collected, counts[tag]);
        logEvent('r34_sync_artist', { tag, stored: res.stored_posts, complete: res.complete });
      }
    } catch (e) {
      logEvent('r34_sync_artist_fail', { tag, err: String(e).slice(0, 140) });
      await recordSyncRun('r34_sync', { status: 'error', error: String(e).slice(0, 200), details: { tag, idx } });
      return NextResponse.json({ ok: false, tag, error: String(e).slice(0, 160) }, { status: 502 });
    }

    // следующее звено цепочки — следующий художник.
    // fireChainNext (не самодельный after+fetch): UA обязателен — Cloudflare
    // челленджит безымянные запросы на кастомном домене (инцидент 22.10:
    // цепочки умирали каждые ~4 звена), таймаутить/прерывать запрос нельзя,
    // нужны повторы при 403/5xx. Прод-инцидент 24.10: самодельный after с
    // AbortSignal.timeout(5с) и без UA — цепочка умирала после 1-го звена.
    if (idx + 1 < R34_ARTISTS.length) {
      fireChainNext(buildChainUrl('/api/r34-sync', { full: full ? 1 : undefined, idx: idx + 1, chain: 1 }));
      return NextResponse.json({ ok: true, tag, stored: collected.length, next: idx + 1, counts });
    }

    await recordSyncRun('r34_sync', {
      status: 'ok',
      details: { mode: full ? 'full' : 'daily', counts, finished_at: new Date().toISOString() },
    });
    return NextResponse.json({ ok: true, done: true, counts });
  }

  // ── Без ключа: только счётчики + сводка по хранилищу ───────────────
  const storeSummary: Record<string, { stored: number; total: number; complete: boolean }> = {};
  for (const tag of R34_ARTISTS) {
    const m = await getMeta(tag);
    storeSummary[tag] = {
      stored: m?.stored_posts || 0,
      total: counts[tag] || m?.total_posts || 0,
      complete: m?.complete === true,
    };
  }
  const totalStored = Object.values(storeSummary).reduce((a, s) => a + s.stored, 0);
  const note = userId && apiKey ? undefined : 'нет R34_USER_ID/R34_API_KEY — только счётчики; посты добирает клиентский сборщик или заливщик';
  await recordSyncRun('r34_sync', {
    status: 'ok',
    details: { mode: 'counts-only', total_stored: totalStored, counts, note },
  });
  return NextResponse.json({ ok: true, mode: 'counts-only', total_stored: totalStored, per_artist: storeSummary, note, per_page: PER_PAGE });
}
