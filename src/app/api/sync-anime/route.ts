import { NextResponse } from 'next/server';
import { getDb, cleanupExpiredSessions, authFromRequest } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { logEvent } from '@/lib/logger';
import { notifyTelegram } from '@/lib/notify';
import { recordSyncRun } from '@/lib/sync-status';
import { VOST_BASE, JINA_READER, normalizeVostDomain } from '@/lib/sources'; // F-27: единый реестр источников
import { jinaHeaders, markJinaKeyRejected } from '@/lib/jina';
import {
  buildChainUrl,
  emptyBackfillState,
  fireChainNext,
  loadBackfillState,
  saveBackfillState,
  type BackfillState,
} from '@/lib/sync-chain';

// Лимит времени функции: крон парсит страницы + refresh новых серий.
// 60с — максимум для Hobby-плана Vercel.
export const maxDuration = 60;

/**
 * Парсер каталога vost.pw (v13 → 301 → v14, домен нормализуем на v13).
 *
 * ДВА РЕЖИМА (октябрь 2026 — задача «весь контент без ограничений»):
 *
 *  1) МЕЛКИЙ (ежедневный, как раньше): страницы 1..pages + ongoing + refresh.
 *     Стал глубже: pages по умолчанию 4 (было 2), refresh 25 (было 15).
 *
 *  2) БЭКФИЛЛ (полный проход архива «по дате», вглубь до первой страницы
 *     сайта): включается автоматически после мелкого прохода, если курсор
 *     в sync_status ('vost_backfill') ещё не отмечен done. Ходит страницами
 *     от самой свежей к самой старой (порядок каталога = порядок дат),
 *     батч-апсертит ЦЕЛУЮ страницу одним запросом (UNIQUE на vost_id
 *     подтверждён прод-пробой 42P10/23502) и продолжается самоцепочкой
 *     (см. lib/sync-chain.ts) — каждый сегмент получает свежие 60 секунд.
 *
 *     Ручной запуск бэкфилла: /api/sync-anime?backfill=1[&from_page=N]
 *     Данные прогресса: sync_status.source='vost_backfill' (details JSON).
 */

const BACKFILL_SOURCE = 'vost_backfill';
/** Страховочный потолок: каталог vost — 361 страница; дальше не лезем. */
const VOST_PAGE_HARD_CAP = 400;

interface ParsedAnime {
  vostId: number;
  title: string;
  titleRussian: string;
  description: string;
  imageUrl: string;
  type: string;
  episodes: number;
  genres: string;
  year: number;
  sourceUrl: string;
  embedUrl: string;
  score: number;
  views: number;
  isAdult: boolean;
}

async function fetchPage(url: string, retries = 2, timeoutMs = 30000): Promise<string> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(JINA_READER + encodeURIComponent(url), {
        headers: jinaHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) return await r.text();
      // 2026-10-04: ключ отвергнут (401/402 — баланс/аутентификация) —
      // следующая попытка цикла пойдёт анонимно (jinaHeaders без ключа)
      if (r.status === 401 || r.status === 402) markJinaKeyRejected(r.status);
    } catch { /* retry */ }
    if (i < retries) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  return '';
}

