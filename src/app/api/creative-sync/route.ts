import { NextRequest, NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/db';
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
 * Запускается 4 раза в день кронами + вручную из админки/E2E.
 */

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
): Promise<ChannelResult> {
  const res: ChannelResult = {
    channel, liveOk: false, freshAdded: 0, deepAdded: 0,
    postsTotal: 0, depthComplete: false, mirroredPosts: 0, mirroredImages: 0,
  };

  const depth = await loadDepth(channel);
  let posts: StoredCreativePost[] = depth?.posts || [];
  const beforeCount = posts.length;

  // 1) Свежий слой
  const fresh = await fetchChannelLayerLive(channel);
  res.liveOk = fresh !== null;
  if (fresh && fresh.length > 0) {
    const next = mergePosts(posts, fresh.map(r => normalizePost(r, channel)));
    res.freshAdded = next.length - beforeCount;
    posts = next;
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
    const next = mergePosts(posts, layer.map(r => normalizePost(r, channel)));
    res.deepAdded += Math.max(0, next.length - beforeCount - res.freshAdded - res.deepAdded);
    posts = next;
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
  const targets = channelParam ? [channelParam] : TG_CHANNELS.map(c => c.id);

  const results: ChannelResult[] = [];
  for (const ch of targets) {
    try {
      results.push(await walkChannel(ch, depthLayers, mirrorBudget));
    } catch (e) {
      console.error(`creative-sync walk (${ch}):`, e);
      results.push({
        channel: ch, liveOk: false, freshAdded: 0, deepAdded: 0,
        postsTotal: 0, depthComplete: false, mirroredPosts: 0, mirroredImages: 0,
      });
    }
  }

  const tookMs = Date.now() - t0;
  await recordSyncRun('creative_sync', {
    status: 'ok',
    details: {
      params: { channel: channelParam || 'all', depthLayers, mirrorBudget },
      tookMs,
      results,
    },
  });

  return NextResponse.json({
    ok: true,
    results,
    mirroredImagesTotal: results.reduce((a, r) => a + r.mirroredImages, 0),
    tookMs,
  });
}

export const GET = withRateLimit(creativeSyncHandler, '/api/creative-sync');
