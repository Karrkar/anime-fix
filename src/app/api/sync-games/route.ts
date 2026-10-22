import { NextResponse } from 'next/server';
import { getDb, authFromRequest } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { logEvent } from '@/lib/logger';
import { notifyTelegram } from '@/lib/notify';
import { recordSyncRun } from '@/lib/sync-status';
import { FEELEX_BASE, XXX_IGRA_BASE, JINA_READER } from '@/lib/sources'; // F-27: единый реестр
import { jinaHeaders, markJinaKeyRejected } from '@/lib/jina';
import { buildChainUrl, fireChainNext, fetchTimeBudget } from '@/lib/sync-chain';

export const maxDuration = 60;

/**
 * Парсер 18+ игр с feelex.fun и xxx-igra.com.
 *
 * ОКТЯБРЬ 2026 — задача «весь контент без ограничений». Зондирование
 * источников показало ДЫРУ в покрытии:
 *   feelex.fun — у каждой из 12 категорий ЕСТЬ пагинация ?page=2..7
 *     (проверено: на странице hentai 46 карточек, страница 2 добавляет
 *     39 новых), а парсер ходил только по 1-й странице каждой категории;
 *   xxx-igra.com — пагинация index.php?page=2..86 при ~6-12 играх на
 *     страницу (~500-1000 игр на сайте), парсер брал ТОЛЬКО главную.
 *     В БД на момент фикса было 45 игр xxx-igra — покрытие ~4%!
 *
 * Теперь обычный режим как раньше (1-я страница каждой категории feelex +
 * главная xxx-igra, они покрывают свежий контент), а ГЛУБОКИЙ проход
 * архива «по датам» делает бэкфил-режим: резюмируемый курсор в
 * sync_status ('games_backfill') + самоцепочка (lib/sync-chain.ts),
 * батч-апсерт целой страницы одним запросом (UNIQUE на vost_id
 * подтверждён продовой). Порядок фаз: сначала xxx-igra (самая большая
 * дыра), затем feelex по категориям.
 */

const BACKFILL_SOURCE = 'games_backfill';
// НОЯБРЬ 2026 (задача «парси всё, что указано в источнике»): список
// выписан со живого feelex.fun/ru/games — 43 контентные категории
// (href="…/games/<slug>" БЕЗ /play — только настоящие категории;
// сортировки/фильтры best/new/popular/os/engine/device НЕ включены).
// Каждая проверена валидацией: /ru/games/<cat> → 200 + card-game-block
// (скрипт scripts/feelex_categories_v2.py в поставке).
// Прежний список из 12 категорий устарел наполовину: 6 из них
// (simulation, ren-py, html5, action, dating, puzzle) на сайте больше
// не существуют — сайт мигрировал структуру в 2026-10.
const FEELEX_CATEGORIES = [
  '2d', '3d', 'adventure', 'ahegao', 'ai', 'american-dad',
  'anal', 'animated', 'asian', 'avatar', 'bbw', 'bdsm',
  'big-ass', 'big-tits', 'blowjob', 'borderlands', 'cartoon', 'cheating',
  'creampie', 'cyberpunk', 'femdom', 'footjob', 'furry', 'futanari',
  'goth', 'handjob', 'hd', 'hentai', 'incest', 'lady-dimitrescu',
  'milf', 'monster', 'naruto', 'overwatch', 'parody', 'pov',
  'realistic', 'resident-evil', 'rpg', 'sci-fi', 'spanking', 'teen',
  'visual-novel',
] as const;
const XXX_PAGE_HARD_CAP = 120;
const FEELEX_PAGE_HARD_CAP = 30;

