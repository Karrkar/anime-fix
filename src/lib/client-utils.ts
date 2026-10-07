import { Anime, FavUpdate } from '@/lib/client-types';

// ─── Helpers ─────────────────────────────────────────────────────────────
/** ИСПРАВЛЕНИЕ БАГА #1: нормализуем genres — строку → массив */
export function parseGenres(genres: string | null | undefined): string[] {
  if (!genres) return [];
  if (Array.isArray(genres)) return genres;
  return genres.split(/[,;]\s*/).map(g => g.trim()).filter(Boolean);
}

export const VALID_URL_RE = /^(https?:\/\/)/i;
export function isValidUrl(url: string | null | undefined): boolean {
  return !!url && VALID_URL_RE.test(url);
}

export function stripHtml(s: string | null | undefined): string {
  return (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Общий blur-плейсхолдер для next/image (тёмно-фиолетовый градиент 8×8) */
export const BLUR_DATA_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzE4MTQyYSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzJkMjE0MCIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI4IiBoZWlnaHQ9IjgiIGZpbGw9InVybCgjZykiLz48L3N2Zz4=';

/**
 * Свежесть тайтла: 'new' — создан за последние 7 дней (полка «Свежее»);
 * 'updated' — обновлён за последние 36 часов (бейдж «Обновлено сегодня»).
 */
export function freshness(anime: Pick<Anime, 'createdAt' | 'updatedAt'>): 'new' | 'updated' | null {
  const now = Date.now();
  const c = anime.createdAt ? new Date(anime.createdAt).getTime() : 0;
  const u = anime.updatedAt ? new Date(anime.updatedAt).getTime() : 0;
  if (c && now - c < 7 * 86400000) return 'new';
  if (u && now - u < 36 * 3600000) return 'updated';
  return null;
}

// ─── API helpers ─────────────────────────────────────────────────────
export function authHeaders(): Record<string, string> {
  // F-07 fix: авторизация теперь через httpOnly cookie (same-origin fetch шлёт её сам).
  // Bearer остаётся только как legacy-мост на время миграции localStorage -> cookie.
  const token = typeof window !== 'undefined' ? localStorage.getItem('anime_platform_token') : null;
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// ─── Hedged image loading (2026-10-08, фикс «чёрный экран арта») ─────────
/**
 * CDN rule34 (за Cloudflare) банит egress-IP ~40-70% serverless-инстансов
 * Vercel → /api/r34img отвечает 502 выборочно и НЕЗАВИСИМО по инстансам.
 * Эксперимент: 15 параллельных запросов одного URL → 9 прошли; повторная
 * волна через секунду → 15/15 (успех оседает в кэшах: инстанс + браузер).
 *
 * hedgeLoadImage грузит картинку «волнами» против этого:
 *   1) одиночный fetch — быстрый путь (кэш браузера / удачный инстанс);
 *   2) при отказе — волна из perWave ПАРАЛЛЕЛЬНЫХ fetch того же URL:
 *      они распределяются по разным инстансам, первый 200 побеждает,
 *      остальные прерываются; P(успех волны из 4) при 60% здоровых ≈ 97%.
 *
 * Возвращает blob:-URL — вызывающий код ОБЯЗАН вызвать URL.revokeObjectURL,
 * когда картинка больше не нужна (unmount / замена).
 */
function fetchWithTimeout(url: string, ms: number, outer?: AbortSignal): Promise<Response> {
  // AbortSignal.timeout недоступен в старых Safari (15.3-) — ручной таймаут
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onOuterAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  return fetch(url, { signal: ctrl.signal, cache: 'default' }).finally(() => {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onOuterAbort);
  });
}

export interface HedgeOpts {
  /** Волн параллельных запросов после одиночной попытки (по умолчанию 2). */
  waves?: number;
  /** Запросов в волне (по умолчанию 4). */
  perWave?: number;
  /** Таймаут одного запроса, мс (по умолчанию 15000). */
  timeoutMs?: number;
}

export async function hedgeLoadImage(url: string, opts: HedgeOpts = {}): Promise<string> {
  const { waves = 2, perWave = 4, timeoutMs = 15_000 } = opts;

  // Быстрый путь: один запрос — кэш или счастливый инстанс
  try {
    const r = await fetchWithTimeout(url, timeoutMs);
    if (r.ok) return URL.createObjectURL(await r.blob());
  } catch { /* уходим в волны */ }

  for (let w = 0; w < waves; w++) {
    const controllers = Array.from({ length: perWave }, () => new AbortController());
    const attempts = controllers.map(c =>
      fetchWithTimeout(url, timeoutMs, c.signal).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
    );
    // Promise.any (ES2021) с фолбэком на последовательный перебор для старых браузеров
    const anyOf: Promise<Blob> = typeof (Promise as unknown as { any?: Function }).any === 'function'
      ? (Promise as unknown as { any: (p: Promise<Blob>[]) => Promise<Blob> }).any(attempts)
      : (async () => {
          let lastErr: unknown;
          for (const p of attempts) { try { return await p; } catch (e) { lastErr = e; } }
          throw lastErr || new Error('all failed');
        })();
    try {
      const blob = await anyOf;
      controllers.forEach(c => c.abort()); // прерываем проигравших
      return URL.createObjectURL(blob);
    } catch {
      await new Promise(r => setTimeout(r, 350 + w * 350)); // пауза перед следующей волной
    }
  }
  throw new Error(`hedge failed: ${url.slice(0, 60)}`);
}

// F-PERF: эти GET-эндпоинты публичные (сервер авторизацию не проверяет), а
// запрос с заголовком Authorization CDN Vercel принципиально НЕ кэширует —
// залогиненные пользователи оставались без edge-ускорения. Cookie всё равно
// уходит автоматически, для этих маршрутов он не нужен.
const PUBLIC_GET_PATHS = new Set(['/api/catalog', '/api/anime', '/api/facets', '/api/random', '/api/search']);

function isPublicGet(url: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return PUBLIC_GET_PATHS.has(new URL(url, window.location.origin).pathname);
  } catch { return false; }
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const auth = init?.method || !isPublicGet(url) ? authHeaders() : {};
  let r = await fetch(url, { ...init, headers: { ...auth, ...init?.headers } });
  // ФИКС race condition age-cookie: пользователь подтвердил 18+ (localStorage
  // валиден), но серверная cookie anime_age_confirmed ещё не поставилась или
  // была очищена — 18+-маршрут отвечает 403. Восстанавливаем cookie и
  // ретраим запрос ровно один раз; иначе каталог оставался пустым («0 из 0»)
  // до полной перезагрузки страницы.
  if (r.status === 403 && typeof window !== 'undefined' && localStorage.getItem('anime_platform_adult_verified')) {
    try {
      await fetch('/api/age-confirm', { method: 'POST', credentials: 'same-origin' });
      r = await fetch(url, { ...init, headers: { ...authHeaders(), ...init?.headers } });
    } catch { /* ретрай не удался — ниже отдаём исходный 403 как ошибку */ }
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ─── Components ──────────────────────────────────────────────────────────
export const FAV_SNAP_KEY = 'fav_ep_snapshot_v1';

export function readFavSnapshot(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(FAV_SNAP_KEY) || '{}'); } catch { return {}; }
}
export function writeFavSnapshot(s: Record<string, number>) {
  try { localStorage.setItem(FAV_SNAP_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/**
 * Сравнивает текущее число серий у избранного со снапшотом прошлых визитов.
 * Тайтл, впервые попавший в снапшот, фиксируется молча — «плюсик» появляется
 * только когда серий стало БОЛЬШЕ, чем при прошлом взгляде.
 */
export function computeFavUpdates(list: Anime[]): FavUpdate[] {
  const snap = readFavSnapshot();
  const next = { ...snap };
  const updates: FavUpdate[] = [];
  for (const a of list) {
    const total = a.episodes || 0;
    if (total <= 0) continue;
    if (!(a.id in next)) { next[a.id] = total; continue; }
    const seen = next[a.id] || 0;
    if (total > seen) updates.push({ anime: a, from: seen, to: total });
  }
  writeFavSnapshot(next);
  return updates;
}

export function pluralEpisodes(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'серия';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'серии';
  return 'серий';
}
export const RECENT_SEARCHES_KEY = 'anime_recent_searches';
