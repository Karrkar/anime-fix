import { NextRequest, NextResponse } from 'next/server';
import { checkAdultAccess } from '@/lib/adult-access'; // 18+ = возраст + подписка
import { BoundedTTLCache } from '@/lib/cache';
import { logEvent } from '@/lib/logger';
import { SOURCES } from '@/lib/sources';
import { withRateLimit } from '@/lib/with-rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * УСКОРЕННЫЙ СТРИМИНГ ВИДЕО 18+ С CDN hentaibaza — v2 «КОНВЕЙЕР»
 * (фикс «серии хентая грузятся медленно», вторая итерация 29.10.2026).
 *
 * ИСТОРИЯ: v1 (27.10) тянула каждый 4МБ-чанк 4 параллельными Range-полосами —
 * старт серии упал с 2+ минут до ~5-7с, но замеры 29.10 показали тонкий
 * запас: средняя 0.47 МБ/с при битрейте ~0.23 МБ/с (всего 2x, в ямах 1.4x).
 * Причина простоя: браузер запрашивает чанки СТРОГО ПО ОЧЕРЕДИ — пока он
 * качает чанк N с нашего сервера, CDN простаивает, и наоборот; плюс каждый
 * чанк = 4 новых TLS-соединения к CDN (serverless не переиспользует коннекты).
 *
 * v2 — ТРИ изменения:
 *   1) ПОЛОС БОЛЬШЕ: 8 параллельных Range-соединений на чанк (4МБ/8=512КБ
 *      на полосу) — быстрее реагируют перемотки и первый кадр;
 *   2) КОНВЕЙЕР: отдавая чанк N клиенту, СРАЗУ качаем чанк N+1 в кэш
 *      (спекулятивная предзагрузка). Следующий запрос браузера (он всегда
 *      идёт по порядку: bytes=<конец N>-) попадает в кэш и обслуживается
 *      мгновенно, а сервер в это же время качает чанк N+2. CDN и клиент
 *      работают ПАРАЛЛЕЛЬНО вместо поочерёдного ожидания: эффективная
 *      скорость = max(CDN, клиент) вместо min — буфер растёт без пауз;
 *   3) Кэш чанков в памяти тёплого инстанса (BoundedTTLCache: 16 × 4МБ,
 *      TTL 5 мин) — переживает соседние вызовы на том же инстансе.
 *
 * ГАРАНТИИ ЗАВЕРШЕНИЯ: предзагрузка не держит ответ дольше 15с (race с
 * таймаутом) — суммарный бюджет вызова ≤ ~55с при лимите 60с; неудачная
 * предзагрузка просто пропускается (следующий запрос пойдёт обычным путём).
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
const FIRST_CHUNK_BYTES = 512 * 1024;  // первый запрос bytes=0-: маленький чанк — первый кадр за 1-2с (moov ~400КБ в начале)
const LANES = 8;                        // параллельных соединений к CDN на чанк
const LANE_TIMEOUT_MS = 20_000;         // на попытку основной загрузки; одна повторная = до 40с
const PREFETCH_LINGER_MS = 15_000;      // максимум «зависания» ответа ради предзагрузки следующего чанка
const PREFETCH_LANE_TIMEOUT_MS = 12_000; // полосы предзагрузки — без ретраев, не жалко
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Кэш предзагруженных чанков (тёплый инстанс): 24 слота × 4МБ = 96МБ максимум.
 *  Хранит ОБЕЩАНИЯ (Promise): запрос, пришедший пока предзагрузка ещё идёт
 *  (реальный браузер потребляет 4МБ за 2-4с и сразу просит следующий),
 *  дожидается того же обещания вместо повторной загрузки с CDN — дедупликация
 *  in-flight запросов. Неудачная предзагрузка резолвится null → обычный путь. */
interface CachedChunk { buf: Uint8Array<ArrayBuffer>; total: number }
type ChunkPromise = Promise<CachedChunk | null>;
const NEXT_CACHE = new BoundedTTLCache<string, ChunkPromise>(24, 5 * 60 * 1000);

function cacheKey(url: string, start: number): string {
  return `${url}#${start}`;
}

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

type Lane = { buf: Uint8Array<ArrayBuffer>; total: number | null };

/**
 * Одна «полоса» параллельной загрузки: Range start..end с CDN.
 * Буферизация в память (≤1 МБ на полосу). attempts=0 — без ретраев (предзагрузка).
 */
async function fetchLane(url: string, start: number, end: number, attempts = 2): Promise<Lane> {
  const want = end - start + 1;
  const tries = Math.max(1, attempts);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'video/*,*/*;q=0.8',
          'Referer': `${SOURCES.hentaibaza.base}/`,
          'Range': `bytes=${start}-${end}`,
        },
        signal: AbortSignal.timeout(attempts <= 1 ? PREFETCH_LANE_TIMEOUT_MS : LANE_TIMEOUT_MS),
      });
      // Редирект не должен уводить с разрешённого хоста (SSRF-гигиена)
      if (!isAllowedHost(res.url)) throw new Error('redirect to foreign host');
      if (res.status !== 200 && res.status !== 206) throw new Error(`upstream ${res.status}`);

      const contentType = res.headers.get('content-type') || '';
      if (contentType.startsWith('text/')) throw new Error('not a media file (challenge?)');

      const total = totalFromContentRange(res.headers.get('content-range'));
      const raw = new Uint8Array(await res.arrayBuffer()) as Uint8Array<ArrayBuffer>;
      // 200 без Range-поддержки: отрезаем запрошенный кусок от начала
      const buf: Uint8Array<ArrayBuffer> = res.status === 200 && raw.byteLength > want ? raw.slice(0, want) : raw;
      if (buf.byteLength === 0) throw new Error('empty lane');
      return { buf, total };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('lane failed');
}

