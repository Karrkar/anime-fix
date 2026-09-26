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
