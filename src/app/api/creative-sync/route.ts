import { NextRequest, NextResponse } from 'next/server';
import { authFromRequest, getDb } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { withRateLimit } from '@/lib/with-rate-limit';
import { fetchChannelLayerLive, isKnownChannel, TG_CHANNELS } from '@/lib/telegram-arts';
import {
  DEPTH_CAP,
  loadDepth,
  mergePosts,
  mirrorPostMedia,
  normalizePost,
  saveDepth,
  type StoredCreativePost,
} from '@/lib/creative-store';
import { recordSyncRun } from '@/lib/sync-status';
import { logEvent } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/creative-sync?depth=1..8&mirror=0..80[&channel=<id>]
 *
 * Синк «Креатива» (Task 51). Ходок по каналу:
 *   1) свежий слой t.me (слияние, зеркала хранилища не затираются);
 *   2) до `depth` слоёв вглубь (before = minSaved-1); слой валиден, только
 *      если его максимум ниже minSaved — иначе считаем историю исчерпанной;
 *   3) зеркало-бюджет `mirror` картинок: сначала самым свежим незеркалированным;
 *   4) saveDepth + телеметрия в sync_status (creative_sync).
 *
 * Авторизация: Vercel Cron (Bearer CRON_SECRET) / ?secret= / админ-сессия.
 * Запускается кроном ежедневно + вручную из админки/E2E.
 *
 * ФИКС РОТАЦИИ (аудит 27.09.2026): Hobby-план даёт maxDuration=60с, а прежний
 * код шёл по 8 каналам подряд с зеркальным бюджетом 40 на канал — за минуту
 * успевали только ПЕРВЫЕ ДВА канала (pornofullp, art_Hub_ai), остальные 6
 * не синкались неделями (creative_depth_* стояли на 22.09). Теперь:
 *   ПЕРВЫЙ проход — свежий слой ВСЕХ каналов (walkChannel(ch,0,0), ~3с/канал,
 *   сохранение только если что-то добавилось) — фид каждого канала свежий;
 *   ВТОРОЙ проход — глубина+зеркала по РОТАЦИИ (курсор creative_rotation в
 *   sync_status, ≤12 зеркал на канал) — докручивается последующими запусками;
 *   ?channel=<id> — прежний режим полного обслуживания одного канала.
 */

/** Бюджеты времени (мс от старта хендлера): до этого времени можно НАЧИНАТЬ
 * следующий шаг. Сам шаг может занять больше — потому запас до maxDuration. */
const FRESH_BUDGET_MS = 30_000;
const DEEP_BUDGET_MS = 46_000;
/** Зеркал на канал в ротационном проходе (12 × ~1.5с ≈ 18с — один канал). */
const DEEP_MIRROR_PER_CHANNEL = 12;

const ROTATION_SOURCE = 'creative_rotation';

async function loadRotationCursor(): Promise<number> {
  try {
    const db = getDb();
    const { data } = await db
      .from('sync_status')
      .select('details')
      .eq('source', ROTATION_SOURCE)
      .maybeSingle();
    const cur = (data?.details as { cursor?: number } | null)?.cursor;
    const n = Number(cur);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) % TG_CHANNELS.length : 0;
  } catch {
    return 0;
  }
}

async function saveRotationCursor(cursor: number): Promise<void> {
  try {
    const db = getDb();
    const { error } = await db.from('sync_status').upsert({
      source: ROTATION_SOURCE,
      last_run_at: new Date().toISOString(),
      last_status: 'ok',
      new_items: 0,
      updated_items: 0,
      details: { cursor, savedAt: new Date().toISOString() },
      error: null,
    }, { onConflict: 'source' });
    if (error) console.error('saveRotationCursor:', error.message);
  } catch (e) {
    console.error('saveRotationCursor failed:', e);
  }
}

interface ChannelResult {
  channel: string;
  liveOk: boolean;
  freshAdded: number;
  deepAdded: number;
  postsTotal: number;
  depthComplete: boolean;
  mirroredPosts: number;
  mirroredImages: number;
}