/** Диапазон → LANES полос, все параллельно → склейка по порядку. */
async function fetchChunk(url: string, start: number, end: number, attempts = 2): Promise<CachedChunk> {
  const len = end - start + 1;
  const laneLen = Math.ceil(len / LANES);
  const lanes: Array<Promise<Lane>> = [];
  for (let i = 0; i < LANES; i++) {
    const ls = start + i * laneLen;
    if (ls > end) break;
    const le = Math.min(ls + laneLen - 1, end);
    lanes.push(fetchLane(url, ls, le, attempts));
  }
  const parts = await Promise.all(lanes);

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
  return { buf: out, total: total ?? 0 };
}

/**
 * Предзагрузка следующего чанка (best-effort, без ретраев): обещание кладётся
 * в кэш СРАЗУ (до завершения) — конкурентный запрос того же чанка дождётся его.
 * Ошибка → обещание резолвится null (кэш-промах при чтении → обычная загрузка).
 */
function prefetchNextChunk(url: string, nextStart: number): ChunkPromise {
  const key = cacheKey(url, nextStart);
  const existing = NEXT_CACHE.get(key);
  if (existing) return existing; // уже качается/скачано (другой зритель)

  const p = (async (): Promise<CachedChunk | null> => {
    try {
      const chunk = await fetchChunk(url, nextStart, nextStart + CHUNK_BYTES - 1, 1);
      if (chunk.buf.byteLength > 0 && chunk.total > 0) return chunk;
      return null;
    } catch {
      return null; // предзагрузка не удалась — следующий запрос пойдёт обычным путём
    }
  })();

  NEXT_CACHE.set(key, p);
  return p;
}

async function hbStreamHandler(request: NextRequest): Promise<NextResponse> {
  // Гейт 18+ (возраст + подписка/админ) — как в /api/hb-player, на каждый чанк
  const access = await checkAdultAccess(request, '/api/hb-stream');
  if (!access.ok) return access.response;

  const { searchParams } = new URL(request.url);
  const rawUrl = searchParams.get('url');
  if (!rawUrl) return NextResponse.json({ error: 'Missing url' }, { status: 400 });

  // Только прямые ссылки на разрешённых хостах hentaibaza (SSRF-гигиена)
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
    // ── Кэш конвейера: предзагруженный (или предзагружаемый СЕЙЧАС) чанк ──
    const cachedPromise = NEXT_CACHE.get(cacheKey(rawUrl, start));
    let chunk: CachedChunk | null = null;
    let fromCache = false;
    if (cachedPromise) {
      const cached = await cachedPromise; // дождаться, если предзагрузка ещё идёт
      if (cached && cached.buf.byteLength > 0) {
        // Кэш может быть «длиннее» запрошенного (браузер попросил меньше) — режем
        const need = end - start + 1;
        chunk = cached.buf.byteLength >= need
          ? { buf: cached.buf.slice(0, need), total: cached.total }
          : cached;
        fromCache = true;
      } else {
        // Неудачная предзагрузка — убираем, чтобы позже была retry-возможность
        NEXT_CACHE.delete(cacheKey(rawUrl, start));
      }
    }

    if (!chunk) {
      chunk = await fetchChunk(rawUrl, start, end);
    }

    const size = chunk.buf.byteLength;
    const total = chunk.total;
    if (size === 0) throw new Error('empty chunk');

    // 416: клиент просил за пределами файла
    if (total > 0 && start >= total) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' },
      });
    }

    const realEnd = start + size - 1;
    const wholeFile = start === 0 && total > 0 && size >= total;
    const headers = new Headers();
    headers.set('Content-Type', 'video/mp4');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', String(size));
    headers.set('Cache-Control', 'no-store'); // частичные ответы не кэшируем
    headers.set('Access-Control-Allow-Origin', '*');
    if (!wholeFile && total > 0) {
      headers.set('Content-Range', `bytes ${start}-${realEnd}/${total}`);
    }
    if (fromCache) headers.set('X-HB-Pipeline', 'hit');

    // ── КОНВЕЙЕР: отдаём чанк сразу, а пока клиент его потребляет —
    // качаем следующий в кэш (стрим держит вызов живым, но ≤ PREFETCH_LINGER_MS).
    const nextStart = realEnd + 1;
    const canPrefetch = !wholeFile && (total === 0 || nextStart < total);

    if (!canPrefetch) {
      return new NextResponse(chunk.buf, { status: wholeFile ? 200 : 206, headers });
    }

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(chunk!.buf);
          // Задерживаем close() ровно настолько, насколько успевает предзагрузка
          await Promise.race([
            prefetchNextChunk(rawUrl, nextStart),
            new Promise<void>(resolve => setTimeout(resolve, PREFETCH_LINGER_MS)),
          ]);
        } catch { /* клиент ушёл (seek/закрытие) — просто завершаем */ }
        try { controller.close(); } catch { /* уже закрыт */ }
      },
    });

    return new NextResponse(body, { status: wholeFile ? 200 : 206, headers });
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
