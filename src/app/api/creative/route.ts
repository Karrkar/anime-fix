import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { checkAdultAccess } from '@/lib/adult-access';
import { fetchChannelPosts, fetchChannelLayerLive, isKnownChannel, TG_CHANNELS } from '@/lib/telegram-arts';
import {
  DEPTH_CAP,
  MERGE_PAGE,
  PAGE_SIZE,
  loadDepth,
  mirrorPostMedia,
  normalizePost,
  pageFromRow,
  saveDepth,
  toClientPost,
  type ClientCreativePost,
  type StoredCreativePost,
} from '@/lib/creative-store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/creative — вкладка «Креатив» (18+, по подписке).
 *
 * Приоритет источника: БД (creative_depth_<ch>) -> живой t.me (кэш Task 47)
 * -> unavailable. Telegram может лежать целиком — вкладка обязана работать.
 *
 * Параметры:
 *   channel=<id>  — один канал (страница PAGE_SIZE), иначе слияние всех (MERGE_PAGE)
 *   cursor=<b64>  — base64 {"b":{ch:msgId}}, страница ниже курсора
 *
 * Заголовок X-Creative-Cache: db=N/M src=db:N,live:N depth=T (диагностика).
 *
 * after()-догон свежести: на первой странице (без курсора) фоново, после
 * отправки ответа, каждый канал без синка 30+ минут получает свежий слой
 * + до 6 зеркал — так верхушка ленты живёт, не дожидаясь кронов.
 */

interface TopupState { inFlight: boolean; last: number }
const topup = new Map<string, TopupState>();
const TOPUP_INTERVAL_MS = 30 * 60 * 1000;

function parseCursor(cursorRaw: string | null): Record<string, number> {
  if (!cursorRaw) return {};
  try {
    const j = JSON.parse(Buffer.from(cursorRaw, 'base64').toString('utf8'));
    const b = j?.b;
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(b)) {
        const n = Number(v);
        if (isKnownChannel(k) && Number.isFinite(n) && n > 0) out[k] = n;
      }
      return out;
    }
  } catch { /* битый курсор — трактуем как первую страницу */ }
  return {};
}

/** Фоновая догонка: свежий слой + чуть зеркал. Ошибки глотаются. */
async function topUpChannel(channel: string): Promise<void> {
  const st = topup.get(channel) || { inFlight: false, last: 0 };
  if (st.inFlight || Date.now() - st.last < TOPUP_INTERVAL_MS) return;
  st.inFlight = true;
  topup.set(channel, st);
  try {
    const depth = await loadDepth(channel);
    const merged = depth?.posts || [];
    const beforeMax = depth?.maxMsgId || 0;
    const layer = await fetchChannelLayerLive(channel);
    if (layer && layer.length > 0) {
      let changed = false;
      for (const raw of layer) {
        if (raw.msgId > beforeMax) {
          merged.unshift(normalizePost(raw, channel));
          changed = true;
        }
      }
      if (changed) {
        // Немного зеркал самым свежим постам (бюджет 6 картинок)
        let budget = 6;
        for (let i = 0; i < merged.length && budget > 0; i++) {
          if (!merged[i].mirrored && (merged[i].photos.length || merged[i].videoPoster)) {
            merged[i] = await mirrorPostMedia(merged[i]);
            budget -= 1;
          }
        }
        merged.sort((a, b) => b.msgId - a.msgId);
        await saveDepth(channel, merged.slice(0, DEPTH_CAP), depth?.complete || merged.length >= DEPTH_CAP);
      }
    }
  } catch (e) {
    console.error(`topUp(${channel}):`, e);
  } finally {
    const st2 = topup.get(channel) || { inFlight: false, last: 0 };
    st2.inFlight = false;
    st2.last = Date.now();
    topup.set(channel, st2);
  }
}

