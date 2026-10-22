import { NextResponse } from 'next/server';
import { getDb, authFromRequest } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { logEvent } from '@/lib/logger';
import { notifyTelegram } from '@/lib/notify';
import { recordSyncRun } from '@/lib/sync-status';
import { HB_BASE, JINA_READER } from '@/lib/sources'; // F-27: домены из единого реестра
import { jinaHeaders, markJinaKeyRejected } from '@/lib/jina';
import {
  buildChainUrl,
  fetchTimeBudget,
  fireChainNext,
  loadBackfillState,
  saveBackfillState,
  type BackfillState,
} from '@/lib/sync-chain';

export const maxDuration = 60;

/**
 * Парсер 18+ с hentaibaza.com.
 *
 * ОКТЯБРЬ 2026 — «весь контент без ограничений»: на сайте 10 страниц
 * (~140 видео), крон парсил только первую. Теперь:
 *   обычный режим — до 10 страниц (весь сайт, по умолчанию 3);
 *   бэкфил-режим — полный проход архива по датам от свежих к старым
 *   (/?page=N), батч-апсерт страницы одним запросом, самоцепочка
 *   и резюмируемый курсор в sync_status ('hentai_backfill') — см.
 *   lib/sync-chain.ts. Описание/uploadDate в бэкфиле не добираются
 *   (лишний fetch на каждое видео) — их обновит мелкий проход с meta=1.
 */

const BACKFILL_SOURCE = 'hentai_backfill';
const HB_PAGE_HARD_CAP = 50;

async function fetchPage(url: string, retries = 2, timeoutMs = 30000): Promise<string> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(JINA_READER + encodeURIComponent(url), {
        headers: jinaHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) return await r.text();
      if (r.status === 401 || r.status === 402) markJinaKeyRejected(r.status);
    } catch { /* retry */ }
    if (i < retries) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  return '';
}

interface HentaiVideo {
  hbId: number;
  title: string;
  titleRussian: string;
  imageUrl: string;
  duration: string;
  views: number;
  sourceUrl: string;
  description: string;
  uploadDate: string;
}

function parseListPage(html: string): HentaiVideo[] {
  const results: HentaiVideo[] = [];
  const cardRegex = /<a href="\/watch\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    const hbId = parseInt(match[1], 10);
    const card = match[2];

    // Poster image with title in alt
    const imgMatch = card.match(/<img src="([^"]+)" alt="([^"]+)"/);
    if (!imgMatch) continue;
    const imageUrl = imgMatch[1];
    const altTitle = imgMatch[2];

    // Защита от спам-карточек: постер обязан быть http(s)-ссылкой,
    // а заголовок — содержать хотя бы одну букву/цифру (не только
    // символы-заполнители вроде 〰️〰️〰️ из телеграм-мусора).
    if (!/^https?:\/\//i.test(imageUrl)) continue;
    const cleanTitle = altTitle.replace(/[^\p{L}\p{N}]/gu, '');
    if (cleanTitle.length < 2) continue;

    // Parse "Russian / English" from alt
    let title = altTitle;
    let titleRussian = '';
    const slashIdx = altTitle.indexOf(' / ');
    if (slashIdx > -1) {
      titleRussian = altTitle.slice(0, slashIdx).trim();
      title = altTitle.slice(slashIdx + 3).trim();
    } else {
      titleRussian = altTitle;
    }

    // Duration (e.g. "18:27")
    const durMatch = card.match(/(\d{1,2}:\d{2})/);
    const duration = durMatch ? durMatch[1] : '';

    // Views (e.g. "2.7K")
    const viewMatch = card.match(/(\d+\.?\d*)K/);
    const views = viewMatch ? Math.round(parseFloat(viewMatch[1]) * 1000) : 0;

    results.push({
      hbId, title, titleRussian, imageUrl, duration, views,
      sourceUrl: `${HB_BASE}/watch/${hbId}`,
      description: '', uploadDate: '',
    });
  }
  return results;
}

