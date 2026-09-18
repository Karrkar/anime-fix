import { NextResponse } from 'next/server';
import { checkAdultAccess } from '@/lib/adult-access'; // 18+ = возраст + подписка
import { logEvent } from '@/lib/logger';
import { isAllowedR34Host, R34_BASE } from '@/lib/sources'; // F-27

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// In-memory cache for proxied images (30 min).
// В РФ домен rule34.xxx (вкл. CDN-поддомены) заблокирован провайдерами, поэтому
// сетка thumbnail'ов грузится ЧЕРЕЗ ПРОКСИ — прямой загрузки там нет. Кэш должен
// вмещать минимум несколько страниц грида, иначе повторные просмотры снова ходят в CDN.
const imgCache = new Map<string, { buffer: ArrayBuffer; contentType: string; ts: number }>();
const IMG_CACHE_TTL = 30 * 60_000;
const MAX_CACHE_SIZE = 400;

// Rate limit (per-IP). ВАЖНО: маршрут уже за гейтом 18+ (возраст + подписка/admin),
// т.е. сюда доходят только авторизованные подписчики. Прежний лимит 40 req/min
// выжигался одной страницей грида (~24–48 thumbnail'ов через прокси, когда CDN
// недоступен напрямую) + чанками видео по 4МБ → запрос <video> получал 429,
// и плеер умирал с MEDIA_ERR_SRC_NOT_SUPPORTED. Реальный профиль подписчика:
// до ~150 картинок/мин при листании + ~10 чанков на 40МБ видео → лимит 300/мин.
const RATE_LIMIT_MAX = 300;

// Simple edge-compatible rate limit (per-IP)
const rlBuckets = new Map<string, number[]>();
function checkRateLimit(ip: string, max = RATE_LIMIT_MAX, windowMs = 60_000): boolean {
  const now = Date.now();
  let times = rlBuckets.get(ip);
  if (!times) { times = []; rlBuckets.set(ip, times); }
  // Evict old
  while (times.length && now - times[0] > windowMs) times.shift();
  if (times.length >= max) return false;
  times.push(now);
  return true;
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov|avi)(\?|$)/i.test(url) || url.includes('/videos/');
}

/**
 * ВИДЕО — СТРИМИНГ С ПРОБРОСОМ RANGE (фикс «плеер хентая не работает»):
 *
 * Раньше файл целиком качался в ArrayBuffer и отдавался одним ответом —
 * (а) ответы Vercel-функции ограничены ~4.5 МБ: всё, что больше, обрывалось
 * на середине и видео «не играло»;
 * (б) Range-запросы <video> получали 200 вместо 206 — перемотка не работала.
 *
 * Теперь: Range клиента (или собственный чанк 0..4МБ, если Range нет)
 * пробрасывается в CDN, тело отдаётся потоком, статус и Content-Range —
 * от upstream. Каждый вызов функции тянет максимум ~4 МБ и укладывается
 * в лимит длительности Hobby-плана; <video> сам запрашивает следующие
 * куски по мере воспроизведения. Буферный кэш видео убран (был бесполезен
 * в serverless: память на инстанс, 10 слотов, большие тела).
 */
const STREAM_CHUNK = 4 * 1024 * 1024 - 1; // bytes=0-4194303

