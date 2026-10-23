import { NextRequest, NextResponse } from 'next/server';
import { authFromRequest, getDb } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { withRateLimit } from '@/lib/with-rate-limit';
import { logEvent } from '@/lib/logger';
import { buildChainUrl, fireChainNext } from '@/lib/sync-chain';
import type { ParsedPost } from '@/lib/client-types';
import {
  R34_ARTISTS, PER_PAGE, getMeta, upsertArtistPosts, appendTailPosts, readChunkPublic,
} from '@/lib/r34-store';
import { fetchDapiPage } from '@/lib/r34-dapi';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/arts-sync?fresh=2&deep=6&chain=1&hops=6[&tag=<tag>]
 *
 * ЕЖЕДНЕВНАЯ ПОДГРУЗКА АРТОВ rule34 (18+ → «Арты», 14 источников) —
 * серверный синк БЕЗ ключа rule34 API: dapi через цепочку
 * direct (часть egress-IP Vercel проходит CF) → Jina Reader (~5K токенов
 * за 42 поста против 25K у HTML-списка). Дополняет /api/r34-sync (который
 * обновляет только счётчики, а посты ждёт от клиентского сборщика с ключом
 * пользователя) и заливщик оператора.
 *
 * Два прохода за звено:
 *
 *   1) FRESH — РОТАЦИЯ тегов (курсор r34_arts_fresh_cursor, 2-3 тега за
 *      звено): страницы pid 0 и 42 → upsertArtistPosts (полная переливка
 *      чанков, для больших тегов 10-25с — потому и ротация, а не все 14
 *      сразу). Если новых постов нет (батч уже в чанке c0) — переливка
 *      пропускается. НОВЫЕ АРТЫ КАЖДЫЙ ДЕНЬ гарантированы без юзеров.
 *
 *   2) DEEP — бэкфилл истории (курсор r34_arts_deep_cursor): страницы
 *      от stored_posts (первый незалитый пост) → appendTailPosts —
 *      хвостовое слияние O(1), не трогает голову. Так набираются «все
 *      ~143k постов» (3413 страниц) за считанные дни цепочки.
 *
 * САМОЦЕПОЧКА (chain=1&hops=N): после 45с сегмента пинает следующее звено
 * (паттерн sync-chain.ts) — каждый сегмент получает свежие 60 секунд,
 * курсоры переживают сбои, недоделанное продолжает следующий день.
 *
 * Авторизация: Vercel Cron (Bearer CRON_SECRET) / ?secret= / админ-сессия.
 */

const FRESH_BUDGET_MS = 30_000;   // свежая зона не должна съесть всё звено
const SEGMENT_BUDGET_MS = 45_000; // запас на слияния + fire следующего звена
const FRESH_CURSOR_SOURCE = 'r34_arts_fresh_cursor';
const DEEP_CURSOR_SOURCE = 'r34_arts_deep_cursor';
const TELEMETRY_SOURCE = 'r34_arts_sync';

interface TagReport {
  tag: string;
  action: 'fresh-upsert' | 'fresh-skip' | 'deep-append' | 'deep-complete' | 'skipped' | 'failed';
  added?: number;
  storedPosts?: number;
  totalPosts?: number;
  complete?: boolean;
  via?: string;
}

async function loadCursor(source: string): Promise<number> {
  try {
    const db = getDb();
    const { data } = await db.from('sync_status').select('details').eq('source', source).maybeSingle();
    const n = Number((data?.details as { cursor?: number } | null)?.cursor);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) % R34_ARTISTS.length : 0;
  } catch {
    return 0;
  }
}

async function saveCursor(source: string, cursor: number): Promise<void> {
  try {
    const db = getDb();
    const { error } = await db.from('sync_status').upsert({
      source,
      last_run_at: new Date().toISOString(),
      last_status: 'ok',
      new_items: 0,
      updated_items: 0,
      details: { cursor, savedAt: new Date().toISOString() },
      error: null,
    }, { onConflict: 'source' });
    if (error) console.error(`saveCursor(${source}):`, error.message);
  } catch (e) {
    console.error(`saveCursor(${source}) failed:`, e);
  }
}

/** Точный счётчик постов тега из публичного autocomplete rule34
 *  (api.rule34.xxx доступен с любого IP — им же пользуется /api/r34-sync). */
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