function parseAnimeCards(html: string): ParsedAnime[] {
  const results: ParsedAnime[] = [];
  // Разбиваем по открывающим тегам shortstory
  const parts = html.split(/<div class="shortstory">/);

  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    try {
      // Ссылка и заголовок из h2 > a (с учётом переносов строк)
      const h2Match = block.match(/<h2>\s*<a href="([^"]+)">([\s\S]*?)<\/a>\s*<\/h2>/);
      if (!h2Match) continue;
      // 2026-10-22: глубокие страницы приходят с v14.vost.pw (v13 отдаёт 301) —
      // нормализуем к v13, иначе плеер/CSP/player-proxy не знают новый домен.
      let sourceUrl = normalizeVostDomain(h2Match[1].trim());
      let rawTitle = h2Match[2].replace(/<[^>]*>/g, '').trim();

      // Убираем [1-10 из 12+] и прочие квадратные скобки
      rawTitle = rawTitle.replace(/\[\d+\s*(?:из|из|\/\s*\d+\+?)?[^\]]*\]/g, '').trim();
      rawTitle = rawTitle.replace(/\[[^\]]*\]/g, '').trim();

      let title = rawTitle;
      let titleRussian = '';
      const slashIdx = rawTitle.indexOf(' / ');
      if (slashIdx > -1) {
        titleRussian = rawTitle.slice(0, slashIdx).trim();
        title = rawTitle.slice(slashIdx + 3).trim();
      } else {
        titleRussian = rawTitle;
      }

      const idMatch = sourceUrl.match(/\/(\d+)-/);
      if (!idMatch) continue;
      const vostId = parseInt(idMatch[1], 10);

      // Изображение (может быть относительный URL)
      const imgMatch = block.match(/<img class="imgRadius" src="([^"]+)"/);
      const imageUrl = imgMatch
        ? (imgMatch[1].startsWith('http') ? imgMatch[1] : VOST_BASE + imgMatch[1])
        : '';

      const yearMatch = block.match(/Год выхода:\s*<\/(?:strong|b)>(\d{4})/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

      const genreMatch = block.match(/Жанр:\s*<\/strong>([\s\S]*?)(?:<\/p>|<p)/);
      const genres = genreMatch ? genreMatch[1].replace(/<[^>]*>/g, '').trim().slice(0, 200) : '';

      const typeMatch = block.match(/Тип:\s*<\/strong>([^<]+)/);
      const type = typeMatch ? typeMatch[1].trim() : 'ТВ';

      const epMatch = block.match(/Количество серий:\s*<\/strong>([^<]+)/);
      let episodes = 0;
      if (epMatch) {
        const numMatch = epMatch[1].trim().match(/(\d+)/);
        if (numMatch) episodes = parseInt(numMatch[1], 10);
      }

      // Рейтинг: <li class="current-rating" style="width:80%;">
      const ratingMatch = block.match(/class="current-rating"[^>]*style="width:\s*(\d+)%/);
      const score = ratingMatch ? parseFloat(ratingMatch[1]) : 0;

      // Просмотры: <span class="staticInfoRightSmotr">1306280</span>
      const viewMatch = block.match(/class="staticInfoRightSmotr">(\d+)/);
      const views = viewMatch ? parseInt(viewMatch[1], 10) : 0;

      // Описание
      const descMatch = block.match(/Описание:\s*<\/strong>([\s\S]*?)(?:<\/p>|<div)/);
      const description = descMatch ? descMatch[1].replace(/<[^>]*>/g, '').trim().slice(0, 1000) : '';

      const isAdult = sourceUrl.includes('/hentai/') || genres.toLowerCase().includes('хентай');

      results.push({
        vostId, title, titleRussian, description, imageUrl, type, episodes,
        genres, year, sourceUrl, embedUrl: sourceUrl, score, views, isAdult,
      });
    } catch { /* skip bad cards */ }
  }
  return results;
}

/** Строка для батч-апсерта (UNIQUE на vost_id — прод-проба октябрь 2026). */
function cardToRow(a: ParsedAnime, updatedAt: string) {
  return {
    vost_id: a.vostId,
    title: a.title || a.titleRussian,
    title_russian: a.titleRussian,
    description: a.description,
    image_url: a.imageUrl,
    type: a.type,
    episodes: a.episodes,
    genres: a.genres,
    year: a.year,
    score: a.score,
    views: a.views,
    source_url: a.sourceUrl,
    embed_url: a.embedUrl,
    is_adult: a.isAdult,
    updated_at: updatedAt,
  };
}

/**
 * Обновление числа серий у УЖЕ добавленных тайтлов (парсер новых серий).
 * Раньше синк добавлял только новые тайтлы с первых страниц, и у старых
 * онгоингов число серий застывало. Теперь добираем последние обновлявшиеся
 * тайтлы, ходим на их страницу-источник и подтягиваем актуальное число серий.
 */
function parseEpisodeCount(html: string): number {
  const m1 = html.match(/Количество серий:\s*<\/strong>\s*(\d+)/);
  if (m1) return parseInt(m1[1], 10);
  const m2 = html.match(/(\d+)\s*сер/); // «12 серий», «3 серия»
  return m2 ? parseInt(m2[1], 10) : 0;
}

