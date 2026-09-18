import { NextRequest, NextResponse } from 'next/server';
import { validateExternalUrlWithDns } from '@/lib/url-guard';
import { withRateLimit } from '@/lib/with-rate-limit';
import { BoundedTTLCache } from '@/lib/cache';
import { logEvent } from '@/lib/logger';
import { PLAYER_PROXY_ALLOWED_HOSTS as ALLOWED_HOSTS } from '@/lib/sources'; // F-27

export const dynamic = 'force-dynamic';

// ── Allowed domains for proxy (prevent SSRF) — белый список в @/lib/sources ──

const CACHE = new BoundedTTLCache<string, { entries: [string, string][]; timestamp: number }>(200, 30 * 60 * 1000);

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
async function playerProxyHandler(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawUrl = searchParams.get('url');
    const episode = parseInt(searchParams.get('episode') || '1', 10);

    if (!rawUrl) {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    // SSRF protection: validate URL and check allowed hosts (F-14: + DNS-резолв)
    const safeUrl = await validateExternalUrlWithDns(rawUrl);
    if (!safeUrl || !isAllowedHost(safeUrl)) {
      logEvent('ssrf_blocked', { url: rawUrl.slice(0, 200), host: new URL(safeUrl || 'http://x').hostname }, 'warn');
      return NextResponse.json({ error: 'URL not allowed' }, { status: 403 });
    }

    // Get episode entries (from cache or by fetching)
    let entries: [string, string][] | null;
    const cached = CACHE.get(safeUrl);

    if (cached) {
      entries = cached.entries;
    } else {
      const resp = await fetch(safeUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!resp.ok) {
        return NextResponse.json({ error: `source HTTP ${resp.status}` }, { status: 502 });
      }

      const html = await resp.text();
      entries = parseEpisodeData(html);

      if (entries) {
        CACHE.set(safeUrl, { entries, timestamp: Date.now() });
      }
    }

    if (!entries || entries.length === 0) {
      return new NextResponse(errorPage('Не удалось загрузить серии. Попробуйте обновить.'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const epIdx = Math.min(Math.max(episode - 1, 0), entries.length - 1);
    const [label, id] = entries[epIdx];
    // S-02 FIX: sanitize id and label — prevent XSS in iframe src and title
    const safeId = String(id).replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 100);
    const safeLabel = String(label).replace(/<[^>]*>/g, '').replace(/['"]/g, '').slice(0, 200);
    const urlObj = new URL(safeUrl);
    // ФИКС: добавляем &old=1 — принудительный HTTP-плеер (Playerjs, прямые mp4).
    // Дефолтный режим vost.pw — WebTorrent-P2P: в ряде сетей/браузеров не находит
    // пиров, а его автофолбэк на старый плеер падает (client.torrents[0] undefined
    // при ошибке client.add) → вечный спиннер. old=1 играет сразу и везде.
    const embedUrl = `${urlObj.protocol}//${urlObj.host}/frame5.php?play=${encodeURIComponent(safeId)}&player=9&old=1`;
    return new NextResponse(playerPage(embedUrl, safeLabel), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch {
    return new NextResponse(errorPage('Ошибка загрузки плеера.'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

export const GET = withRateLimit(playerProxyHandler, '/api/player-proxy')

function playerPage(embedUrl: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="frame-ancestors 'self'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;overflow:hidden;background:#000}iframe{width:100%;height:100%;border:none;display:block}</style>
</head>
<body>
  <!-- ФИКС: sandbox="" блокировал ВСЕ скрипты — JS-плеер (Playerjs) не запускался,
       вместо видео был чёрный экран. Разрешаем скрипты и собственный origin фрейма
       (нужен для XHR плеера к своему домену), при этом по-прежнему ЗАПРЕЩЕНЫ:
       top-navigation (плеер не уведёт со страницы), popups, forms.
       XSS остаётся закрыт санитайзингом id/label (S-02) + CSP frame-ancestors. -->
  <iframe src="${embedUrl}" sandbox="allow-scripts allow-same-origin" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>
</body>
</html>`;
}

function errorPage(msg: string): string {
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'">
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#666;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,sans-serif;text-align:center;padding:2rem}</style></head><body><p>${msg}</p></body></html>`;
}
