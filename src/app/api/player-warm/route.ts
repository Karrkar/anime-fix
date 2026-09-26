import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { logEvent } from '@/lib/logger';
import { recordSyncRun } from '@/lib/sync-status';
import { saveCachedPage } from '@/lib/player-cache';
import { extractVostId, fetchSeriesFromApi } from '@/lib/vost-series'; // ФИКС 26.09.2026: серии через API

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * УТРЕННИЙ ПРОГРЕВ КЭША ПЛЕЕРА (фикс 3d, 18.09.2026).
 *
 * Контекст: v13.vost.pw тармит тяжёлые каталожные страницы /tip/tv/* В ВОЛНАХ
 * (прежде всего в RU-вечер, прайм-тайм; frame5.php при этом отвечает за ~1с).
 * Живой fetch страницы отдаётся максимум в тихие утренние часы — поэтому кроны
 * 06:20/06:30 UTC (vercel.json) прогревают персистентный кэш списков серий
 * (sync_status, строки player:page:*), TTL 20ч покрывает весь день до ~02:20.
 *
 * Каждый крон обрабатывает свой срез каталога (?slice=0|1): приоритет —
 * недавно обновлявшиеся тайтлы (пользовательский трафик концентрируется в них).
 * Прогреваем ТОЛЬКО страницы: конфиги видео (frame5) живые и быстрые всегда,
 * греть их массово не нужно.
 *
 * Бюджет: ~50с на инвокацию, 1 запрос раз в ~1.2с (вежливо к источнику),
 * прямой fetch с двумя попытками (утром канал здоров; Jina-фолбэк не нужен —
 * источник и так отвечает, а лишний канал только удлиняет цикл).
 */

const PAGE_FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SLICES = 2;
const TITLES_PER_SLICE = 50;
const BUDGET_MS = 50_000;
/** Пауза после API-запроса (API быстрый и без анти-бота — тартпит не грозит) */
const API_PAUSE_MS = 250;
/** Пауза после живого HTML-запроса к vost.pw (вежливость к анти-боту) */
const PAUSE_MS = 1_200;

/** Тот же маркер, что ищет player-proxy: «var data = {…}» — список серий. */
function parseEpisodeData(html: string): [string, string][] | null {
  const marker = 'var data = ';
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const braceStart = html.indexOf('{', idx + marker.length);
  if (braceStart < 0) return null;
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  try {
    const jsonStr = html.substring(braceStart, end).replace(/,\s*}/g, '}');
    const data = JSON.parse(jsonStr) as Record<string, string>;
    const entries = Object.entries(data);
    return entries.length ? entries : null;
  } catch {
    return null;
  }
}

async function warmFetchPage(url: string): Promise<string | null> {
  for (const timeoutMs of [8_000, 6_000]) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': PAGE_FETCH_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok) {
        const html = await resp.text();
        if (html.includes('var data = ')) return html;
      }
    } catch { /* повтор свежим соединением */ }
  }
  return null;
}

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const slice = Math.max(0, Math.min(parseInt(searchParams.get('slice') || '0', 10) || 0, SLICES - 1));
  const startedAt = Date.now();

  try {
    const db = getDb();

    // Приоритет прогрева: недавно обновлённые тайтлы сверху
    const { data: candidates } = await db
      .from('anime_catalog')
      .select('id, title, source_url, is_adult')
      .ilike('source_url', '%vost.pw%')
      .order('updated_at', { ascending: false })
      .limit(SLICES * TITLES_PER_SLICE);

    const rows = (candidates || []).filter((r: { source_url?: string | null; is_adult?: boolean }) =>
      r.source_url && !r.is_adult);
    const mySlice = rows.slice(slice * TITLES_PER_SLICE, (slice + 1) * TITLES_PER_SLICE);

    let warmed = 0;
    let failed = 0;
    let processed = 0;
    let viaApi = 0;
    let viaHtml = 0;

    for (const row of mySlice) {
      if (Date.now() > startedAt + BUDGET_MS) {
        console.log(`player-warm[${slice}]: бюджет исчерпан после ${processed} тайтлов`);
        break;
      }
      processed++;
      // ФИКС 26.09.2026: основной путь — API animevost (vost.pw вырезал список
      // серий из HTML: «var data = ;»); HTML-скачивание — только фолбэк.
      let entries: [string, string][] | null = null;
      let via: 'api' | 'html' = 'api';
      const vostId = extractVostId(row.source_url);
      if (vostId) {
        const api = await fetchSeriesFromApi(vostId, 10_000);
        if (api?.entries) entries = api.entries;
      }
      if (!entries) {
        via = 'html';
        const html = await warmFetchPage(row.source_url);
        if (html) entries = parseEpisodeData(html);
      }
      if (entries) {
        await saveCachedPage(row.source_url, entries);
        warmed++;
        if (via === 'api') viaApi++; else viaHtml++;
      } else {
        failed++;
      }
      await new Promise((r) => setTimeout(r, via === 'api' ? API_PAUSE_MS : PAUSE_MS));
    }

    const skipped = mySlice.length - processed;
    const details = { slice, candidates: mySlice.length, processed, warmed, failed, skipped, viaApi, viaHtml, durationMs: Date.now() - startedAt };
    console.log(`player-warm[${slice}]:`, JSON.stringify(details));
    logEvent('player_warm', details, 'info');
    await recordSyncRun(`player:warm:${slice}`, { status: 'ok', details });

    return NextResponse.json({ ok: true, ...details });
  } catch (e) {
    const error = String(e).slice(0, 400);
    console.error('player-warm failed:', error);
    await recordSyncRun(`player:warm:${slice}`, { status: 'error', error });
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
