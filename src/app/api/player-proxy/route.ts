import { NextRequest, NextResponse } from 'next/server';
import { validateExternalUrlWithDns } from '@/lib/url-guard';
import { withRateLimit } from '@/lib/with-rate-limit';
import { BoundedTTLCache } from '@/lib/cache';
import { logEvent } from '@/lib/logger';
import { PLAYER_PROXY_ALLOWED_HOSTS as ALLOWED_HOSTS, JINA_READER } from '@/lib/sources'; // F-27
import { extractVostId, fetchSeriesFromApi } from '@/lib/vost-series'; // ФИКС 26.09.2026: серии через API animevost
import {
  loadCachedPage,
  saveCachedPage,
  loadCachedVideo,
  saveCachedVideo,
  PAGE_TTL_MS,
  PAGE_STALE_MAX_MS,
  VIDEO_TTL_MS,
  VIDEO_STALE_MAX_MS,
} from '@/lib/player-cache'; // ФИКС 3: персистентный кэш в sync_status

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ── Allowed domains for proxy (prevent SSRF) — белый список в @/lib/sources ──

const CACHE = new BoundedTTLCache<string, { entries: [string, string][]; timestamp: number }>(200, 30 * 60 * 1000);

/**
 * Кэш разобранного плеера frame5.php (качества + постер).
 * TTL 20 минут: ссылки CDN содержат time-токены (проверено — живут часы),
 * но перестраховка от протухания + освежение зеркал.
 */
const VCACHE = new BoundedTTLCache<string, { qualities: { label: string; urls: string[] }[]; poster: string }>(
  400,
  20 * 60 * 1000,
);

const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function isAllowedHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

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
    return Object.entries(data);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ФИКС «аниме-плеер показывает чёрный экран, время тикает» (18.09.2026):
//
// Диагноз: v13.vost.pw отдаёт frame5.php (страницу плеера) реальным браузерам
// через HTTP/2 с бесконечным зависанием — iframe грузится вечно, пользователь
// видит чёрный прямоугольник; тикает лишь таймер автоперехода сайта. Curl по
// HTTP/1.1 при этом получает ответ — но браузеры HTTP/1.1 не используют.
//
// Решение (по образцу работающего /api/hb-player для хентая):
//   1) сервер САМ скачивает frame5.php?play=<id>&player=9&old=1 (Node fetch =
//      HTTP/1.1 — работает; несколько попыток с разными заголовками, т.к.
//      анти-бот vost.pw нестабилен);
//   2) вытаскивает конфиг Playerjs: "file":"[SD (480p)]url or url,…,poster";
//   3) отдаёт СОБСТВЕННУЮ страницу с нативным HTML5-<video> и прямыми mp4
//      (CDN tigerlips.org / trn.su не имеют hotlink-защиты — проверено
//      запросами с чужим Referer), с кнопками качества и автопереключением
//      зеркал при ошибке.
//
// Браузер пользователя больше вообще не обращается к vost.pw — только к нашему
// origin (iframe) и к видео-CDN (поток). Если разбор конфига не удался —
// откат на старый iframe-вариант (деградация до прежнего поведения).
// ─────────────────────────────────────────────────────────────────────────────
// ФИКС 26.09.2026 «плееры опять не работают»: vost.pw ВЫРЕЗАЛ список серий из
// HTML-страниц («var data = ;» — пустой). Живой разбор страницы теперь всегда
// проигрывает, вне кэша пользователь получал «Не удалось загрузить серии».
// Список серий переехал в публичный API api.animevost.org/GetInfo/{id} (поле
// series — питонья строка-словарь), а frame5.php и видео-CDN работают как
// раньше. Цепочка: кэш → API (быстро, ~0.3с) → HTML-разбор (фолбэк).
// ─────────────────────────────────────────────────────────────────────────────

