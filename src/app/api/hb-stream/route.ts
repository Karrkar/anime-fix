import { NextRequest, NextResponse } from 'next/server';
import { checkAdultAccess } from '@/lib/adult-access'; // 18+ = возраст + подписка
import { logEvent } from '@/lib/logger';
import { SOURCES } from '@/lib/sources';
import { withRateLimit } from '@/lib/with-rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * УСКОРЕННЫЙ СТРИМИНГ ВИДЕО 18+ С CDN hentaibaza
 * (фикс «серии хентая грузятся больше 2 минут»).
 *
 * ДИАГНОЗ (замеры 27.10.2026 с боевого CDN cloude.hentaibaza.com):
 *   • файл одной серии ~240 МБ, битрейт ~350 КБ/с;
 *   • CDN режет скорость ПО СОЕДИНЕНИЮ: один поток = 72–157 КБ/с — буфер
 *     НИКОГДА не догоняет воспроизведение, зритель ждёт минуты; при этом
 *     4 параллельных Range-соединения дают ~813 КБ/с (в 5–11 раз быстрее).
 *
 * РЕШЕНИЕ: маршрут отдаёт <video> чанки по ~4 МБ (лимит ответа Vercel-функции),
 * но каждый чанк тянет с CDN ЧЕТЫРЬМЯ параллельными Range-соединениями по ~1 МБ
 * и склеивает их по порядку. Эффективная скорость зрителя ×4–5 против прямой
 * ссылки: буфер обгоняет битрейт, серия стартует за секунды, перемотка мгновенная.
 *
 * Используется страницей плеера /api/hb-player (video src = этот маршрут).
 *
 * Безопасность (как в /api/hb-player):
 *   • гейт 18+ (возраст + активная подписка/админ) — на каждый чанк;
 *   • только прямые ссылки на видео с разрешённых хостов hentaibaza;
 *   • после fetch проверяем итоговый URL (редирект не должен уводить
 *     на чужой хост — иначе ошибка).
 */
const ALLOWED_HOSTS: readonly string[] = SOURCES.hentaibaza.hosts;

const CHUNK_BYTES = 4 * 1024 * 1024;   // клиенту за вызов (лимит ответа Vercel ~4.5 МБ)
const FIRST_CHUNK_BYTES = 512 * 1024;  // первый запрос bytes=0-: маленький чанк — первый кадр за 1-2с, дальше <video> сам просит большие
const LANES = 4;                        // параллельных соединений к CDN
const LANE_TIMEOUT_MS = 20_000;         // на попытку; одна повторная = до 40с (лимит функции 60с)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function isAllowedHost(url: string): boolean {
  try {
    return ALLOWED_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Range-заголовок браузера → {start, end|null}; иначе null (запрос без Range) */
function parseClientRange(range: string | null): { start: number; end: number | null } | null {
  if (!range) return null;
  const m = range.match(/^bytes=(\d+)-(\d*)$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  if (!Number.isFinite(start) || start < 0) return null;
  const end = m[2] ? parseInt(m[2], 10) : null;
  if (end !== null && end < start) return null;
  return { start, end };
}

/** «bytes 0-99/12345» → 12345; иначе null */
function totalFromContentRange(cr: string | null): number | null {
  if (!cr) return null;
  const m = cr.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
  return m ? parseInt(m[1], 10) : null;
}

type Lane = { buf: Uint8Array; total: number | null };

/**
 * Одна «полоса» параллельной загрузки: Range start..end с CDN.
 * Буферизация в память (≤1 МБ на полосу). При таймауте/сбое — один ретрай.
 */
async function fetchLane(url: string, start: number, end: number): Promise<Lane> {
  const want = end - start + 1;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'video/*,*/*;q=0.8',
          'Referer': `${SOURCES.hentaibaza.base}/`,
          'Range': `bytes=${start}-${end}`,
        },
        signal: AbortSignal.timeout(LANE_TIMEOUT_MS),
      });
      // Редирект не должен уводить с разрешённого хоста (SSRF-гигиена)
      if (!isAllowedHost(res.url)) throw new Error('redirect to foreign host');
      if (res.status !== 200 && res.status !== 206) throw new Error(`upstream ${res.status}`);

      const contentType = res.headers.get('content-type') || '';
      if (contentType.startsWith('text/')) throw new Error('not a media file (challenge?)');

      const total = totalFromContentRange(res.headers.get('content-range'));
      const raw = new Uint8Array(await res.arrayBuffer());
      // 200 без Range-поддержки: отрезаем запрошенный кусок от начала
      const buf = res.status === 200 && raw.byteLength > want ? raw.slice(0, want) : raw;
      if (buf.byteLength === 0) throw new Error('empty lane');
      return { buf, total };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('lane failed');
}