async function fetchWatchMeta(hbId: number): Promise<{ description: string; uploadDate: string }> {
  const url = `${HB_BASE}/watch/${hbId}`;
  const html = await fetchPage(url);
  if (!html || html.length < 1000) return { description: '', uploadDate: '' };

  const descMatch = html.match(/<meta name="description" content="([^"]+)"/);
  const dateMatch = html.match(/"uploadDate":"([^"]+)"/);

  return {
    description: descMatch ? descMatch[1].slice(0, 1000) : '',
    uploadDate: dateMatch ? dateMatch[1] : '',
  };
}

/** Существующие hbId (диапазон (-100000, 0): игры лежат глубже, до -2^31). */
async function loadExistingHbIds(db: ReturnType<typeof getDb>): Promise<Set<number>> {
  const ids = new Set<number>();
  const PAGE = 1000;
  for (let offset = 0; offset < 10_000; offset += PAGE) {
    const { data, error } = await db
      .from('anime_catalog')
      .select('vost_id')
      .lt('vost_id', 0)
      .gt('vost_id', -100000)
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    for (const r of (data || []) as { vost_id: number }[]) ids.add(r.vost_id);
    if (!data || data.length < PAGE) break;
  }
  return ids;
}

async function runBackfillSegment(
  db: ReturnType<typeof getDb>,
  st: BackfillState,
  budgetPages: number,
  deadlineMs: number,
): Promise<{ parsed: number; inserted: number; updated: number; pagesWalked: number }> {
  let existingIds: Set<number>;
  try {
    existingIds = await loadExistingHbIds(db);
  } catch {
    existingIds = new Set();
  }

  let parsed = 0, inserted = 0, updated = 0, pagesWalked = 0;
  let fetchFails = 0;

  while (!st.done && pagesWalked < budgetPages && Date.now() < deadlineMs) {
    const page = st.next_page;
    if (page > HB_PAGE_HARD_CAP) {
      st.done = true;
      st.note = `page cap ${HB_PAGE_HARD_CAP}`;
      break;
    }
    const url = page === 1 ? `${HB_BASE}/` : `${HB_BASE}/?page=${page}`;
    // Клампим бюджет fetch под остаток жизни инвока (инцидент 22.10.2026)
    const fb = fetchTimeBudget(deadlineMs);
    if (!fb) break;
    const html = await fetchPage(url, fb.retries, fb.timeoutMs);
    if (!html || html.length < 5000) {
      fetchFails++;
      if (fetchFails >= 2) {
        console.log(`Backfill hentai: fetch failed twice at page ${page}, stopping segment`);
        break;
      }
      continue;
    }
    fetchFails = 0;
    const videos = parseListPage(html);
    if (videos.length === 0) {
      st.consecutive_empty++;
      console.log(`Backfill hentai: page ${page} — 0 cards (streak ${st.consecutive_empty})`);
      if (st.consecutive_empty >= 2) {
        st.done = true;
        st.note = 'источник исчерпан (за ?page=11 сайт отдаёт пустую выдачу)';
        st.finished_at = new Date().toISOString();
        break;
      }
      st.next_page = page + 1;
      st.pages_done++;
      pagesWalked++;
      await saveBackfillState(BACKFILL_SOURCE, st);
      continue;
    }

    const updatedAt = new Date().toISOString();
    const rows = videos.map(v => ({
      vost_id: -v.hbId, // отрицательные, чтобы не пересекаться с vost.pw
      title: v.title || v.titleRussian,
      title_russian: v.titleRussian,
      description: v.description,
      image_url: v.imageUrl,
      type: 'OVA',
      episodes: 1,
      genres: 'хентай, 18+',
      year: v.uploadDate ? new Date(v.uploadDate).getFullYear() : 2026,
      score: 0,
      views: v.views,
      source_url: v.sourceUrl,
      embed_url: v.sourceUrl,
      is_adult: true,
      updated_at: updatedAt,
    }));
    const { error: upErr } = await db
      .from('anime_catalog')
      .upsert(rows, { onConflict: 'vost_id' });
    if (upErr) {
      console.error(`Backfill hentai page ${page} upsert:`, upErr.message);
      break;
    }

    let pageInserted = 0, pageUpdated = 0;
    for (const v of videos) {
      const key = -v.hbId;
      if (existingIds.has(key)) pageUpdated++;
      else { pageInserted++; existingIds.add(key); }
    }
    parsed += videos.length;
    inserted += pageInserted;
    updated += pageUpdated;
    st.inserted += pageInserted;
    st.updated += pageUpdated;
    st.next_page = page + 1;
    st.pages_done++;
    st.consecutive_empty = 0;
    pagesWalked++;
    console.log(`Backfill hentai: page ${page} upsert ${videos.length} (new ${pageInserted}, upd ${pageUpdated})`);

    await saveBackfillState(BACKFILL_SOURCE, st);
    await new Promise(r => setTimeout(r, 2000));
  }

  return { parsed, inserted, updated, pagesWalked };
}