async function walkChannel(
  channel: string,
  depthLayers: number,
  mirrorBudget: number,
  /** light=true — проход «только свежесть»: без глубины/зеркал; сохранение,
   *  только если что-то добавилось (иначе мегабайтные апсерты впустую). */
  light = false,
): Promise<ChannelResult> {
  const res: ChannelResult = {
    channel, liveOk: false, freshAdded: 0, deepAdded: 0,
    postsTotal: 0, depthComplete: false, mirroredPosts: 0, mirroredImages: 0,
  };

  const depth = await loadDepth(channel);
  let posts: StoredCreativePost[] = depth?.posts || [];
  const beforeCount = posts.length;

  // 1) Свежий слой (мусорные посты — текст/реклама/кросс-промо — отбрасываются)
  const fresh = await fetchChannelLayerLive(channel);
  res.liveOk = fresh !== null;
  if (fresh && fresh.length > 0) {
    const normalized = fresh
      .map(r => normalizePost(r, channel))
      .filter((p): p is StoredCreativePost => p !== null);
    if (normalized.length) {
      const next = mergePosts(posts, normalized);
      res.freshAdded = next.length - beforeCount;
      posts = next;
    }
  }

  // 2) Слои вглубь
  let layers = 0;
  let complete = depth?.complete || posts.length >= DEPTH_CAP;
  while (layers < depthLayers && posts.length < DEPTH_CAP && !complete) {
    const minSaved = posts.length ? posts[posts.length - 1].msgId : 0;
    if (!minSaved) break;
    const layer = await fetchChannelLayerLive(channel, minSaved - 1);
    if (layer === null) break;              // сеть/троттлинг — тише едешь
    if (layer === '') { complete = true; break; } // пол истории
    const layerMax = layer[0]?.msgId || 0;
    if (layerMax >= minSaved) { complete = true; break; } // t.me не отдал ниже
    const normalized = layer
      .map(r => normalizePost(r, channel))
      .filter((p): p is StoredCreativePost => p !== null);
    if (normalized.length) {
      const next = mergePosts(posts, normalized);
      res.deepAdded += Math.max(0, next.length - beforeCount - res.freshAdded - res.deepAdded);
      posts = next;
    }
    layers++;
  }
  if (posts.length >= DEPTH_CAP) complete = true;

  // 3) Зеркальный бюджет — сверху вниз по незеркалированным
  if (mirrorBudget > 0) {
    for (let i = 0; i < posts.length && res.mirroredImages < mirrorBudget; i++) {
      if (!posts[i].mirrored) {
        const before = posts[i].photos.filter(u => u).length;
        posts[i] = await mirrorPostMedia(posts[i]);
        const done = posts[i].photos.filter(u => u.includes('/storage/v1/object/public/covers/creative/')).length;
        if (done > 0) {
          res.mirroredPosts++;
          res.mirroredImages += done;
        }
        void before;
      }
    }
  }

  // 4) Сохранение + телеметрия
  posts.sort((a, b) => b.msgId - a.msgId);
  if (light && res.freshAdded === 0) {
    // Ничего не изменилось — состояние в БД уже актуально, не тратим
    // секунды на переписывание того же JSON (важно в 60с-бюджете Hobby).
    res.postsTotal = posts.length;
    res.depthComplete = complete && posts.length >= DEPTH_CAP;
    return res;
  }
  await saveDepth(channel, posts, complete);
  res.postsTotal = posts.length;
  res.depthComplete = complete && posts.length >= DEPTH_CAP;
  return res;
}