async function refreshExistingEpisodes(db: ReturnType<typeof getDb>, limit: number, deadlineMs: number): Promise<number> {
  let episodesUpdated = 0;
  let candidates: { id: number; vost_id: number; episodes: number; source_url: string }[] = [];
  try {
    const { data } = await db
      .from('anime_catalog')
      .select('id, vost_id, episodes, source_url')
      .eq('is_adult', false)
      .gt('episodes', 0)
      // Только вероятные онгоинги: у завершённых тайтлов 2023 года и старше
      // серии никогда не прибавятся — раньше refresh впустую тратил весь
      // бюджет на такие «мёртвые» тайтлы и всегда возвращал episodesUpdated: 0.
      .gte('year', new Date().getFullYear() - 1)
      .order('updated_at', { ascending: true, nullsFirst: true })
      .limit(limit);
    candidates = (data || []) as unknown as typeof candidates;
  } catch (e) {
    console.error('Refresh candidates query failed:', e);
    return 0;
  }

  for (const c of candidates) {
    if (Date.now() > deadlineMs) break; // не выходим за лимит функции
    if (!c.source_url || !c.source_url.includes('vost.pw')) continue;
    // Одна попытка с коротким таймаутом: худший случай 12с, чтобы гарантированно
    // вернуться до жёсткого лимита функции 60с (start ≤ deadline 42с + 12с + финализация).
    const html = await fetchPage(c.source_url, 0, 12000);
    if (!html) continue;
    const actual = parseEpisodeCount(html);
    if (actual > c.episodes) {
      const { error } = await db
        .from('anime_catalog')
        .update({ episodes: actual, updated_at: new Date().toISOString() })
        .eq('id', c.id);
      if (!error) {
        episodesUpdated++;
        console.log(`Episodes refresh: vost ${c.vost_id} ${c.episodes} -> ${actual}`);
      }
    }
    await new Promise(r => setTimeout(r, 800)); // бережём источник и jina
  }
  return episodesUpdated;
}

/** Множество существующих vost_id — чтобы отличать insert от update в апсертах. */
async function loadExistingVostIds(db: ReturnType<typeof getDb>): Promise<Set<number>> {
  const ids = new Set<number>();
  const PAGE = 1000;
  for (let offset = 0; offset < 10_000; offset += PAGE) {
    const { data, error } = await db
      .from('anime_catalog')
      .select('vost_id')
      .gt('vost_id', 0)
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    for (const r of (data || []) as { vost_id: number }[]) ids.add(r.vost_id);
    if (!data || data.length < PAGE) break;
  }
  return ids;
}

/** Один сегмент бэкфилла: пройти страницы [fromPage, fromPage+budget) и
 *  вернуть, был ли прогресс (для решения о продолжении цепочки). */
async function runBackfillSegment(
  db: ReturnType<typeof getDb>,
  st: BackfillState,
  budgetPages: number,
  deadlineMs: number,
): Promise<{ parsed: number; inserted: number; updated: number; pagesWalked: number }> {
  let existingIds: Set<number>;
  try {
    existingIds = await loadExistingVostIds(db);
  } catch {
    existingIds = new Set(); // метрика станет неточной, апсерты всё равно корректны
  }

  let parsed = 0, inserted = 0, updated = 0, pagesWalked = 0;
  let fetchFails = 0;

  while (!st.done && pagesWalked < budgetPages && Date.now() < deadlineMs) {
    const page = st.next_page;
    if (page > VOST_PAGE_HARD_CAP) {
      st.done = true;
      st.note = `page cap ${VOST_PAGE_HARD_CAP}`;
      break;
    }
    const url = `${VOST_BASE}/page/${page}/`;
    const html = await fetchPage(url, 1, 20000);
    if (!html || html.length < 5000) {
      // Сеть/Jina недоступны — это НЕ «конец источника»: страницу не засчитываем,
      // после двух отказов подряд останавливаем сегмент (источник нездоров).
      fetchFails++;
      if (fetchFails >= 2) {
        console.log(`Backfill vost: fetch failed twice at page ${page}, stopping segment`);
        break;
      }
      continue;
    }
    fetchFails = 0;
    const cards = parseAnimeCards(html);
    if (cards.length === 0) {
      st.consecutive_empty++;
      console.log(`Backfill vost: page ${page} — 0 cards (streak ${st.consecutive_empty})`);
      if (st.consecutive_empty >= 2) {
        // За последней страницей каталога источник отдаёт пустую выдачу (200)
        st.done = true;
        st.note = 'источник исчерпан (2 подряд пустые страницы)';
        st.finished_at = new Date().toISOString();
        break;
      }
      // Одна пустая среди заполненных — прокладка/разделитель, идём дальше
      st.next_page = page + 1;
      st.pages_done++;
      pagesWalked++;
      await saveBackfillState(BACKFILL_SOURCE, st);
      continue;
    }

    const updatedAt = new Date().toISOString();
    const rows = cards.map(a => cardToRow(a, updatedAt));
    const { error: upErr } = await db
      .from('anime_catalog')
      .upsert(rows, { onConflict: 'vost_id' });
    if (upErr) {
      console.error(`Backfill vost page ${page} upsert:`, upErr.message);
      break; // не двигаем курсор: следующая попытка начнёт с этой же страницы
    }

    // Отличаем insert от update по множеству существующих id
    let pageInserted = 0, pageUpdated = 0;
    for (const a of cards) {
      if (existingIds.has(a.vostId)) pageUpdated++;
      else { pageInserted++; existingIds.add(a.vostId); }
    }
    parsed += cards.length;
    inserted += pageInserted;
    updated += pageUpdated;
    st.inserted += pageInserted;
    st.updated += pageUpdated;
    st.next_page = page + 1;
    st.pages_done++;
    st.consecutive_empty = 0;
    pagesWalked++;
    console.log(`Backfill vost: page ${page} upsert ${cards.length} cards (new ${pageInserted}, upd ${pageUpdated})`);

    // Прогресс — в БД на каждой странице: обрыв теряет максимум одну страницу
    await saveBackfillState(BACKFILL_SOURCE, st);

    await new Promise(r => setTimeout(r, 2000)); // бережём источник и jina
  }

  return { parsed, inserted, updated, pagesWalked };
}

