import { NextRequest, NextResponse } from 'next/server';
import { validateExternalUrlWithDns } from '@/lib/url-guard';
import { withRateLimit } from '@/lib/with-rate-limit';
import { BoundedTTLCache } from '@/lib/cache';
import { logEvent } from '@/lib/logger';
import { checkAdultAccess } from '@/lib/adult-access'; // 18+ = возраст + подписка
import { SOURCES } from '@/lib/sources';

export const dynamic = 'force-dynamic';

/**
 * Плеер 18+ видео с hentaibaza.com (страницы /watch/N и прямые mp4 с CDN).
 *
 * ПОЧЕМУ ЭТОТ МАРШРУТ НУЖЕН (фикс «плеер хентай не работает»):
 *  1. WatchPage раньше вставлял страницу hentaibaza.com/watch/N в iframe
 *     напрямую — CSP frame-src ('self' + vost.pw) блокировал чужой домен,
 *     и вместо видео был пустой/чёрный фрейм.
 *  2. Для статических тайтлов (hb-*) embedUrl — прямая ссылка на mp4
 *     (cloude.hentaibaza.com). iframe на mp4 тоже блокируется CSP frame-src,
 *     а в тех браузерах, где не блокируется, отдаётся без нормальной
 *     панели управления.
 *
 * Решение: сервер сам ходит на страницу /watch/N, вытаскивает прямую ссылку
 * на mp4 (или принимает mp4 напрямую) и отдаёт СОБСТВЕННУЮ страницу с
 * нативным HTML5-<video>:
 *  - страница живёт на нашем origin → frame-src 'self' пропускает её в iframe;
 *  - видео грузится с https:// CDN → media-src 'https:' пропускает поток;
 *  - нативные контролы, перемотка (CDN отдаёт accept-ranges), fullscreen.
 *
 * Безопасность (как в остальных adult-маршрутах):
 *  - гейт 18+: возрастная cookie + активная подписка/админ (checkAdultAccess);
 *  - SSRF: validateExternalUrlWithDns + белый список хостов hentaibaza;
 *  - итоговая ссылка на видео обязана быть https и на разрешённом хосте;
 *  - кэш извлечённых ссылок ограничен (BoundedTTLCache, 30 минут).
 */

const ALLOWED_HOSTS: readonly string[] = SOURCES.hentaibaza.hosts;

const CACHE = new BoundedTTLCache<string, { videoUrl: string; posterUrl: string }>(
  300,
  30 * 60 * 1000,
);