export async function GET(request: Request) {
  // F-01 fix + аудит 27.09.2026: крон/secret/админ-сессия.
  const user = await authFromRequest(request);
  const isAdmin = !!user && user.role === 'admin';
  if (!isCronAuthorized(request) && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const startedAt = Date.now();

  // ── РЕЖИМ БЭКФИЛЛА ────────────────────────────────────────────────────
  const backfillRequested =
    searchParams.has('from_page') || searchParams.get('backfill') === '1';
  if (backfillRequested) {
    const state = await loadBackfillState(BACKFILL_SOURCE);
    const fromPage = Math.max(1, parseInt(searchParams.get('from_page') || '0', 10) || state.next_page);
    const budgetPages = Math.max(1, Math.min(parseInt(searchParams.get('budget_pages') || '8', 10) || 8, 15));
    const hop = Math.max(1, Math.min(parseInt(searchParams.get('hop') || '1', 10) || 1, 100));
    const chainOn = searchParams.get('chain') !== '0';
    const MAX_HOPS = 6; // сайт маленький (10 стр) — больше не нужно

    const st: BackfillState = { ...state, next_page: fromPage };
    // Явный from_page меньше курсора = ручной сброс (см. sync-anime)
    if (searchParams.has('from_page') && fromPage < state.next_page) {
      st.done = false;
      st.consecutive_empty = 0;
      st.note = 'перезапуск по from_page';
    }
    const deadline = startedAt + 44_000;
    const db = getDb();
    const seg = await runBackfillSegment(db, st, budgetPages, deadline);

    const justFinished = st.done && !state.done;
    await saveBackfillState(BACKFILL_SOURCE, st);
    logEvent('cron_sync_hentai_backfill', {
      from_page: fromPage, next_page: st.next_page, done: st.done, hop,
      parsed: seg.parsed, inserted: seg.inserted, updated: seg.updated,
    });

    if (justFinished) {
      await notifyTelegram(
        `🏁 Бэкфилл хентай завершён: страниц ${st.pages_done}, новых видео ${st.inserted}, обновлено ${st.updated}.`,
      );
    }

    let chained = false;
    if (!st.done && chainOn && hop < MAX_HOPS && seg.pagesWalked > 0) {
      fireChainNext(buildChainUrl('/api/sync-hentai', {
        backfill: 1,
        from_page: st.next_page,
        budget_pages: budgetPages,
        hop: hop + 1,
        chain: 1,
      }));
      chained = true;
    }

    return NextResponse.json({
      ok: true,
      mode: 'backfill',
      hop,
      from_page: fromPage,
      next_page: st.next_page,
      done: st.done,
      pagesWalked: seg.pagesWalked,
      insertedThisSegment: seg.inserted,
      updatedThisSegment: seg.updated,
      totals: { pages_done: st.pages_done, inserted: st.inserted, updated: st.updated },
      chained,
    });
  }

  // ── ОБЫЧНЫЙ РЕЖИМ ─────────────────────────────────────────────────────
  const pagesToParse = Math.max(1, Math.min(parseInt(searchParams.get('pages') || '3'), 10));
  const fetchMeta = searchParams.get('meta') === '1';

  try {
    const db = getDb();
    let totalNew = 0;
    let totalUpdated = 0;
    let garbageRemoved = 0;

    // ── Очистка мусора от старых синков ──────────────────────────────────
    // В anime_catalog накопились 18+-записи с embed_url на t.me (телеграм-спам:
    // заголовки из 〰️〰️, нерабочие плееры). Они не проигрываются никак и
    // уже скрыты из каталога фильтром в /api/hentai (like hentaibaza.com/%).
    // Здесь удаляем их физически, чтобы таблица не разрасталась.
    try {
      const { count: garbageCount, error: delErr } = await db
        .from('anime_catalog')
        .delete({ count: 'exact' })
        .eq('is_adult', true)
        .like('embed_url', '%t.me/%');
      if (delErr) console.error('Hentai cleanup DB error:', delErr.message);
      garbageRemoved = garbageCount || 0;
      if (garbageRemoved > 0) {
        console.log(`Hentai sync cleanup: removed ${garbageRemoved} garbage t.me records`);
        logEvent('hentai_sync_cleanup', { removed: garbageRemoved });
      }
    } catch (e) {
      console.error('Hentai cleanup error (non-fatal):', e);
    }

    for (let p = 1; p <= pagesToParse; p++) {
      const url = p === 1 ? HB_BASE + '/' : `${HB_BASE}/?page=${p}`;
      const html = await fetchPage(url);
      if (!html || html.length < 5000) continue;

      const videos = parseListPage(html);
      console.log(`Hentai page ${p}: found ${videos.length} videos`);

      for (const v of videos) {
        // Optionally fetch description from watch page
        if (fetchMeta) {
          const meta = await fetchWatchMeta(v.hbId);
          v.description = meta.description;
          v.uploadDate = meta.uploadDate;
          await new Promise(r => setTimeout(r, 1000)); // rate limit
        }

        const { data: existing } = await db
          .from('anime_catalog')
          .select('id')
          .eq('vost_id', -v.hbId) // negative ID to distinguish from vost.pw
          .maybeSingle();

        if (existing) {
          const { error } = await db
            .from('anime_catalog')
            .update({
              title: v.title,
              title_russian: v.titleRussian,
              description: v.description,
              image_url: v.imageUrl,
              embed_url: v.sourceUrl,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id);
          if (!error) totalUpdated++;
        } else {
          const { error } = await db
            .from('anime_catalog')
            .insert({
              vost_id: -v.hbId, // negative to avoid collision with vost.pw IDs
              title: v.title || v.titleRussian,
              title_russian: v.titleRussian,
              description: v.description,
              image_url: v.imageUrl,
              type: 'OVA',
              episodes: 1,
              genres: 'хентай, 18+',
              year: v.uploadDate ? new Date(v.uploadDate).getFullYear() : 2026,
              score: 0,
              views: v.views,
              source_url: v.sourceUrl,
              embed_url: v.sourceUrl,
              is_adult: true,
            });
          if (!error) totalNew++;
          else console.error('Hentai insert error:', error.message);
        }
      }

      if (p < pagesToParse) await new Promise(r => setTimeout(r, 3000));
    }

    logEvent('cron_sync_hentai', { pages: pagesToParse, newAnime: totalNew, updatedAnime: totalUpdated, garbageRemoved });
    await recordSyncRun('hentaibaza', {
      status: 'ok',
      newItems: totalNew,
      updatedItems: totalUpdated,
      details: { pages: pagesToParse, durationMs: Date.now() - startedAt, garbageRemoved },
    });
    await notifyTelegram(`✅ Синк хентай: +${totalNew} новых, обновлено ${totalUpdated}${garbageRemoved ? `, мусора удалено: ${garbageRemoved}` : ''}`);

    // ── Автозапуск бэкфилла, если полный проход ещё не завершён ────────
    let backfillChained = false;
    try {
      const st = await loadBackfillState(BACKFILL_SOURCE);
      if (!st.done) {
        fireChainNext(buildChainUrl('/api/sync-hentai', {
          backfill: 1,
          from_page: st.next_page,
          hop: 1,
          chain: 1,
        }));
        backfillChained = true;
      }
    } catch { /* следующий крон подхватит */ }

    return NextResponse.json({
      ok: true,
      pagesParsed: pagesToParse,
      newAnime: totalNew,
      updatedAnime: totalUpdated,
      garbageRemoved,
      backfillChained,
    });
  } catch (e) {
    console.error('Hentai sync error:', e);
    await recordSyncRun('hentaibaza', { status: 'error', error: String(e).slice(0, 500) });
    await notifyTelegram(`❌ Синк хентай упал: ${String(e).slice(0, 300)}`);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}