async function creativeSyncHandler(request: NextRequest) {
  // Авторизация: cron/secret ИЛИ админ-сессия (ручной запуск из E2E/админки)
  const user = await authFromRequest(request);
  const isAdmin = !!user && user.role === 'admin';
  if (!isCronAuthorized(request) && !isAdmin) {
    logEvent('cron_denied', { path: '/api/creative-sync' }, 'warn');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const t0 = Date.now();
  const { searchParams } = new URL(request.url);

  const depthParam = Number(searchParams.get('depth') ?? 2);
  const depthLayers = Math.max(0, Math.min(8, Number.isFinite(depthParam) ? Math.floor(depthParam) : 2));

  const mirrorParam = Number(searchParams.get('mirror') ?? 30);
  const mirrorBudget = Math.max(0, Math.min(80, Number.isFinite(mirrorParam) ? Math.floor(mirrorParam) : 30));

  const channelParam = searchParams.get('channel');
  if (channelParam && !isKnownChannel(channelParam)) {
    return NextResponse.json({ error: 'Unknown channel' }, { status: 400 });
  }

  // ── Ручной режим: один канал — полное обслуживание (как раньше) ──────
  if (channelParam) {
    const results: ChannelResult[] = [];
    try {
      results.push(await walkChannel(channelParam, depthLayers, mirrorBudget));
    } catch (e) {
      console.error(`creative-sync walk (${channelParam}):`, e);
      results.push({
        channel: channelParam, liveOk: false, freshAdded: 0, deepAdded: 0,
        postsTotal: 0, depthComplete: false, mirroredPosts: 0, mirroredImages: 0,
      });
    }
    const tookMs = Date.now() - t0;
    await recordSyncRun('creative_sync', {
      status: 'ok',
      details: { params: { channel: channelParam, depthLayers, mirrorBudget }, tookMs, results },
    });
    return NextResponse.json({ ok: true, results, tookMs });
  }

  // ── Проход 1: свежий слой ВСЕХ каналов (дёшево — фид свежий у всех) ──
  const freshResults: ChannelResult[] = [];
  let freshSkipped = 0;
  for (const ch of TG_CHANNELS) {
    if (Date.now() - t0 > FRESH_BUDGET_MS) {
      freshSkipped = TG_CHANNELS.length - freshResults.length;
      logEvent('creative_fresh_budget', { done: freshResults.length, total: TG_CHANNELS.length }, 'warn');
      break;
    }
    try {
      freshResults.push(await walkChannel(ch.id, 0, 0, true));
    } catch (e) {
      console.error(`creative-sync fresh (${ch.id}):`, e);
    }
  }

  // ── Проход 2: глубина+зеркала по РОТАЦИИ (курсор в sync_status) ──────
  const start = await loadRotationCursor();
  const deepResults: ChannelResult[] = [];
  let cursorNext = start;
  for (let step = 0; step < TG_CHANNELS.length; step++) {
    if (Date.now() - t0 > DEEP_BUDGET_MS) break;
    const idx = (start + step) % TG_CHANNELS.length;
    const ch = TG_CHANNELS[idx].id;
    try {
      deepResults.push(
        await walkChannel(ch, depthLayers, Math.min(mirrorBudget, DEEP_MIRROR_PER_CHANNEL)),
      );
    } catch (e) {
      console.error(`creative-sync deep (${ch}):`, e);
    }
    cursorNext = (idx + 1) % TG_CHANNELS.length;
    await saveRotationCursor(cursorNext);
  }
  // Ничего не успели в проход 2 (свежий проход съел бюджет) — сдвигаем
  // курсор на 1, чтобы завтра начать со следующего канала, а не залипать.
  if (deepResults.length === 0) {
    cursorNext = (start + 1) % TG_CHANNELS.length;
    await saveRotationCursor(cursorNext);
  }

  const tookMs = Date.now() - t0;
  await recordSyncRun('creative_sync', {
    status: 'ok',
    details: {
      params: { channel: 'rotation', depthLayers, mirrorBudget },
      tookMs,
      freshChannels: freshResults.length,
      freshSkipped,
      deepChannels: deepResults.map(r => r.channel),
      rotationCursor: cursorNext,
      fresh: freshResults,
      deep: deepResults,
    },
  });

  return NextResponse.json({
    ok: true,
    fresh: freshResults,
    deep: deepResults,
    rotationCursor: cursorNext,
    mirroredImagesTotal: deepResults.reduce((a, r) => a + r.mirroredImages, 0),
    tookMs,
  });
}

export const GET = withRateLimit(creativeSyncHandler, '/api/creative-sync');