function isAllowedHost(url: string): boolean {
  try {
    return ALLOWED_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Прямая ссылка на видеофайл (mp4/webm/m3u8) — играет без парсинга страницы */
function isDirectVideo(url: string): boolean {
  return /\.(mp4|webm|m3u8)(\?|$)/i.test(url);
}

function unescapeAttr(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Извлечение прямой ссылки на видео из HTML страницы /watch/N.
 * Порядок: <video src> → og:video(:secure_url|:url) → JSON-LD contentUrl.
 */
function extractVideoInfo(html: string): { videoUrl: string; posterUrl: string } | null {
  let m = html.match(/<video[^>]*\bsrc=["']([^"']+)["']/i);
  if (!m) {
    m =
      html.match(/property=["']og:video(?::secure_url|:url)?["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/content=["']([^"']+)["'][^>]*property=["']og:video(?::secure_url|:url)?["']/i);
  }
  if (!m) {
    m = html.match(/"contentUrl"\s*:\s*"([^"]+)"/);
  }
  if (!m) return null;

  const videoUrl = unescapeAttr(m[1]).trim();
  if (!/^https?:\/\//i.test(videoUrl)) return null;

  const pm =
    html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<video[^>]*\bposter=["']([^"']+)["']/i);
  const posterUrl = pm ? unescapeAttr(pm[1]).trim() : '';

  return { videoUrl, posterUrl };
}

async function hbPlayerHandler(request: NextRequest) {
  // ── Гейт 18+ (возраст + подписка/админ) — как в /api/hentai ──
  const access = await checkAdultAccess(request, '/api/hb-player');
  if (!access.ok) return access.response;

  try {
    const { searchParams } = new URL(request.url);
    const rawUrl = searchParams.get('url');

    if (!rawUrl) {
      return new NextResponse(errorPage('Не передана ссылка на видео.'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // SSRF-защита: только http/https, резолвящийся публичный хост
    const safeUrl = await validateExternalUrlWithDns(rawUrl);
    if (!safeUrl || !isAllowedHost(safeUrl)) {
      logEvent('ssrf_blocked', { path: '/api/hb-player', url: rawUrl.slice(0, 200) }, 'warn');
      return new NextResponse(errorPage('Источник видео не разрешён.'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    let videoUrl = safeUrl;
    let posterUrl = '';

    // Страница /watch/N — вытаскиваем прямую ссылку на mp4 (с кэшем)
    if (!isDirectVideo(safeUrl)) {
      const cached = CACHE.get(safeUrl);
      if (cached) {
        videoUrl = cached.videoUrl;
        posterUrl = cached.posterUrl;
      } else {
        const resp = await fetch(safeUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(20000),
        });
        if (!resp.ok) {
          return new NextResponse(
            errorPage(`Источник недоступен (HTTP ${resp.status}). Попробуйте позже.`),
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          );
        }
        const html = await resp.text();
        const info = extractVideoInfo(html);
        if (!info) {
          return new NextResponse(
            errorPage('Не удалось найти видеофайл на странице источника.'),
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          );
        }
        // Итоговая ссылка обязана вести на разрешённые хосты CDN источника
        if (!isAllowedHost(info.videoUrl)) {
          logEvent('hb_player_foreign_cdn', { url: info.videoUrl.slice(0, 200) }, 'warn');
          return new NextResponse(errorPage('Видео найдено, но его источник не разрешён.'), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        // Приводим к https (http-CDN миксится с https-страницей → mixed content)
        videoUrl = info.videoUrl.replace(/^http:\/\//i, 'https://');
        posterUrl = info.posterUrl.replace(/^http:\/\//i, 'https://');
        if (posterUrl && !isAllowedHost(posterUrl)) posterUrl = '';
        CACHE.set(safeUrl, { videoUrl, posterUrl });
      }
    }

    return new NextResponse(playerPage(videoUrl, posterUrl), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch {
    return new NextResponse(errorPage('Ошибка загрузки плеера. Попробуйте обновить.'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

export const GET = withRateLimit(hbPlayerHandler, '/api/hb-player');

/* ─────────────────── HTML страницы плеера ─────────────────── */

function playerPage(videoUrl: string, posterUrl: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="frame-ancestors 'self'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Плеер 18+</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:100%;height:100%;overflow:hidden;background:#000}
    #wrap{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center}
    video{width:100%;height:100%;object-fit:contain;background:#000}
    #load{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);transition:opacity .3s}
    #load .spin{width:46px;height:46px;border:3px solid rgba(236,72,153,.25);border-top-color:#ec4899;border-radius:50%;animation:sp 1s linear infinite}
    @keyframes sp{to{transform:rotate(360deg)}}
    #err{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(0,0,0,.85);color:#f9a8d4;font-family:system-ui,sans-serif;text-align:center;padding:1rem}
    #err b{font-size:15px}
    #err small{color:#9d174d;font-size:12px}
    #err button{margin-top:4px;padding:8px 18px;border:none;border-radius:8px;background:linear-gradient(135deg,#ec4899,#db2777);color:#fff;font-size:14px;cursor:pointer}
  </style>
</head>
<body>
  <div id="wrap">
    <video id="v" src="${videoUrl}"${posterUrl ? ` poster="${posterUrl}"` : ''} controls playsinline preload="metadata" controlslist="nodownload"></video>
    <div id="load"><div class="spin"></div></div>
    <div id="err"><b id="errmsg">Ошибка воспроизведения</b><small>Источник видео недоступен или ссылка устарела</small><button onclick="location.reload()">Обновить</button></div>
  </div>
  <script>
    (function(){
      var v=document.getElementById('v'),load=document.getElementById('load'),err=document.getElementById('err');
      function hideLoad(){load.style.opacity='0';setTimeout(function(){load.style.display='none'},350)}
      v.addEventListener('loadeddata',hideLoad);
      v.addEventListener('canplay',hideLoad);
      v.addEventListener('playing',hideLoad);
      v.addEventListener('error',function(){load.style.display='none';err.style.display='flex'});
      v.addEventListener('stalled',function(){load.style.display='flex';load.style.opacity='1'});
      setTimeout(hideLoad,12000);
    })();
  </script>
</body>
</html>`;
}

function errorPage(msg: string): string {
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'">
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#f9a8d4;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,sans-serif;text-align:center;padding:2rem;font-size:14px}</style></head><body><p>${msg}</p></body></html>`;
}
