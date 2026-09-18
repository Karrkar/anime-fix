import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { logEvent } from '@/lib/logger';
import { notifyTelegram } from '@/lib/notify';
import { recordSyncRun } from '@/lib/sync-status';
import { FEELEX_BASE, XXX_IGRA_BASE, JINA_READER } from '@/lib/sources'; // F-27: домены из единого реестра

export const maxDuration = 60;

/**
 * Парсер 18+ игр с feelex.fun и xxx-igra.com
 * Ручной запуск: GET /api/sync-games?secret=<SYNC_SECRET|CRON_SECRET>
 * (при желании можно добавить в vercel.json как крон — авторизация уже готова)
 */

// ⚠️ Бюджет времени: у функции жёсткий лимит 60с (Hobby-план Vercel), и раньше
// синк игр регулярно убивало по таймауту (504 FUNCTION_INVOCATION_TIMEOUT) —
// до записи sync_status дело не доходило. Теперь: один fetch ≤12с, попыток ≤2
// (худший случай ~25с), дедлайн на старт новых fetch — 30с.
async function fetchPage(url: string, retries = 1): Promise<string> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(JINA_READER + encodeURIComponent(url), {
        headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
        signal: AbortSignal.timeout(12000),
      });
      if (r.ok) return await r.text();
    } catch { /* retry */ }
    if (i < retries) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  return '';
}

interface GameData {
  title: string;
  description: string;
  imageUrl: string;
  sourceUrl: string;
  source: string;
  tags: string;
}

// ─── feelex.fun parser ────────────────────────────────────────────
function parseFeelex(html: string): GameData[] {
  const results: GameData[] = [];
  const blockPattern = new RegExp('card-game-block[^>]*>([\\s\\S]*?)(?=card-game-block|$)', 'g');
  let m;

  while ((m = blockPattern.exec(html)) !== null) {
    const block = m[1];
    try {
      // Title from itemprop="name"
      const nameMatch = block.match(/itemprop="name"[^>]*>([^<]+)/);
      if (!nameMatch) continue;
      const title = nameMatch[1].trim();
      if (!title || title.length < 2) continue;

      // Image from itemprop="image"
      const imgMatch = block.match(/itemprop="image"[^>]+src="([^"]+)"/);
      const imageUrl = imgMatch ? imgMatch[1] : '';

      // Play URL — find href with feelex.fun/.../play
      const urlStart = block.indexOf(`href="${FEELEX_BASE}/`);
      let sourceUrl = '';
      if (urlStart > -1) {
        const hrefEnd = block.indexOf('/play"', urlStart);
        if (hrefEnd > -1) {
          sourceUrl = block.slice(urlStart + 6, hrefEnd + 6);
        }
      }

      if (!sourceUrl) continue;

      results.push({ title, description: '', imageUrl, sourceUrl, source: 'feelex', tags: '' });
    } catch { /* skip */ }
  }
  return results;
}

// ─── xxx-igra.com parser ─────────────────────────────────────────
function parseXxxIgra(html: string): GameData[] {
  const results: GameData[] = [];
  const linkPattern = new RegExp('<a[^>]*href="game\\.php\\?i=(\\d+)"[^>]*>([\\s\\S]*?)<\\/a>', 'g');
  let m;

  while ((m = linkPattern.exec(html)) !== null) {
    const gameId = m[1];
    const rawTitle = m[2].replace(/<[^>]*>/g, '').trim();
    if (!rawTitle || rawTitle.length < 3) continue;

    const title = rawTitle.replace(/^❤️\s*/, '').trim();
    const sourceUrl = `${XXX_IGRA_BASE}/game.php?i=${gameId}`;

    // Обложка по конвенции сайта: game/{ID}/{ID}.jpg (проверено: 21/21 существующих
    // игр отвечают 200 image/jpeg; на главной те же URL в <img class="img_card">)
    const imageUrl = `${XXX_IGRA_BASE}/game/${gameId}/${gameId}.jpg`;

    results.push({ title, description: '', imageUrl, sourceUrl, source: 'xxx-igra', tags: '' });
  }
  return results;
}