async function artsSyncHandler(request: NextRequest) {
  const user = await authFromRequest(request);
  const isAdmin = !!user && user.role === 'admin';
  if (!isCronAuthorized(request) && !isAdmin) {
    logEvent('cron_denied', { path: '/api/arts-sync' }, 'warn');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const t0 = Date.now();
  const { searchParams } = new URL(request.url);

  const freshParam = Number(searchParams.get('fresh') ?? 2);
  const freshTags = Math.max(0, Math.min(5, Number.isFinite(freshParam) ? Math.floor(freshParam) : 2));
  const deepParam = Number(searchParams.get('deep') ?? 6);
  const deepPages = Math.max(0, Math.min(24, Number.isFinite(deepParam) ? Math.floor(deepParam) : 6));
  const jbudgetParam = Number(searchParams.get('jbudget') ?? 12);
  const jinaBudget = Math.max(0, Math.min(40, Number.isFinite(jbudgetParam) ? Math.floor(jbudgetParam) : 12));
  const chain = searchParams.get('chain') === '1';
  const hopsParam = Number(searchParams.get('hops') ?? 6);
  const hops = Math.max(0, Math.min(12, Number.isFinite(hopsParam) ? Math.floor(hopsParam) : 6));
  const tagParam = searchParams.get('tag') || '';
  if (tagParam && !R34_ARTISTS.includes(tagParam as (typeof R34_ARTISTS)[number])) {
    return NextResponse.json({ error: 'Unknown tag' }, { status: 400 });
  }

  let jinaSpent = 0;
  const reports: TagReport[] = [];
  const hasKey = !!(process.env.R34_API_KEY?.trim() && process.env.R34_USER_ID?.trim());

  /** Одна dapi-страница тега. С ключом — 1000 постов/запрос (api.rule34.xxx,
   *  без CF/Jina); без ключа — 42 (direct → Jina). null = отказ. */
  const page = async (tag: string, pid: number, limit = 42): Promise<{ posts: ParsedPost[]; empty: boolean; via: string } | null> => {
    const dapi = await fetchDapiPage(tag, pid, { jinaAttempts: 1, limit });
    if (dapi.via === 'jina') jinaSpent++;
    if (dapi.via) return { posts: dapi.posts, empty: dapi.empty, via: dapi.via };
    return null;
  };

  /* ── Проход 1: FRESH — ротация тегов (новые посты дня) ─────────────── */
  const freshStart = tagParam ? R34_ARTISTS.indexOf(tagParam as (typeof R34_ARTISTS)[number]) : await loadCursor(FRESH_CURSOR_SOURCE);
  let freshIdx = freshStart;
  let freshDone = 0;
  for (let step = 0; step < R34_ARTISTS.length && freshDone < (tagParam ? 1 : freshTags); step++) {
    if (Date.now() - t0 > FRESH_BUDGET_MS || jinaSpent >= jinaBudget) break;
    const tag = R34_ARTISTS[(freshStart + step) % R34_ARTISTS.length];
    freshIdx = (freshStart + step) % R34_ARTISTS.length;
    try {
      // страницы pid 0 и 42 (свежая зона UI: первые 2 страницы грида)
      const batch: ParsedPost[] = [];
      let via = '';
      for (const pid of [0, PER_PAGE]) {
        const res = await page(tag, pid);
        if (!res) break;
        if (via === '') via = res.via;
        if (res.empty) break;
        batch.push(...res.posts);
      }
      if (batch.length === 0 && via === '') {
        reports.push({ tag, action: 'failed', via: 'unreachable' });
        continue;
      }
      // Нет новых постов (все id уже в c0) — переливка не нужна
      const c0 = await readChunkPublic(tag, 0);
      if (c0 && c0.length > 0) {
        const known = new Set(c0.map(p => p.id));
        if (batch.every(p => known.has(p.id))) {
          reports.push({ tag, action: 'fresh-skip', added: 0, storedPosts: c0.length });
          freshDone++;
          continue;
        }
      }
      const count = await fetchTagCount(tag);
      const res = await upsertArtistPosts(tag, batch, count || undefined);
      reports.push({
        tag, action: 'fresh-upsert', added: batch.length,
        storedPosts: res.stored_posts, totalPosts: res.total_posts, complete: res.complete, via,
      });
      freshDone++;
    } catch (e) {
      reports.push({ tag, action: 'failed', via: String(e).slice(0, 80) });
    }
  }
  if (!tagParam) await saveCursor(FRESH_CURSOR_SOURCE, (freshIdx + 1) % R34_ARTISTS.length);

  /* ── Проход 2: DEEP — бэкфилл истории (хвостовое слияние O(1)) ─────── */
  const deepStart = tagParam ? R34_ARTISTS.indexOf(tagParam as (typeof R34_ARTISTS)[number]) : await loadCursor(DEEP_CURSOR_SOURCE);
  let deepIdx = deepStart;
  let deepDone = 0;
  outer:
  for (let step = 0; step < R34_ARTISTS.length && deepDone < (tagParam ? R34_ARTISTS.length : (hasKey ? 10 : 4)); step++) {
    if (Date.now() - t0 > SEGMENT_BUDGET_MS || jinaSpent >= jinaBudget) break;
    const tag = R34_ARTISTS[(deepStart + step) % R34_ARTISTS.length];
    deepIdx = (deepStart + step) % R34_ARTISTS.length;
    try {
      const meta = await getMeta(tag);
      if (!meta || meta.stored_posts === 0) {
        reports.push({ tag, action: 'skipped', via: 'not initialized' });
        continue;
      }
      if (meta.complete) continue;

      const batch: ParsedPost[] = [];
      let empty = false;
      // С ключом — ОДИН запрос на 1000 постов за итерацию (полный бэкфилл
      // 143k за ~143 запроса); без ключа — deepPages × 42 поста
      const iterations = hasKey ? 1 : deepPages;
      const stepLimit = hasKey ? 1000 : PER_PAGE;
      for (let p = 0; p < iterations; p++) {
        if (Date.now() - t0 > SEGMENT_BUDGET_MS || (!hasKey && jinaSpent >= jinaBudget)) break;
        const res = await page(tag, meta.stored_posts + batch.length, stepLimit);
        if (!res) break; // транспорт отказал — тег продолжится в следующем звене
        if (res.empty) { empty = true; break; } // докопали до дна
        batch.push(...res.posts);
        if (res.posts.length < stepLimit) break; // короткая страница = конец списка
      }

      if (batch.length > 0) {
        const count = await fetchTagCount(tag);
        const res = await appendTailPosts(tag, batch, count || undefined);
        reports.push({
          tag, action: 'deep-append', added: res.added,
          storedPosts: res.stored_posts, totalPosts: count || meta.total_posts, complete: res.complete,
        });
        deepDone++;
      } else if (empty) {
        // Пустая страница за хранимым = история исчерпана; total мог дрейфнуть —
        // фиксируем complete через счётчик (stored ≥ total выполнится)
        const count = await fetchTagCount(tag);
        const res = await appendTailPosts(tag, [], count || meta.total_posts);
        // appendTail с пустым батчем не двигает stored — помечаем complete явно
        if (!res.complete) {
          const db = getDb();
          const fixed = { ...meta, total_posts: Math.min(count || meta.total_posts, meta.stored_posts), complete: true, updated_at: new Date().toISOString() };
          await db.from('sync_status').upsert({
            source: `r34_meta_${tag}`,
            last_run_at: fixed.updated_at,
            last_status: 'ok',
            new_items: 0,
            updated_items: 0,
            details: fixed as unknown as Record<string, unknown>,
            error: null,
          }, { onConflict: 'source' });
        }
        reports.push({ tag, action: 'deep-complete', storedPosts: meta.stored_posts, complete: true });
        deepDone++;
      }
      if (Date.now() - t0 > SEGMENT_BUDGET_MS) break outer;
    } catch (e) {
      reports.push({ tag, action: 'failed', via: String(e).slice(0, 80) });
    }
  }
  if (!tagParam) await saveCursor(DEEP_CURSOR_SOURCE, (deepIdx + 1) % R34_ARTISTS.length);

  const tookMs = Date.now() - t0;
  const summary = {
    ok: true,
    tookMs,
    params: { freshTags, deepPages, jinaBudget, chain, hops, tag: tagParam || null },
    jinaSpent,
    reports,
    totals: {
      added: reports.reduce((a, r) => a + (r.added || 0), 0),
      completeTags: reports.filter(r => r.complete).length,
    },
  };

  // Телеметрия в sync_status (админка «last sync» + диагностика без логов)
  try {
    const db = getDb();
    await db.from('sync_status').upsert({
      source: TELEMETRY_SOURCE,
      last_run_at: new Date().toISOString(),
      last_status: 'ok',
      new_items: summary.totals.added,
      updated_items: 0,
      details: summary as unknown as Record<string, unknown>,
      error: null,
    }, { onConflict: 'source' });
  } catch (e) {
    console.error('arts-sync telemetry failed:', e);
  }

  // Самоцепочка: пока не всё докопано и есть hops — следующее звено
  // продолжит с курсоров (каждое получает свежие 60 секунд)
  const incomplete = await Promise.all(R34_ARTISTS.map(async t => {
    const m = await getMeta(t);
    return !m || !m.complete;
  }));
  if (chain && hops > 0 && incomplete.some(Boolean) && !tagParam) {
    const nextUrl = buildChainUrl('/api/arts-sync', {
      fresh: 0, deep: deepPages, jbudget: jinaBudget, chain: 1, hops: hops - 1,
    });
    fireChainNext(nextUrl);
    return NextResponse.json({ ...summary, chainNext: true, hopsLeft: hops - 1 });
  }

  return NextResponse.json(summary);
}

export const GET = withRateLimit(artsSyncHandler, '/api/arts-sync');