export async function GET(request: Request) {
  // F-01 fix: кроны авторизуются через Bearer CRON_SECRET; админ-сессия —
  // для watchdog/ручного запуска (аудит 27.09.2026).
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
    const hop = Math.max(1, Math.min(parseInt(searchParams.get('hop') || '1', 10) || 1, 200));
    const chainOn = searchParams.get('chain') !== '0';
    const MAX_HOPS = 45; // 45 сегментов × ~8 стр ≈ весь каталог за сессию

    const st: BackfillState = { ...state, next_page: fromPage };
    // Явный from_page меньше сохранённого курсора = ручной сброс прогресса
    // (например, источник вырос и нужно пройти заново) — снимаем done.
    if (searchParams.has('from_page') && fromPage < state.next_page) {
      st.done = false;
      st.consecutive_empty = 0;
      st.note = 'перезапуск по from_page';
    }
    const deadline = startedAt + 44_000; // запас на финальный save + цепочку
    const db = getDb();
    const seg = await runBackfillSegment(db, st, budgetPages, deadline);

    const justFinished = st.done && !state.done;
    await saveBackfillState(BACKFILL_SOURCE, st);

    logEvent('cron_sync_anime_backfill', {
      from_page: fromPage, next_page: st.next_page, done: st.done, hop,
      parsed: seg.parsed, inserted: seg.inserted, updated: seg.updated,
    });

    if (justFinished) {
      // Итоговое сообщение за весь бэкфилл (не на каждый сегмент — иначе спам)
      await notifyTelegram(
        `🏁 Бэкфилл vost завершён: страниц пройдено ${st.pages_done}, ` +
        `новых тайтлов ${st.inserted}, обновлено ${st.updated}.` +
        `\nКаталог теперь покрывает весь архив источника.`,
      );
    }

    let chained = false;
    if (!st.done && chainOn && hop < MAX_HOPS && seg.pagesWalked > 0) {
      fireChainNext(buildChainUrl('/api/sync-anime', {
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
      parsedThisSegment: seg.parsed,
      insertedThisSegment: seg.inserted,
      updatedThisSegment: seg.updated,
      totals: { pages_done: st.pages_done, inserted: st.inserted, updated: st.updated },
      chained,
    });
  }

  // ── ОБЫЧНЫЙ РЕЖИМ (мелкий ежедневный) ─────────────────────────────────
  const pagesToParse = Math.max(1, Math.min(parseInt(searchParams.get('pages') || '4'), 10));
  // ongoing=N — страницы категории /ongoing/ (сериалы текущего сезона).
  // Именно там живут вышедшие сериалы, которых нет в первых страницах каталога.
  const ongoingPages = Math.max(0, Math.min(parseInt(searchParams.get('ongoing') || '0') || 0, 5));
  // refresh=N — сколько давно не обновлявшихся тайтлов проверить на новые серии
  const refreshCount = Math.max(0, Math.min(parseInt(searchParams.get('refresh') || '0') || 0, 60));

  try {
    const db = getDb();
    let totalNew = 0;
    let totalUpdated = 0;

    // Список страниц каталога: сначала онгоинги (сериалы сезона), затем
    // обычные «последние добавления». Дубли vostId между списками не страшны:
    // upsert ниже сводит их к обновлению.
    const catalogUrls: string[] = [];
    for (let o = 1; o <= ongoingPages; o++) {
      catalogUrls.push(o === 1 ? `${VOST_BASE}/ongoing/` : `${VOST_BASE}/ongoing/page/${o}/`);
    }
    for (let p = 1; p <= pagesToParse; p++) {
      catalogUrls.push(`${VOST_BASE}/page/${p}/`);
    }

    for (let i = 0; i < catalogUrls.length; i++) {
      const url = catalogUrls[i];
      // Защита от каскадного зависания Jina: если время уже ушло, вторую и
      // дальше страницы не начинаем (иначе жёсткий kill на 60с = 504 и без статуса).
      if (i > 0 && Date.now() > startedAt + 25_000) {
        console.log(`Sync anime: page budget exhausted before ${url}, stopping`);
        break;
      }
      const html = await fetchPage(url);
      if (!html || html.length < 5000) continue;

      const animeList = parseAnimeCards(html);
      console.log(`Page ${url}: parsed ${animeList.length} anime`);

      for (const anime of animeList) {
        const { data: existing } = await db
          .from('anime_catalog')
          .select('id')
          .eq('vost_id', anime.vostId)
          .maybeSingle();

        if (existing) {
          const { error } = await db
            .from('anime_catalog')
            .update({
              title: anime.title,
              title_russian: anime.titleRussian,
              description: anime.description,
              image_url: anime.imageUrl,
              type: anime.type,
              episodes: anime.episodes,
              genres: anime.genres,
              year: anime.year,
              score: anime.score,
              views: anime.views,
              embed_url: anime.embedUrl,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id);
          if (!error) totalUpdated++;
        } else {
          const { error } = await db
            .from('anime_catalog')
            .insert({
              vost_id: anime.vostId,
              title: anime.title || anime.titleRussian,
              title_russian: anime.titleRussian,
              description: anime.description,
              image_url: anime.imageUrl,
              type: anime.type,
              episodes: anime.episodes,
              genres: anime.genres,
              year: anime.year,
              score: anime.score,
              views: anime.views,
              source_url: anime.sourceUrl,
              embed_url: anime.embedUrl,
              is_adult: anime.isAdult,
            });
          if (!error) totalNew++;
          else console.error('Insert error:', error.message);
        }
      }

      if (i < catalogUrls.length - 1) await new Promise(r => setTimeout(r, 3000));
    }

    // Парсер новых серий у существующих тайтлов (внутри общего бюджета времени)
    let episodesUpdated = 0;
    if (refreshCount > 0) {
      const deadline = startedAt + 42_000; // оставляем запас до лимита функции
      episodesUpdated = await refreshExistingEpisodes(db, refreshCount, deadline);
    }

    // F-13 fix: ежедневная очистка истёкших сессий — инфраструктура кронов
    // уже есть, поэтому раз в сутки подметаем таблицу sessions (best-effort:
    // падение очистки не валит синхронизацию).
    let sessionsCleaned = -1;
    try {
      sessionsCleaned = await cleanupExpiredSessions();
    } catch (e) {
      console.error('Sessions cleanup failed:', e);
    }

    logEvent('cron_sync_anime', { pages: pagesToParse, ongoingPages, newAnime: totalNew, updatedAnime: totalUpdated, episodesUpdated, sessionsCleaned });
    await recordSyncRun('vost', {
      status: 'ok',
      newItems: totalNew,
      updatedItems: totalUpdated,
      details: { pages: pagesToParse, episodesUpdated, sessionsCleaned, durationMs: Date.now() - startedAt },
    });
    await notifyTelegram(
      `✅ Синк аниме: +${totalNew} новых, обновлено ${totalUpdated}, новых серий: ${episodesUpdated}` +
      `\nСтраниц: ${pagesToParse}, сессий чистил: ${sessionsCleaned}`,
    );

    // ── Автозапуск бэкфилла, если полный проход ещё не завершён ────────
    let backfillChained = false;
    try {
      const st = await loadBackfillState(BACKFILL_SOURCE);
      if (!st.done) {
        fireChainNext(buildChainUrl('/api/sync-anime', {
          backfill: 1,
          from_page: st.next_page,
          hop: 1,
          chain: 1,
        }));
        backfillChained = true;
      }
    } catch { /* состояние недоступно — попробуем в следующий крон */ }

    return NextResponse.json({
      ok: true,
      pagesParsed: pagesToParse,
      ongoingPages,
      newAnime: totalNew,
      updatedAnime: totalUpdated,
      episodesUpdated,
      sessionsCleaned,
      backfillChained,
    });
  } catch (e) {
    console.error('Sync error:', e);
    await recordSyncRun('vost', { status: 'error', error: String(e).slice(0, 500), details: { durationMs: Date.now() - startedAt } });
    await notifyTelegram(`❌ Синк аниме упал: ${String(e).slice(0, 300)}`);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}
