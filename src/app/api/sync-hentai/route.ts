import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { logEvent } from '@/lib/logger';
import { notifyTelegram } from '@/lib/notify';
import { recordSyncRun } from '@/lib/sync-status';
import { HB_BASE, JINA_READER } from '@/lib/sources'; // F-27: домены из единого реестра

export const maxDuration = 60;

/**
 * Парсер 18+ с hentaibaza.com.
 * Крон Vercel вызывает ежедневно без secret (авторизация через заголовок
 * x-vercel-cron / Bearer CRON_SECRET — см. src/lib/cron-auth.ts).
 * Ручной запуск: GET /api/sync-hentai?pages=2&secret=<SYNC_SECRET|CRON_SECRET>
 */

async function fetchPage(url: string, retries = 2): Promise<string> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(JINA_READER + encodeURIComponent(url), {
        headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) return await r.text();
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

export async function GET(request: Request) {
  // F-01 fix: раньше требовался ?secret=<SYNC_SECRET>, но переменная была не задана
  // и крон всегда падал 403. Теперь кроны авторизуются через x-vercel-cron.
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const pagesToParse = Math.max(1, Math.min(parseInt(searchParams.get('pages') || '2'), 5));
  const fetchMeta = searchParams.get('meta') === '1';
  const startedAt = Date.now();

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
    // Поиск по подстроке '%t.me/%' — безопасный одинарный фильтр supabase-js.
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
    return NextResponse.json({
      ok: true,
      pagesParsed: pagesToParse,
      newAnime: totalNew,
      updatedAnime: totalUpdated,
      garbageRemoved,
    });
  } catch (e) {
    console.error('Hentai sync error:', e);
    await recordSyncRun('hentaibaza', { status: 'error', error: String(e).slice(0, 500) });
    await notifyTelegram(`❌ Синк хентай упал: ${String(e).slice(0, 300)}`);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}