// ⚠️ Бюджет времени: у функции жёсткий лимит 60с (Hobby-план Vercel), и раньше
// синк игр регулярно убивало по таймауту (504 FUNCTION_INVOCATION_TIMEOUT) —
// до записи sync_status дело не доходило. Теперь: один fetch ≤12с, попыток ≤2
// (худший случай ~25с), дедлайн на старт новых fetch — 30с.
async function fetchPage(url: string, retries = 1, timeoutMs = 12000): Promise<string> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(JINA_READER + encodeURIComponent(url), {
        headers: jinaHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) return await r.text();
      if (r.status === 401 || r.status === 402) markJinaKeyRejected(r.status);
    } catch { /* retry */ }
    if (i < retries) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  return '';
}

/** Прямой fetch xxx-igra.com (БЕЗ Jina).
 *
 * Сайт НЕ за Cloudflare (голый nginx/PHP, прямой IP) — Jina ему не нужен.
 * При этом Jina-рендер этого сайта нестабилен: главная через Jina работает,
 * а index.php?page=N — мгновенные отказы 3 запуска подряд (инцидент
 * 22.10.2026, games-цепочка умирала за 2-4с). Прямой fetch стабилен:
 * HTTP 200, ~23КБ, но кодировка windows-1251 — декодируем.
 *
 * Возвращает { status, body }: status 200 — страница каталога (парсим
 * ЛЮБОЙ размер); 404 — ЗА пределами каталога (сайт отдаёт 404-страницу —
 * это «источник исчерпан», а не ошибка сети); 0 — сеть/HTTP-ошибка
 * (таймаут, 5xx) — зовите Jina-фолбэк.
 */