function parseClientRange(range: string | null): { start: number; end: number | null } | null {
  if (!range) return null;
  const m = range.match(/^bytes=(\d+)-(\d*)$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  if (!Number.isFinite(start) || start < 0) return null;
  const end = m[2] ? parseInt(m[2], 10) : null;
  if (end !== null && end < start) return null;
  return { start, end: Number.isFinite(end as number) ? end : null };
}

async function streamVideo(url: string, request: Request): Promise<Response> {
  const clientRange = parseClientRange(request.headers.get('range'));

  // Откртый Range (bytes=N-) или отсутствие Range → ограничиваем кусок сами,
  // чтобы вызов функции не длился дольше лимита плана на медленных клиентах.
  const upstreamRange = clientRange
    ? (clientRange.end !== null
        ? `bytes=${clientRange.start}-${clientRange.end}`
        : `bytes=${clientRange.start}-${clientRange.start + STREAM_CHUNK}`)
    : `bytes=0-${STREAM_CHUNK}`;

  const upstream = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'video/*,*/*;q=0.8',
      'Referer': `${R34_BASE}/`,
      'Range': upstreamRange,
    },
    signal: AbortSignal.timeout(55_000), // запас до лимита функции
  });

  if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 416) {
    return NextResponse.json({ error: 'Upstream error' }, { status: 502 });
  }

  // 416 = Range за пределами файла — отдаём как есть (браузер это валидирует сам)
  if (upstream.status === 416) {
    const h416 = new Headers();
    const cr = upstream.headers.get('content-range');
    if (cr) h416.set('Content-Range', cr);
    h416.set('Accept-Ranges', 'bytes');
    return new NextResponse(null, { status: 416, headers: h416 });
  }

  const contentType = upstream.headers.get('content-type') || '';
  if (contentType.startsWith('text/')) {
    // CF-challenge или страница-заглушка вместо видео
    return NextResponse.json({ error: 'Not a valid media file' }, { status: 502 });
  }

  const headers = new Headers();
  headers.set('Content-Type', contentType || 'video/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', 'no-store'); // частичные ответы не кэшируем
  const cr = upstream.headers.get('content-range');
  if (cr) headers.set('Content-Range', cr);
  const cl = upstream.headers.get('content-length');
  if (cl) headers.set('Content-Length', cl);

  // Статус от upstream: 206 если он отдал кусок (наш случай), 200 если нет
  return new NextResponse(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
}

export async function GET(request: Request) {
  // F-15 fix + 18+ по подписке: серверный гейт — возраст И активная подписка
  const access = await checkAdultAccess(request, '/api/r34img');
  if (!access.ok) return access.response;

  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  if (!url) return NextResponse.json({ error: 'Missing url' }, { status: 400 });

  let parsed: URL;
  try { parsed = new URL(url); } catch { return NextResponse.json({ error: 'Invalid url' }, { status: 400 }); }

  // ФИКС: wildcard-проверка — video-CDN rule34 мигрирует между поддоменами
  if (!isAllowedR34Host(parsed.hostname)) {
    return NextResponse.json({ error: 'Host not allowed' }, { status: 403 });
  }

  // ── Картинки из кэша: отдаём ДО rate limit ───────────────────────
  // Кэш-попадание не ходит в upstream и ничего не стоит — несправедливо
  // съедать им лимит подписчика (повторный просмотр грида — почти
  // целиком кэш). Белый список хостов + гейт 18+ закрывают абьюз.
  if (!isVideoUrl(url)) {
    const cachedEarly = imgCache.get(url);
    if (cachedEarly && Date.now() - cachedEarly.ts < IMG_CACHE_TTL) {
      return new NextResponse(cachedEarly.buffer, {
        headers: {
          'Content-Type': cachedEarly.contentType,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  }

  // Rate limit (F-11 fix: приоритет x-real-ip) — только для запросов,
  // которые реально тянут данные из CDN (свежие картинки + видео-чанки)
  const ip = request.headers.get('x-real-ip')?.trim()
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  // ── Видео: стриминг с Range ────────────────────────────────────────────
  if (isVideoUrl(url)) {
    try {
      return await streamVideo(url, request);
    } catch {
      return NextResponse.json({ error: 'Proxy error' }, { status: 500 });
    }
  }

  // ── Картинки: upstream fetch + буфер + кэш ────────────────────────
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'image/*,*/*;q=0.8',
        'Referer': `${R34_BASE}/`,
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) return NextResponse.json({ error: 'Upstream error' }, { status: 502 });

    const contentType = res.headers.get('content-type') || '';
    const buffer = await res.arrayBuffer();

    // Don't cache HTML (CF challenge page)
    if (contentType.includes('text') || buffer.byteLength < 1000) {
      return NextResponse.json({ error: 'Not a valid media file' }, { status: 502 });
    }

    // Evict old entries if cache is full
    if (imgCache.size >= MAX_CACHE_SIZE) {
      let oldestKey = '';
      let oldestTs = Infinity;
      for (const [k, v] of imgCache.entries()) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
      }
      if (oldestKey) imgCache.delete(oldestKey);
    }

    const resolvedContentType = contentType || 'image/jpeg';
    imgCache.set(url, { buffer, contentType: resolvedContentType, ts: Date.now() });

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': resolvedContentType,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Proxy error' }, { status: 500 });
  }
}
