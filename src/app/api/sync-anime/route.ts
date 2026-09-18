import { NextResponse } from 'next/server';
import { getDb, cleanupExpiredSessions } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { logEvent } from '@/lib/logger';
import { notifyTelegram } from '@/lib/notify';
import { recordSyncRun } from '@/lib/sync-status';
import { VOST_BASE, JINA_READER } from '@/lib/sources'; // F-27: домены из единого реестра

// Лимит времени функции: крон парсит страницы + refresh новых серий.
// 60с — максимум для Hobby-плана Vercel.
export const maxDuration = 60;

/**
 * Парсер новых аниме с v13.vost.pw.
 * Крон Vercel вызывает ежедневно без secret (авторизация через заголовок
 * x-vercel-cron / Bearer CRON_SECRET — см. src/lib/cron-auth.ts).
 * Ручной запуск: GET /api/sync-anime?pages=3&secret=<SYNC_SECRET|CRON_SECRET>
 * pages — сколько последних страниц каталога парсить (по умолчанию 3 = ~30 новых аниме)
 * ongoing — сколько страниц категории /ongoing/ парсить (онгоинги = сериалы
 * текущего сезона; сайт публикует их реже, чем обновляет первые страницы,
 * из-за чего полка «Свежее за неделю» пустела)
 */

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
        headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) return await r.text();
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
      let sourceUrl = h2Match[1].trim();
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

/**
 * Обновление числа серий у УЖЕ добавленных тайтлов (парсер новых серий).
 * Раньше синк добавлял только новые тайтлы с первых страниц, и у старых
 * онгоингов число серий застывало. Теперь дорбираем последние обновлявшиеся
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

export async function GET(request: Request) {
  // F-01 fix: раньше требовался ?secret=<SYNC_SECRET>, но переменная была не задана
  // и оба крона всегда падали 403. Теперь кроны авторизуются через x-vercel-cron.
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const pagesToParse = Math.max(1, Math.min(parseInt(searchParams.get('pages') || '3'), 10));
  // ongoing=N — страницы категории /ongoing/ (сериалы текущего сезона).
  // Именно там живут вышедшие сериалы, которых нет в первых страницах каталога.
  const ongoingPages = Math.max(0, Math.min(parseInt(searchParams.get('ongoing') || '0') || 0, 5));
  // refresh=N — сколько давно не обновлявшихся тайтлов проверить на новые серии
  const refreshCount = Math.max(0, Math.min(parseInt(searchParams.get('refresh') || '0') || 0, 50));
  const startedAt = Date.now();

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
    return NextResponse.json({
      ok: true,
      pagesParsed: pagesToParse,
      ongoingPages,
      newAnime: totalNew,
      updatedAnime: totalUpdated,
      episodesUpdated,
      sessionsCleaned,
    });
  } catch (e) {
    console.error('Sync error:', e);
    await recordSyncRun('vost', { status: 'error', error: String(e).slice(0, 500), details: { durationMs: Date.now() - startedAt } });
    await notifyTelegram(`❌ Синк аниме упал: ${String(e).slice(0, 300)}`);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}