async function fetchXxxRaw(url: string, timeoutMs = 12000): Promise<{ status: number; body: string }> {
  try {
    const r = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status !== 200 && r.status !== 404) return { status: 0, body: '' };
    const buf = await r.arrayBuffer();
    // charset=Windows-1251 (заголовок ответа сайта); Node 24 full-icu умеет
    return { status: r.status, body: new TextDecoder('windows-1251').decode(buf) };
  } catch {
    return { status: 0, body: '' };
  }
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
          // НОЯБРЬ 2026, фикс «игры feelex открываются на 404»: прежний
          // slice(urlStart+6, hrefEnd+6) захватывал ЗАКРЫВАЮЩУЮ кавычку href
          // («…/play"»), и все 1213 записей в БД имели хвостовую кавычку в
          // source_url/embed_url — браузер кодировал её в %22 → 404.
          // Правильная граница: hrefEnd+5 — сразу после «play».
          sourceUrl = block.slice(urlStart + 6, hrefEnd + 5);
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
  const seen = new Set<string>();
  // Кавычки-агностик: Jina-рендер отдаёт href="..." (двойные), сырой HTML
  // сайта — href='...' (одинарные). Заголовок в сыром HTML живёт в
  // <h2><a class='title_game' href='game.php?i=N'>TITLE</a></h2>; якорь
  // с картинкой (description_card) остаётся без текста и отсеется ниже.
  const linkPattern = /<a[^>]*href=(['"])game\.php\?i=(\d+)\1[^>]*>([\s\S]*?)<\/a>/g;
  let m;

  while ((m = linkPattern.exec(html)) !== null) {
    const gameId = m[2];
    if (seen.has(gameId)) continue;
    const rawTitle = m[3].replace(/<[^>]*>/g, '').trim();
    if (!rawTitle || rawTitle.length < 3) continue;
    seen.add(gameId);

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

// ─── Состояние бэкфилла игр (свой shape: два подисточника) ────────
interface GamesBackfillState {
  feelex: Record<string, number>;   // категория → следующая страница
  feelex_streak: Record<string, number>; // подряд пустых страниц категории
  feelex_done: Record<string, boolean>;
  xxx_next: number;
  xxx_streak: number;
  xxx_done: boolean;
  inserted: number;
  updated: number;
  pages_done: number;
  finished_at?: string;
  note?: string;
}

async function loadGamesState(): Promise<GamesBackfillState> {
  const fresh: GamesBackfillState = {
    feelex: {}, feelex_streak: {}, feelex_done: {},
    xxx_next: 2, xxx_streak: 0, xxx_done: false,
    inserted: 0, updated: 0, pages_done: 0,
  };
  try {
    const db = getDb();
    const { data } = await db.from('sync_status').select('details').eq('source', BACKFILL_SOURCE).maybeSingle();
    const d = (data?.details as Partial<GamesBackfillState> | null) || {};
    return {
      feelex: d.feelex && typeof d.feelex === 'object' ? d.feelex : {},
      feelex_streak: d.feelex_streak && typeof d.feelex_streak === 'object' ? d.feelex_streak : {},
      feelex_done: d.feelex_done && typeof d.feelex_done === 'object' ? d.feelex_done : {},
      xxx_next: Number(d.xxx_next) >= 2 ? Math.floor(Number(d.xxx_next)) : 2,
      xxx_streak: Number(d.xxx_streak) || 0,
      xxx_done: d.xxx_done === true,
      inserted: Number(d.inserted) || 0,
      updated: Number(d.updated) || 0,
      pages_done: Number(d.pages_done) || 0,
      finished_at: d.finished_at,
      note: d.note,
    };
  } catch {
    return fresh;
  }
}

async function saveGamesState(st: GamesBackfillState): Promise<void> {
  try {
    const db = getDb();
    const { error } = await db.from('sync_status').upsert({
      source: BACKFILL_SOURCE,
      last_run_at: new Date().toISOString(),
      last_status: 'ok',
      new_items: st.inserted,
      updated_items: st.updated,
      details: st as unknown as Record<string, unknown>,
      error: null,
    }, { onConflict: 'source' });
    if (error) console.error(`saveGamesState:`, error.message);
  } catch (e) {
    console.error('saveGamesState failed:', e);
  }
}

/** Существующие id игр (type='Игра', hash-отрицательные). */
async function loadExistingGameIds(db: ReturnType<typeof getDb>): Promise<Set<number>> {
  const ids = new Set<number>();
  const PAGE = 1000;
  for (let offset = 0; offset < 10_000; offset += PAGE) {
    const { data, error } = await db
      .from('anime_catalog')
      .select('vost_id')
      .eq('type', 'Игра')
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    for (const r of (data || []) as { vost_id: number }[]) ids.add(r.vost_id);
    if (!data || data.length < PAGE) break;
  }
  return ids;
}

function gameRow(g: GameData, updatedAt: string) {
  const isFeelex = g.source === 'feelex';
  return {
    vost_id: hashCode(g.sourceUrl),
    title: g.title,
    title_russian: g.title,
    description: g.description,
    image_url: g.imageUrl,
    type: 'Игра',
    episodes: 0,
    genres: isFeelex ? 'игра, 18+, хентай, feelex' : 'игра, 18+, xxx-igra',
    year: 2026,
    score: 0,
    views: 0,
    source_url: g.sourceUrl,
    embed_url: g.sourceUrl,
    is_adult: true,
    updated_at: updatedAt,
  };
}

/** Один сегмент: сначала xxx-igra (крупнейшая дыра), затем feelex. */
async function runGamesBackfillSegment(
  db: ReturnType<typeof getDb>,
  st: GamesBackfillState,
  budgetPages: number,
  deadlineMs: number,
): Promise<{ pagesWalked: number; inserted: number; updated: number }> {
  let existingIds: Set<number>;
  try {
    existingIds = await loadExistingGameIds(db);
  } catch {
    existingIds = new Set();
  }

  let pagesWalked = 0;
  let segInserted = 0, segUpdated = 0;
  let fetchFails = 0;

  while (pagesWalked < budgetPages && Date.now() < deadlineMs) {
    let url = '';
    let source: 'xxx' | 'feelex' | null = null;
    let cat = '';

    // ── Фаза 1: xxx-igra (index.php?page=N, на сайте 86 страниц) ──────
    if (!st.xxx_done) {
      if (st.xxx_next > XXX_PAGE_HARD_CAP) {
        st.xxx_done = true;
        continue;
      }
      url = `${XXX_IGRA_BASE}/index.php?page=${st.xxx_next}`;
      source = 'xxx';
    } else {
      // ── Фаза 2: feelex по категориям ────────────────────────────────
      // НОЯБРЬ 2026: стартуем с 1-й страницы (не с 2-й): при 97 категориях
      // дневной мелкий режим успевает пройти только их часть до дедлайна,
      // и страницы 1 «недостающих» категорий иначе не попадут в БД вообще.
      // Дубли по vost_id погашаются upsert'ом — повтор harmless.
      const pendingCat = FEELEX_CATEGORIES.find(c => !st.feelex_done[c]);
      if (!pendingCat) break; // всё пройдено
      cat = pendingCat;
      const nextPage = Math.max(1, Number(st.feelex[cat]) || 1);
      if (nextPage > FEELEX_PAGE_HARD_CAP) {
        st.feelex_done[cat] = true;
        continue;
      }
      st.feelex[cat] = nextPage;
      url = `${FEELEX_BASE}/ru/games/${cat}?page=${nextPage}`;
      source = 'feelex';
    }

    // Клампим бюджет fetch под остаток жизни инвока (инцидент 22.10.2026)
    const fb = fetchTimeBudget(deadlineMs);
    if (!fb) break;
    // xxx-igra: ПРЯМОЙ fetch первым (сайт не за Cloudflare — Jina не нужен
    // и нестабилен для его глубоких страниц), Jina — только фолбэк при
    // сетевой ошибке прямого. feelex — как раньше, через Jina.
    let html = '';
    let minLen = 5000;
    if (source === 'xxx') {
      const d = await fetchXxxRaw(url, Math.min(12_000, fb.timeoutMs));
      if (d.status === 200) {
        html = d.body;
        minLen = 0;               // валидный прямой ответ — парсим любым размером
      } else if (d.status === 404) {
        minLen = 0;               // за концом каталога: пустая страница, НЕ ошибка
        // html остаётся '' → парсер даст 0 игр → streak → done
      } else {
        html = await fetchPage(url, fb.retries, Math.min(12_000, fb.timeoutMs));
        minLen = 800;             // Jina-фолбэк: отсекаем его error-JSON (~200-500 байт)
      }
    } else {
      html = await fetchPage(url, fb.retries, Math.min(12_000, fb.timeoutMs));
    }
    // minLen вычислен выше по источнику и результату fetch:
    //   0 — прямой ответ xxx-igra (200 любой размер / 404 «за концом»);
    //   800 — Jina-фолбэк xxx-igra (отсекаем error-JSON ~200-500 байт);
    //   5000 — feelex (страницы огромные, меньшее — точно сбой).
    // «Источник исчерпан» определяется ПАРСИНГОМ (0 игр × 2 подряд),
    // а не размером ответа. Пустая строка при minLen=0 — валидный случай.
    if (html.length < minLen) {
      fetchFails++;
      if (fetchFails >= 3) {
        console.log(`Backfill games: fetch failed x${fetchFails} at ${url}, stopping segment`);
        break;
      }
      continue;
    }
    fetchFails = 0;

    const games = source === 'xxx' ? parseXxxIgra(html) : parseFeelex(html);

    if (source === 'xxx') {
      if (games.length === 0) {
        st.xxx_streak++;
        console.log(`Backfill xxx-igra: page ${st.xxx_next} — 0 games (streak ${st.xxx_streak})`);
        if (st.xxx_streak >= 2) {
          st.xxx_done = true;
          continue;
        }
        st.xxx_next++;
        st.pages_done++;
        pagesWalked++;
        await saveGamesState(st);
        continue;
      }
      const updatedAt = new Date().toISOString();
      const rows = games.map(g => gameRow(g, updatedAt));
      const { error: upErr } = await db.from('anime_catalog').upsert(rows, { onConflict: 'vost_id' });
      if (upErr) {
        console.error(`Backfill xxx page ${st.xxx_next} upsert:`, upErr.message);
        break;
      }
      let pIns = 0, pUpd = 0;
      for (const g of games) {
        const key = hashCode(g.sourceUrl);
        if (existingIds.has(key)) pUpd++;
        else { pIns++; existingIds.add(key); }
      }
      segInserted += pIns; segUpdated += pUpd;
      st.inserted += pIns; st.updated += pUpd;
      console.log(`Backfill xxx-igra: page ${st.xxx_next} upsert ${games.length} (new ${pIns}, upd ${pUpd})`);
      st.xxx_next++;
      st.xxx_streak = 0;
      st.pages_done++;
      pagesWalked++;
      await saveGamesState(st);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    // feelex: категория = cat
    if (games.length === 0) {
      const streak = (Number(st.feelex_streak[cat]) || 0) + 1;
      st.feelex_streak[cat] = streak;
      console.log(`Backfill feelex/${cat}: page ${st.feelex[cat]} — 0 games (streak ${streak})`);
      if (st.feelex_streak[cat] >= 2) {
        st.feelex_done[cat] = true;
        continue;
      }
      st.feelex[cat] = (Number(st.feelex[cat]) || 2) + 1;
      st.pages_done++;
      pagesWalked++;
      await saveGamesState(st);
      continue;
    }
    const updatedAt = new Date().toISOString();
    const rows = games.map(g => gameRow(g, updatedAt));
    const { error: upErr } = await db.from('anime_catalog').upsert(rows, { onConflict: 'vost_id' });
    if (upErr) {
      console.error(`Backfill feelex/${cat} page ${st.feelex[cat]} upsert:`, upErr.message);
      break;
    }
    let pIns = 0, pUpd = 0;
    for (const g of games) {
      const key = hashCode(g.sourceUrl);
      if (existingIds.has(key)) pUpd++;
      else { pIns++; existingIds.add(key); }
    }
    segInserted += pIns; segUpdated += pUpd;
    st.inserted += pIns; st.updated += pUpd;
    console.log(`Backfill feelex/${cat}: page ${st.feelex[cat]} upsert ${games.length} (new ${pIns}, upd ${pUpd})`);
    st.feelex[cat] = (Number(st.feelex[cat]) || 2) + 1;
    st.feelex_streak[cat] = 0;
    st.pages_done++;
    pagesWalked++;
    await saveGamesState(st);
    await new Promise(r => setTimeout(r, 2000));
  }

  return { pagesWalked, inserted: segInserted, updated: segUpdated };
}

export async function GET(request: Request) {
  // F-01 fix: единая cron-авторизация + админ-сессия (аудит 27.09.2026).
  const user = await authFromRequest(request);
  const isAdmin = !!user && user.role === 'admin';
  if (!isCronAuthorized(request) && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const startedAt = Date.now();

  // ── РЕЖИМ БЭКФИЛЛА ────────────────────────────────────────────────────
  if (searchParams.has('from_page') || searchParams.get('backfill') === '1') {
    const state = await loadGamesState();
    const budgetPages = Math.max(1, Math.min(parseInt(searchParams.get('budget_pages') || '10', 10) || 10, 16));
    const hop = Math.max(1, Math.min(parseInt(searchParams.get('hop') || '1', 10) || 1, 200));
    const chainOn = searchParams.get('chain') !== '0';
    const MAX_HOPS = 30; // ~86 стр xxx + до 84 стр feelex при ~10/сегмент

    const allDoneBefore = state.xxx_done && FEELEX_CATEGORIES.every(c => state.feelex_done[c]);
    const db = getDb();
    const deadline = startedAt + 44_000;
    const seg = await runGamesBackfillSegment(db, state, budgetPages, deadline);

    const xxxDone = state.xxx_done;
    const feelexDone = FEELEX_CATEGORIES.every(c => state.feelex_done[c]);
    const allDone = xxxDone && feelexDone;
    if (allDone && !allDoneBefore) {
      state.finished_at = new Date().toISOString();
      state.note = 'обход xxx-igra и feelex завершён';
    }
    await saveGamesState(state);
    logEvent('cron_sync_games_backfill', {
      hop, pagesWalked: seg.pagesWalked, inserted: seg.inserted, updated: seg.updated,
      xxx_next: state.xxx_next, xxx_done: xxxDone, feelex_done: feelexDone,
    });

    if (allDone && !allDoneBefore) {
      await notifyTelegram(
        `🏁 Бэкфилл игр завершён: страниц ${state.pages_done}, новых игр ${state.inserted}, обновлено ${state.updated}.` +
        `\nxxx-igra и feelex пройдены полностью.`,
      );
    }

    let chained = false;
    if (!allDone && chainOn && hop < MAX_HOPS && seg.pagesWalked > 0) {
      fireChainNext(buildChainUrl('/api/sync-games', {
        backfill: 1,
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
      pagesWalked: seg.pagesWalked,
      insertedThisSegment: seg.inserted,
      updatedThisSegment: seg.updated,
      xxx: { next: state.xxx_next, done: xxxDone },
      feelex: { done: feelexDone, cursors: state.feelex },
      totals: { pages_done: state.pages_done, inserted: state.inserted, updated: state.updated },
      allDone,
      chained,
    });
  }

  // ── ОБЫЧНЫЙ РЕЖИМ ─────────────────────────────────────────────────────
  try {
    const db = getDb();
    let totalNew = 0;
    let totalUpdated = 0;
    // Дедлайн СТАРТА новых тяжёлых fetch. После него — только завершение текущей
    // работы и запись sync_status (она обязательна: по ней админ видит живость парсера).
    // 45с при maxDuration=60 оставляет ~15с на апсерты и запись sync_status.
    const deadline = startedAt + 45_000;

    // ─── 0. Бэкфилл обложек xxx-igra (первым делом — чтобы успеть до дедлайна) ──
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
    // Прямой fetch (не-CF сайт, стабильный) с Jina-фолбэком
    const xxxDirect = await fetchXxxRaw(`${XXX_IGRA_BASE}/`);
    let xxxHtml = xxxDirect.status === 200 ? xxxDirect.body : '';
    if (xxxHtml.length < 800) xxxHtml = await fetchPage(`${XXX_IGRA_BASE}/`);
    const xxxGames = parseXxxIgra(xxxHtml);
    console.log(`xxx-igra.com: ${xxxGames.length} games (prefetched)`);

    // ─── 1. feelex.fun (main source — 12 категорий, 1-я страница каждой) ──
    let feelexTotal = 0;
    console.log('Fetching feelex.fun categories...');
    for (const cat of FEELEX_CATEGORIES) {
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
      if (cat !== FEELEX_CATEGORIES[FEELEX_CATEGORIES.length - 1]) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    // ─── 2. xxx-igra.com (secondary): главная страница ──────────────
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

    // ── Автозапуск бэкфилла, если глубокий проход ещё не завершён ─────
    let backfillChained = false;
    try {
      const st = await loadGamesState();
      const allDone = st.xxx_done && FEELEX_CATEGORIES.every(c => st.feelex_done[c]);
      if (!allDone) {
        fireChainNext(buildChainUrl('/api/sync-games', {
          backfill: 1,
          hop: 1,
          chain: 1,
        }));
        backfillChained = true;
      }
    } catch { /* следующий крон подхватит */ }

    return NextResponse.json({
      ok: true,
      feelexGames: feelexTotal,
      xxxIgraGames: xxxGames.length,
      newGames: totalNew,
      updatedGames: totalUpdated,
      backfillChained,
    });
  } catch (e) {
    console.error('Games sync error:', e);
    await recordSyncRun('games', { status: 'error', error: String(e).slice(0, 500) });
    await notifyTelegram(`❌ Синк игр упал: ${String(e).slice(0, 300)}`);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}