async function hbStreamHandler(request: NextRequest): Promise<NextResponse> {
  // Гейт 18+ (возраст + подписка/админ) — как в /api/hb-player, на каждый чанк
  const access = await checkAdultAccess(request, '/api/hb-stream');
  if (!access.ok) return access.response;

  const { searchParams } = new URL(request.url);
  const rawUrl = searchParams.get('url');
  if (!rawUrl) return NextResponse.json({ error: 'Missing url' }, { status: 400 });

  // Только прямые ссылки на разрешённых хостах hentaibaza (SSRF-гигиена).
  // DNS-resolve не нужен: хосты — литералы, редиректы проверяются после fetch.
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch {
    return NextResponse.json({ error: 'Invalid url' }, { status: 400 });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return NextResponse.json({ error: 'Bad protocol' }, { status: 400 });
  }
  if (!isAllowedHost(rawUrl)) {
    logEvent('ssrf_blocked', { path: '/api/hb-stream', url: rawUrl.slice(0, 200) }, 'warn');
    return NextResponse.json({ error: 'Host not allowed' }, { status: 403 });
  }

  // Диапазон клиента → наш чанк не длиннее CHUNK_BYTES;
  // запрос начала файла (bytes=0-) отдаём коротким куском — быстрый первый кадр
  const cr = parseClientRange(request.headers.get('range'));
  const start = cr ? cr.start : 0;
  const maxChunk = start === 0 && (!cr || cr.end === null) ? FIRST_CHUNK_BYTES : CHUNK_BYTES;
  const end = cr && cr.end !== null ? Math.min(cr.end, start + maxChunk - 1) : start + maxChunk - 1;

  try {
    // Диапазон → LANES полос по ~1 МБ, все параллельно
    const len = end - start + 1;
    const laneLen = Math.ceil(len / LANES);
    const lanes: Array<Promise<Lane>> = [];
    for (let i = 0; i < LANES; i++) {
      const ls = start + i * laneLen;
      if (ls > end) break;
      const le = Math.min(ls + laneLen - 1, end);
      lanes.push(fetchLane(rawUrl, ls, le));
    }
    const parts = await Promise.all(lanes);

    // Склейка по порядку (полоса могла вернуться короче — реальный конец чанка)
    let size = 0;
    for (const p of parts) size += p.buf.byteLength;
    const out = new Uint8Array(size);
    let off = 0;
    let total: number | null = null;
    for (const p of parts) {
      out.set(p.buf, off);
      off += p.buf.byteLength;
      if (total === null) total = p.total;
    }

    // 416: клиент просил за пределами файла
    if (total !== null && start >= total) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' },
      });
    }

    const realEnd = start + size - 1;
    const wholeFile = start === 0 && total !== null && size >= total;
    const headers = new Headers();
    headers.set('Content-Type', 'video/mp4');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', String(size));
    headers.set('Cache-Control', 'no-store'); // частичные ответы не кэшируем
    headers.set('Access-Control-Allow-Origin', '*');
    if (!wholeFile && total !== null) {
      headers.set('Content-Range', `bytes ${start}-${realEnd}/${total}`);
    }

    return new NextResponse(out, { status: wholeFile ? 200 : 206, headers });
  } catch (e) {
    // Браузер <video> сам повторит запрос; флаг в логе — для диагностики CDN
    logEvent('hb_stream_error', {
      url: rawUrl.slice(0, 200),
      start,
      err: e instanceof Error ? e.message.slice(0, 120) : 'unknown',
    }, 'warn');
    return NextResponse.json({ error: 'Stream error' }, { status: 502 });
  }
}

export const GET = withRateLimit(hbStreamHandler, '/api/hb-stream');