async function fetchXxxIgraDescription(gameUrl: string): Promise<string> {
  const html = await fetchPage(gameUrl);
  if (!html) return '';
  const desc = html.match(/name="Description" content="([^"]+)"/);
  return desc ? desc[1].slice(0, 500) : '';
}

export async function GET(request: Request) {
  // F-01 fix: единая cron-авторизация (x-vercel-cron / Bearer CRON_SECRET / ?secret=...)
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const db = getDb();
    let totalNew = 0;
    let totalUpdated = 0;
    const startedAt = Date.now();
    // Дедлайн СТАРТА новых тяжёлых fetch. После него — только завершение текущей
    // работы и запись sync_status (она обязательна: по ней админ видит живость парсера).
    // FIX: было 30с — feelex (12 категорий + паузы 800мс) съедал бюджет целиком,
    // и до xxx-igra очередь не доходила (xxxIgraParsed: 0 каждый запуск).
    // 45с при maxDuration=60 оставляет ~15с на апсерты и запись sync_status.
    const deadline = startedAt + 45_000;

    // ─── 0. Бэкфилл обложек xxx-igra (первым делом — чтобы успеть до дедлайна) ──
    // Старые записи вставлялись с image_url='' (парсер раньше не умел брать
    // обложки). Конвенция game/{ID}/{ID}.jpg работает для всех игр (проверено
    // 21/21), поэтому обложка строится из source_url без загрузки страниц.
    const { data: noCoverRows } = await db
      .from('anime_catalog')
      .select('id, source_url, image_url')
      .eq('type', 'Игра')
      .eq('is_adult', true)
      .like('source_url', '%xxx-igra.com%')
      .limit(200);
    let coversBackfilled = 0;
    for (const row of noCoverRows || []) {
      if (row.image_url) continue;
      const gameId = String(row.source_url || '').match(/i=(\d+)/)?.[1];
      if (!gameId) continue;
      const { error } = await db.from('anime_catalog')
        .update({ image_url: `${XXX_IGRA_BASE}/game/${gameId}/${gameId}.jpg` })
        .eq('id', row.id);
      if (!error) coversBackfilled++;
      else console.error('xxx-igra cover backfill error:', error.message);
    }
    console.log(`xxx-igra covers backfilled: ${coversBackfilled}`);

    // ─── 0b. xxx-igra.com: страница фетчится ПЕРВЫМ делом (до feelex) ──
    // FIX: раньше страница xxx-igra грузилась ПОСЛЕ feelex и стабильно не
    // доживала до дедлайна. Теперь это 1 fetch (~3-5с) в самом начале —
    // парсинг источника больше не пропускается; апсерты — в секции 2.
    const xxxHtml = await fetchPage(`${XXX_IGRA_BASE}/`);
    const xxxGames = parseXxxIgra(xxxHtml);
    console.log(`xxx-igra.com: ${xxxGames.length} games (prefetched)`);

    // ─── 1. feelex.fun (main source — multiple categories) ──────────
    const feelexCategories = [
      'hentai', '2d', '3d', 'rpg', 'simulation', 'visual-novel',
      'ren-py', 'html5', 'action', 'adventure', 'dating', 'puzzle',
    ];
    let feelexTotal = 0;
    console.log('Fetching feelex.fun categories...');
    for (const cat of feelexCategories) {
      if (Date.now() > deadline) { console.log('Games sync: deadline reached, stopping'); break; }
      const html = await fetchPage(`${FEELEX_BASE}/ru/games/${cat}`);
      if (!html || html.length < 5000) continue;
      const parsed = parseFeelex(html);
      console.log(`  feelex /${cat}: ${parsed.length} games`);
      feelexTotal += parsed.length;

      for (const g of parsed) {
        if (Date.now() > deadline) break; // бережём бюджет: DB-операции тоже стоят времени
        const hash = hashCode(g.sourceUrl);
        const { data: existing } = await db
          .from('anime_catalog')
          .select('id')
          .eq('vost_id', hash)
          .eq('type', 'Игра')
          .maybeSingle();

        if (existing) {
          await db.from('anime_catalog').update({
            title: g.title, image_url: g.imageUrl,
            updated_at: new Date().toISOString(),
          }).eq('id', existing.id);
          totalUpdated++;
        } else {
          const { error } = await db.from('anime_catalog').insert({
            vost_id: hash, title: g.title, title_russian: g.title,
            description: g.description, image_url: g.imageUrl,
            type: 'Игра', episodes: 0, genres: 'игра, 18+, хентай, feelex',
            year: 2026, score: 0, views: 0,
            source_url: g.sourceUrl, embed_url: g.sourceUrl,
            is_adult: true,
          });
          if (!error) totalNew++;
          else console.error('feelex insert error:', error.message);
        }
      }
      if (cat !== feelexCategories[feelexCategories.length - 1]) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    // ─── 2. xxx-igra.com (secondary) ──────────────────────────────
    // 2a. Апсерты игр, спарсенных на шаге 0b (страница уже загружена, осталась
    // только запись в БД; описание добирается с страницы игры лишь для НОВЫХ).
    if (Date.now() > deadline) {
      console.log('Games sync: deadline reached before xxx-igra, skipping');
    }
    console.log(`xxx-igra.com: ${xxxGames.length} games to upsert`);

    for (const g of xxxGames) {
      if (Date.now() > deadline) { console.log('Games sync: deadline mid-xxx, stopping'); break; }
      const hash = hashCode(g.sourceUrl);
      const { data: existing } = await db
        .from('anime_catalog')
        .select('id')
        .eq('vost_id', hash)
        .eq('type', 'Игра')
        .maybeSingle();

      if (!existing) {
        // Fetch description from game page
        const desc = await fetchXxxIgraDescription(g.sourceUrl);
        const { error } = await db.from('anime_catalog').insert({
          vost_id: hash, title: g.title, title_russian: g.title,
          description: desc, image_url: g.imageUrl,
          type: 'Игра', episodes: 0, genres: 'игра, 18+, xxx-igra',
          year: 2026, score: 0, views: 0,
          source_url: g.sourceUrl, embed_url: g.sourceUrl,
          is_adult: true,
        });
        if (!error) totalNew++;
        else console.error('xxx-igra insert error:', error.message);
        await new Promise(r => setTimeout(r, 1000));
      } else {
        totalUpdated++;
      }
    }

    logEvent('cron_sync_games', { feelexParsed: feelexTotal, xxxParsed: xxxGames.length, newGames: totalNew, updatedGames: totalUpdated, coversBackfilled });
    await recordSyncRun('games', {
      status: 'ok',
      newItems: totalNew,
      updatedItems: totalUpdated,
      details: { feelexParsed: feelexTotal, xxxIgraParsed: xxxGames.length, coversBackfilled, durationMs: Date.now() - startedAt },
    });
    await notifyTelegram(`✅ Синк игр: +${totalNew} новых, обновлено ${totalUpdated}`);
    return NextResponse.json({
      ok: true,
      feelexGames: feelexTotal,
      xxxIgraGames: xxxGames.length,
      newGames: totalNew,
      updatedGames: totalUpdated,
    });
  } catch (e) {
    console.error('Games sync error:', e);
    await recordSyncRun('games', { status: 'error', error: String(e).slice(0, 500) });
    await notifyTelegram(`❌ Синк игр упал: ${String(e).slice(0, 300)}`);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}

// Simple string hash (deterministic, for dedup)
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return -Math.abs(hash) - 10000; // Negative to avoid collision with vost.pw IDs
}