export async function GET(request: NextRequest) {
  const gate = await checkAdultAccess(request, '/api/creative');
  if (!gate.ok) return gate.response;

  const t0 = Date.now();
  const { searchParams } = new URL(request.url);
  const channelParam = searchParams.get('channel');
  if (channelParam !== null && !isKnownChannel(channelParam)) {
    return NextResponse.json({ error: 'Unknown channel' }, { status: 400 });
  }
  const cursorB = parseCursor(searchParams.get('cursor'));
  const channels = channelParam ? [channelParam] : TG_CHANNELS.map(c => c.id);
  const limit = channelParam ? PAGE_SIZE : MERGE_PAGE;

  // 1) Читаем БД по каждому каналу
  const depths = await Promise.all(channels.map(ch => loadDepth(ch)));
  const dbCount = depths.filter(Boolean).length;

  // 2) Фолбэк-бутстрап: канал пуст в БД — берём свежий слой из кэша t.me
  const liveParts: Array<{ ch: string; posts: StoredCreativePost[] }> = [];
  for (let i = 0; i < channels.length; i++) {
    if (depths[i]) continue;
    const live = await fetchChannelPosts(channels[i]);
    if (live.length) {
      liveParts.push({ ch: channels[i], posts: live.map(r => normalizePost(r, channels[i])) });
    }
  }

  // 3) Собираем страницу
  let posts: ClientCreativePost[] = [];
  let hasMore = false;
  let nextCursor: string | null = null;

  if (channelParam) {
    const i = channels.indexOf(channelParam);
    const page = pageFromRow(depths[i], channelParam, cursorB[channelParam], limit);
    if (depths[i]) {
      posts = page.posts;
    } else if (liveParts[0]) {
      const live = liveParts[0].posts;
      const filtered = cursorB[channelParam]
        ? live.filter(p => p.msgId < cursorB[channelParam])
        : live;
      posts = filtered.slice(0, limit).map(toClientPost);
      hasMore = filtered.length > limit;
      const chMin = posts.length ? Math.min(...posts.map(p => p.msgId)) : 0;
      nextCursor = chMin
        ? Buffer.from(JSON.stringify({ b: { [channelParam]: chMin } })).toString('base64')
        : null;
    }
  } else {
    // Слияние всех каналов: по каждому берём посты ниже его курсора
    const perChannel: StoredCreativePost[][] = [];
    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];
      if (depths[i]) {
        perChannel.push(depths[i]!.posts.filter(p => !cursorB[ch] || p.msgId < cursorB[ch]));
      } else {
        const lp = liveParts.find(x => x.ch === ch)?.posts || [];
        perChannel.push(lp.filter(p => !cursorB[ch] || p.msgId < cursorB[ch]));
      }
    }
    // Лента «все каналы»: сортировка по ДАТЕ (msgId несопоставим между
    // каналами — у simple_elf IDs ~8500, у art_Hub_ai ~2400, из-за этого
    // верх ленты целиком занимал один канал с крупными ID).
    // Дедуп не нужен: посты уже уникальны по id ("<ch>/<msgId>") в рамках
    // своей строки depth-хранилища.
    const byDateDesc = (a: StoredCreativePost, b: StoredCreativePost): number => {
      const da = a.date || '';
      const db_ = b.date || '';
      if (da && db_) return da === db_ ? b.msgId - a.msgId : da < db_ ? 1 : -1;
      if (da) return -1;
      if (db_) return 1;
      return b.msgId - a.msgId;
    };
    const flat = perChannel.flat().sort(byDateDesc).slice(0, limit + 1);
    hasMore = flat.length > limit;
    const page = flat.slice(0, limit);
    // Курсор — минимальный msgId каждого канала на этой странице
    const b: Record<string, number> = {};
    for (const p of page) {
      b[p.channel] = b[p.channel] ? Math.min(b[p.channel], p.msgId) : p.msgId;
    }
    nextCursor = Object.keys(b).length
      ? Buffer.from(JSON.stringify({ b })).toString('base64')
      : null;
    posts = page.map(toClientPost);
  }

  const liveCount = liveParts.length;
  const totalStored = depths.reduce((acc, d) => acc + (d?.posts.length || 0), 0);
  const unavailable = posts.length === 0 && liveCount === 0 && totalStored === 0;

  const body = {
    posts,
    hasMore,
    nextCursor,
    channels: TG_CHANNELS,
    unavailable,
    tookMs: Date.now() - t0,
  };

  // 4) Фоновая догонка свежести — только на первой странице, после ответа
  if (!searchParams.get('cursor')) {
    after(async () => {
      for (const ch of channels) void topUpChannel(ch);
    });
  }

  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Creative-Cache': `db=${dbCount}/${channels.length} src=db:${dbCount},live:${liveCount} depth=${totalStored}`,
    },
  });
}