// ── Телеметрия каналов (для &debug=1 и логов) ────────────────────────────────
interface ChannelDiag {
  directAttempted: boolean;
  directResult: string;      // 'ok' | 'timeout' | 'http-4xx/5xx' | 'skipped-blocked' | 'skipped-not-needed'
  jinaAttempted: boolean;
  jinaResult: string;        // 'ok' | 'timeout' | 'http-NNN' | 'invalid' | 'not-attempted'
}
const emptyDiag = (): ChannelDiag => ({
  directAttempted: false, directResult: 'not-attempted',
  jinaAttempted: false, jinaResult: 'not-attempted',
});
let DIAG: Record<string, ChannelDiag> = {};

// ── Диагностика API animevost (?debug=1): 'ok(N)' | 'announced' | 'http-NNN' | 'timeout' | 'no-id' | 'not-attempted'
let API_DIAG = 'not-attempted';

// ── Здоровье прямого канала к vost.pw (состояние инстанса) ──────────────────
// После сбоя прямых запросов (тартпит) 10 минут ходим ТОЛЬКО через Jina Reader:
// тише для анти-бота (бан кончается быстрее) и быстрее для пользователя.
let vostDirectBlockedUntil = 0;
const VOST_DIRECT_BLOCK_MS = 10 * 60 * 1000;

function vostDirectAllowed(): boolean {
  return Date.now() >= vostDirectBlockedUntil;
}

/** Живой запрос к vost.pw с повтором. ОДИН запрос за раз (анти-бот банит IP по
 * всплескам): при тартпите таймаут рвёт соединение, повтор свежим соединением
 * часто проходит. У каждой попытки свой таймаут. */
async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  timeoutsMs: number[],
  isValid: (html: string) => boolean,
  diag?: ChannelDiag,
): Promise<string | null> {
  let lastResult = 'timeout';
  for (const timeoutMs of timeoutsMs) {
    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (resp.ok) {
        const html = await resp.text();
        if (isValid(html)) return html;
        lastResult = 'invalid-content';
      } else {
        lastResult = `http-${resp.status}`;
      }
    } catch {
      lastResult = 'timeout';
    }
  }
  if (diag) diag.directResult = lastResult;
  return null;
}

/** Запрос через Jina Reader (r.jina.ai): страница приходит с IP инфраструктуры
 * Jina — egress Vercel невидим для анти-бота vost.pw. Тот же приём использует
 * дневной /api/sync-anime (потому крон и работает стабильно). */
async function fetchViaJina(url: string, timeoutMs: number, diag?: ChannelDiag): Promise<string | null> {
  try {
    const resp = await fetch(JINA_READER + encodeURIComponent(url), {
      headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      if (diag) diag.jinaResult = `http-${resp.status}`;
      return null;
    }
    const html = await resp.text();
    if (html.length <= 200) {
      if (diag) diag.jinaResult = 'too-short';
      return null;
    }
    return html;
  } catch {
    if (diag) diag.jinaResult = 'timeout';
    return null;
  }
}

/** Двухканальный запрос: прямой (если канал здоров) → Jina Reader.
 * Бюджет worst-case: страница 18+12+10=40с, видео 7+6+6=19с (после сбоя
 * страницы видео идёт сразу в Jina: 40+6=46с < 60с maxDuration). */
async function fetchVostHtml(
  url: string,
  directHeaders: Record<string, string>,
  directTimeouts: number[],
  jinaTimeoutMs: number,
  isValid: (html: string) => boolean,
  diagKey?: string,
): Promise<string | null> {
  const diag = diagKey ? (DIAG[diagKey] = emptyDiag()) : undefined;
  let usedJina = false;

  if (vostDirectAllowed()) {
    if (diag) { diag.directAttempted = true; diag.directResult = 'timeout'; }
    const direct = await fetchWithRetry(url, directHeaders, directTimeouts, isValid, diag);
    if (direct) {
      vostDirectBlockedUntil = 0; // канал жив — сбрасываем блокировку
      if (diag) diag.directResult = 'ok';
      return direct;
    }
    // Прямой канал душится: помечаем и уходим в Jina
    vostDirectBlockedUntil = Date.now() + VOST_DIRECT_BLOCK_MS;
    usedJina = true;
  } else {
    usedJina = true; // сразу Jina (в окне блокировки)
    if (diag) diag.directResult = 'skipped-blocked';
  }

  if (diag) { diag.jinaAttempted = true; }
  const jina = await fetchViaJina(url, jinaTimeoutMs, diag);
  if (jina && isValid(jina)) {
    if (diag) diag.jinaResult = 'ok';
    if (usedJina) logEvent('player_jina_fallback', { url: url.slice(0, 120) }, 'info');
    return jina;
  }
  if (diag && jina && !isValid(jina)) diag.jinaResult = 'invalid-content';
  return null;
}

/** Скачать конфиг плеера frame5.php: прямой канал → Jina. */
async function fetchEmbedPage(embedUrl: string): Promise<string | null> {
  return fetchVostHtml(
    embedUrl,
    { 'User-Agent': FETCH_UA, Referer: 'https://v13.vost.pw/' },
    [7_000, 6_000],
    6_000,
    (html) => html.includes('Playerjs') || html.includes('.mp4'),
    'video',
  );
}

/** Освежить список серий (фоновая задача для просроченного кэша):
 * API animevost (быстро, без анти-бота) → HTML-страница (фолбэк). */
async function refreshSeriesEntries(pageUrl: string): Promise<[string, string][] | null> {
  const vostId = extractVostId(pageUrl);
  if (vostId) {
    const api = await fetchSeriesFromApi(vostId);
    if (api?.entries) return api.entries;
  }
  const html = await fetchVostHtml(
    pageUrl,
    {
      'User-Agent': FETCH_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    [18_000, 12_000],
    10_000,
    (h) => h.includes('var data = '),
  );
  return html ? parseEpisodeData(html) : null;
}

/** Только https-ссылки без опасных символов — попадут в HTML-атрибуты src. */
function sanitizeMediaUrl(u: string): string | null {
  const t = u.trim();
  if (!/^https:\/\//i.test(t)) return null;
  if (/["'<>\s]/.test(t)) return null;
  return t;
}

interface ParsedPlayer {
  qualities: { label: string; urls: string[] }[];
  poster: string;
}

/**
 * Разбор конфига Playerjs из frame5.php.
 * Формат "file": "[SD (480p)]url1 or url2 or …,[HD (720р)]url or …"
 * Ссылки с параметром ip= привязаны к чужому IP-адресу — пропускаем их.
 */
function parsePlayerConfig(html: string): ParsedPlayer | null {
  const cfgMatch = html.match(/new\s+Playerjs\(\s*(\{[\s\S]*?\})\s*\)/);
  if (!cfgMatch) return null;
  const cfg = cfgMatch[1];

  const fileMatch = cfg.match(/"file"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!fileMatch) return null;
  const fileStr = fileMatch[1]
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"');

  const qualities: { label: string; urls: string[] }[] = [];
  // Режем по запятым ПЕРЕД открывающей скобкой следующего качества
  const segments = fileStr.split(/,\s*(?=\[)/);
  for (const seg of segments) {
    const m = seg.match(/^\[([^\]]{1,30})\](.+)/);
    if (!m) continue;
    const label = m[1].replace(/["'<>]/g, '');
    const variants = m[2].split(/\s+or\s+/i).map(sanitizeMediaUrl).filter((u): u is string => !!u);
    // приоритет — ссылки без привязки к IP
    const free = variants.filter(u => !/[?&]ip=/.test(u));
    const urls = free.length ? free : variants;
    if (urls.length) qualities.push({ label, urls });
  }
  if (!qualities.length) return null;

  const posterMatch = cfg.match(/"poster"\s*:\s*"([^"]+)"/);
  const poster = posterMatch ? sanitizeMediaUrl(posterMatch[1].replace(/\\\//g, '/')) || '' : '';

  return { qualities, poster };
}

async function playerProxyHandler(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawUrl = searchParams.get('url');
    const episode = parseInt(searchParams.get('episode') || '1', 10);
    const debugMode = searchParams.get('debug') === '1'; // телеметрия каналов в HTML-комментарии
    DIAG = {};
    API_DIAG = 'not-attempted';

    if (!rawUrl) {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    // SSRF protection: validate URL and check allowed hosts (F-14: + DNS-резолв)
    const safeUrl = await validateExternalUrlWithDns(rawUrl);
    if (!safeUrl || !isAllowedHost(safeUrl)) {
      logEvent('ssrf_blocked', { url: rawUrl.slice(0, 200), host: new URL(safeUrl || 'http://x').hostname }, 'warn');
      return NextResponse.json({ error: 'URL not allowed' }, { status: 403 });
    }

    // ── Список серий: память → БД (sync_status) → API animevost → HTML (фолбэк) ──
    // ФИКС 3: vost.pw тартпит egress-IP по всплескам запросов, поэтому
    // живой поход — редкость (раз в 12ч на тайтл), остальное берём из БД,
    // переживая рестарты инстансов; при сбое источника отдаём ПРОСРОЧЕННЫЙ кэш.
    // ФИКС 26.09.2026: живой поход идёт в API animevost (~0.3с, без анти-бота) —
    // HTML-страницы vost.pw больше не содержат список серий (var data = ;).
    let entries: [string, string][] | null = null;
    const cached = CACHE.get(safeUrl);

    if (cached) {
      entries = cached.entries;
    } else {
      let stale: [string, string][] | null = null;
      let staleAge = Infinity;

      const dbPage = await loadCachedPage(safeUrl);
      if (dbPage) {
        if (dbPage.age <= PAGE_TTL_MS) {
          entries = dbPage.entries;
          CACHE.set(safeUrl, { entries, timestamp: Date.now() });
        } else {
          stale = dbPage.entries;
          staleAge = dbPage.age;
        }
      }

      if (!entries && stale && staleAge <= PAGE_STALE_MAX_MS) {
        // ФИКС 3e: просроченный список отдаём МГНОВЕННО, не заставляя пользователя
        // ждать живого освежения (в волны тартпита это 40с). Освежение уходит в
        // фон: если дочерпнёт — следующий пользователь получит свежие данные;
        // нет — ребейз возраста всё равно прикрывает следующие 20ч.
        entries = stale;
        CACHE.set(safeUrl, { entries, timestamp: Date.now() });
        void (async () => {
          const fresh = await refreshSeriesEntries(safeUrl);
          if (fresh) await saveCachedPage(safeUrl, fresh);
          else await saveCachedPage(safeUrl, entries!); // ребейз: волна тартпита не ретраится каждым запросом
        })();
        logEvent('player_stale_page', { url: safeUrl.slice(0, 120), ageH: Math.round(staleAge / 3.6e6) }, 'warn');
      }

      // Кэша нет вовсе — быстрый API animevost (основной живой путь),
      // при его недоступности — прежний живой HTML-запрос (фолбэк).
      if (!entries) {
        const vostId = extractVostId(safeUrl);
        if (vostId) {
          const api = await fetchSeriesFromApi(vostId);
          if (api?.entries) {
            API_DIAG = `ok(${api.entries.length})`;
            entries = api.entries;
            CACHE.set(safeUrl, { entries, timestamp: Date.now() });
            void saveCachedPage(safeUrl, entries); // персистентно, не блокируя ответ
          } else if (api?.announced) {
            // API ответил: тайтл существует, но серий ещё нет (анонс) —
            // честная страница вместо 40с ожидания и «Не удалось загрузить серии»
            API_DIAG = 'announced';
            logEvent('player_announced', { vostId, title: (api.title || '').slice(0, 80) }, 'info');
            const dc = debugMode ? `<!-- player-diag: ${JSON.stringify({ api: API_DIAG, ...DIAG })} -->` : '';
            return new NextResponse(
              errorPage('Серии этого тайтла ещё не вышли — он анонсирован. Загляните позже!') + dc,
              { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
            );
          } else {
            API_DIAG = 'fail';
          }
        } else {
          API_DIAG = 'no-id';
        }

        // Фолбэк: API не дал серий — живой HTML-запрос (единственный БЛОКИРУЮЩИЙ,
        // первый визит на тайтл; вне волн — 1-2с, в волну — до 40с)
        if (!entries) {
          const html = await fetchVostHtml(
            safeUrl,
            {
              'User-Agent': FETCH_UA,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            [18_000, 12_000],
            10_000, // Jina бесполезна в волны тартпита (422: её краулер тоже не пробивается) — короткий таймаут
            (h) => h.includes('var data = '),
            'page',
          );

          if (html) {
            entries = parseEpisodeData(html);
            if (entries) {
              CACHE.set(safeUrl, { entries, timestamp: Date.now() });
              void saveCachedPage(safeUrl, entries); // персистентно, не блокируя ответ
            }
          }
        }
      }
    }

    if (!entries || entries.length === 0) {
      const dc = debugMode ? `<!-- player-diag: ${JSON.stringify({ api: API_DIAG, ...DIAG })} -->` : '';
      return new NextResponse(errorPage('Не удалось загрузить серии. Попробуйте обновить.') + dc, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const epIdx = Math.min(Math.max(episode - 1, 0), entries.length - 1);
    const [label, id] = entries[epIdx];
    // S-02 FIX: sanitize id and label — prevent XSS in iframe src and title
    const safeId = String(id).replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 100);
    const safeLabel = String(label).replace(/<[^>]*>/g, '').replace(/['"]/g, '').slice(0, 200);
    const urlObj = new URL(safeUrl);
    // &old=1 — принудительный HTTP-плеер (Playerjs, прямые mp4)
    const embedUrl = `${urlObj.protocol}//${urlObj.host}/frame5.php?play=${encodeURIComponent(safeId)}&player=9&old=1`;

    // ── Конфиг видео: память → БД → живой запрос (с stale-grace) ──
    const vKey = `${urlObj.host}:${safeId}`;
    let parsed = VCACHE.get(vKey) || null;

    if (!parsed) {
      let staleCfg: { qualities: { label: string; urls: string[] }[]; poster: string } | null = null;
      let staleAge = Infinity;

      const dbVideo = await loadCachedVideo(urlObj.host, safeId);
      if (dbVideo) {
        if (dbVideo.age <= VIDEO_TTL_MS) {
          parsed = { qualities: dbVideo.qualities, poster: dbVideo.poster };
          VCACHE.set(vKey, parsed);
        } else {
          staleCfg = { qualities: dbVideo.qualities, poster: dbVideo.poster };
          staleAge = dbVideo.age;
        }
      }

      // ФИКС 3e: просроченный конфиг (CDN-ссылки живут часы) отдаём МГНОВЕННО,
      // освежение — в фон. Пользователь больше не ждёт 26с тартпита ради
      // освежения ссылок, которые и так ещё работают.
      if (!parsed && staleCfg && staleAge <= VIDEO_STALE_MAX_MS) {
        parsed = staleCfg;
        VCACHE.set(vKey, parsed);
        void (async () => {
          const embedHtml = await fetchEmbedPage(embedUrl);
          if (embedHtml) {
            const p = parsePlayerConfig(embedHtml);
            if (p) await saveCachedVideo(urlObj.host, safeId, p);
          }
        })();
        logEvent('player_stale_video', { key: vKey.slice(0, 60), ageMin: Math.round(staleAge / 6e4) }, 'warn');
      }

      // Кэша нет вовсе — единственный БЛОКИРУЮЩИЙ живой запрос (первый показ серии)
      if (!parsed) {
        const embedHtml = await fetchEmbedPage(embedUrl);
        if (embedHtml) {
          const p = parsePlayerConfig(embedHtml);
          if (p) {
            parsed = p;
            VCACHE.set(vKey, p);
            void saveCachedVideo(urlObj.host, safeId, p);
          }
        }
      }
    }

    const diagComment = debugMode ? `\n<!-- player-diag: ${JSON.stringify({ api: API_DIAG, ...DIAG })} -->` : '';

    if (parsed) {
      return new NextResponse(videoPlayerPage(parsed.qualities, parsed.poster, safeLabel) + diagComment, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // ── Фолбэк: видео-конфиг не получен. Прежний iframe-вариант УДАЛЁН:
    // браузеры зависают на HTTP/2 vost.pw (исходный «чёрный экран»), пользы
    // от него ноль. Вместо этого — страница с автоповтором: за 45с волна
    // тартпита может пройти, а фоновое освежение от других запросов — дописать
    // конфиг в БД. Один автоповтор (?r=1), дальше — ручная кнопка.
    const retryUrl = new URL(request.url);
    const isRetry = retryUrl.searchParams.get('r') === '1';
    if (!isRetry) retryUrl.searchParams.set('r', '1');
    return new NextResponse(
      retryPlayerPage(retryUrl.toString(), safeLabel, isRetry) + diagComment,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  } catch {
    return new NextResponse(errorPage('Ошибка загрузки плеера.'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

export const GET = withRateLimit(playerProxyHandler, '/api/player-proxy')

/* ────────────────── Собственная страница плеера ────────────────── */

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function videoPlayerPage(
  qualities: { label: string; urls: string[] }[],
  poster: string,
  title: string,
): string {
  // Данные для JS: JSON безопасен внутри <script>, экранируем только </script
  const dataJson = JSON.stringify(qualities).replace(/<\//g, '<\\/');
  const posterAttr = poster ? ` poster="${escapeAttr(poster)}"` : '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="frame-ancestors 'self'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeAttr(title)}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:100%;height:100%;overflow:hidden;background:#000;font-family:system-ui,sans-serif}
    #wrap{position:relative;width:100%;height:100%}
    video{width:100%;height:100%;object-fit:contain;background:#000}
    #load{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);transition:opacity .3s}
    #load .spin{width:46px;height:46px;border:3px solid rgba(168,85,247,.25);border-top-color:#a855f7;border-radius:50%;animation:sp 1s linear infinite}
    @keyframes sp{to{transform:rotate(360deg)}}
    #qbar{position:absolute;top:8px;right:8px;display:flex;gap:6px;z-index:5}
    #qbar button{padding:4px 10px;border:1px solid rgba(255,255,255,.25);border-radius:6px;background:rgba(15,10,25,.75);color:#ddd;font-size:12px;cursor:pointer;backdrop-filter:blur(4px)}
    #qbar button.on{background:rgba(168,85,247,.85);border-color:rgba(216,180,254,.6);color:#fff;font-weight:600}
    #err{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(0,0,0,.85);color:#d8b4fe;text-align:center;padding:1rem}
    #err b{font-size:15px}
    #err small{color:#6b21a8;font-size:12px}
    #err button{margin-top:4px;padding:8px 18px;border:none;border-radius:8px;background:linear-gradient(135deg,#a855f7,#7c3aed);color:#fff;font-size:14px;cursor:pointer}
  </style>
</head>
<body>
  <div id="wrap">
    <video id="v" controls playsinline preload="metadata" controlslist="nodownload"${posterAttr}></video>
    <div id="qbar"></div>
    <div id="load"><div class="spin"></div></div>
    <div id="err"><b id="errmsg">Ошибка воспроизведения</b><small>Источник видео недоступен или ссылка устарела</small><button onclick="location.reload()">Обновить</button></div>
  </div>
  <script>
  (function(){
    var QUALITIES = ${dataJson};
    var v = document.getElementById('v'), load = document.getElementById('load'),
        err = document.getElementById('err'), qbar = document.getElementById('qbar');
    // Качество по умолчанию: HD/720 при наличии, иначе первое
    var qi = (function(){
      for (var i = 0; i < QUALITIES.length; i++) {
        if (/720|HD/i.test(QUALITIES[i].label)) return i;
      }
      return 0;
    })();
    var mi = 0; // индекс зеркала внутри качества
    var startedAt = 0, wasPlaying = false;

    function src(){ return QUALITIES[qi].urls[mi]; }
    function applySrc(keepTime){
      var t = keepTime ? v.currentTime : 0, play = keepTime && wasPlaying;
      v.src = src();
      if (keepTime && t > 0.5) {
        v.addEventListener('loadedmetadata', function once(){
          v.removeEventListener('loadedmetadata', once);
          try { v.currentTime = t; } catch(e){}
          if (play) v.play().catch(function(){});
        });
      }
      renderQbar();
    }
    function renderQbar(){
      qbar.innerHTML = '';
      QUALITIES.forEach(function(q, i){
        var b = document.createElement('button');
        b.textContent = q.label.replace(/\\s*\\(.*?\\)\\s*/, '') || q.label;
        b.className = i === qi ? 'on' : '';
        b.onclick = function(e){
          e.stopPropagation();
          if (i === qi) return;
          wasPlaying = !v.paused && v.currentTime > 0;
          qi = i; mi = 0;
          applySrc(true);
        };
        qbar.appendChild(b);
      });
    }
    function hideLoad(){load.style.opacity='0';setTimeout(function(){load.style.display='none'},350)}
    v.addEventListener('loadeddata', hideLoad);
    v.addEventListener('canplay', hideLoad);
    v.addEventListener('playing', hideLoad);
    v.addEventListener('pause', function(){ wasPlaying = false; });
    v.addEventListener('error', function(){
      // Ошибка потока: сначала следующие зеркала того же качества, затем качества ниже
      if (mi + 1 < QUALITIES[qi].urls.length) {
        mi++;
        applySrc(true);
        return;
      }
      if (qi + 1 < QUALITIES.length) {
        qi++; mi = 0;
        applySrc(true);
        return;
      }
      load.style.display='none'; err.style.display='flex';
    });
    v.addEventListener('stalled', function(){ load.style.display='flex'; load.style.opacity='1'; });
    setTimeout(hideLoad, 15000);

    if (QUALITIES.length && QUALITIES[qi].urls.length) applySrc(false);
    else { load.style.display='none'; err.style.display='flex'; }
  })();
  </script>
</body>
</html>`;
}

/* ────────────────── Фолбэк: автоповтор вместо мёртвого iframe ────────────────── */

function retryPlayerPage(retryUrl: string, title: string, isRetry: boolean): string {
  const refresh = isRetry ? '' : `<meta http-equiv="refresh" content="45;url=${escapeAttr(retryUrl)}">`;
  const hint = isRetry
    ? 'Источник всё ещё не отвечает. Нажмите «Обновить» через минуту-другую — как правило, вечеровая нагрузка на источник спадает.'
    : 'Источник видео перегружен (обычно в вечерние часы). Автоповтор через 45 секунд…';
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="frame-ancestors 'self'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${refresh}
  <title>${escapeAttr(title)}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:100%;height:100%;background:#000;color:#d8b4fe;font-family:system-ui,sans-serif}
    body{display:flex;align-items:center;justify-content:center;text-align:center;padding:1.5rem}
    .box{max-width:420px;display:flex;flex-direction:column;gap:14px;align-items:center}
    .spin{width:42px;height:42px;border:3px solid rgba(168,85,247,.25);border-top-color:#a855f7;border-radius:50%;animation:sp 1s linear infinite}
    @keyframes sp{to{transform:rotate(360deg)}}
    h3{font-size:15px;color:#fff}
    p{font-size:12.5px;line-height:1.5;color:#9d7bd8}
    button{padding:9px 22px;border:none;border-radius:8px;background:linear-gradient(135deg,#a855f7,#7c3aed);color:#fff;font-size:14px;cursor:pointer}
  </style>
</head>
<body>
  <div class="box">
    <div class="spin"></div>
    <h3>Источник видео не отвечает</h3>
    <p>${hint}</p>
    <button onclick="location.reload()">Обновить</button>
  </div>
</body>
</html>`;
}

function errorPage(msg: string): string {
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'">
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#666;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,sans-serif;text-align:center;padding:2rem}</style></head><body><p>${msg}</p></body></html>`;
}
