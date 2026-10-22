/**
 * Персистентный кэш плеера (фикс 3, 18.09.2026).
 *
 * Причина: v13.vost.pw банит egress-IP (в т.ч. Vercel) по всплескам запросов —
 * «тартпит»: TCP-соединение принимается, но ответ не приходит вовсе (замер:
 * локальный IP после ~10 быстрых запросов уходит в тартпит на минуты;
 * egress Vercel — вплоть до 100% отказов в bad-периоды). In-memory кэш
 * привязан к инстансу serverless-функции и переживает только его жизнь.
 *
 * Решение: список серий и конфиг видео храним в БД (sync_status, строки
 * player:*),service_role обходит RLS. Живые запросы к vost.pw теперь редки:
 *  – страница тайтла: 1 запрос раз в 12ч (список серий почти не меняется);
 *  – конфиг видео (frame5): 1 запрос раз в 20мин (CDN-ссылки с time-токенами);
 *  – при сбое живого запроса отдаём ПРОСРОЧЕННЫЙ кэш (grace), а не ошибку.
 *
 * Строки player:* исключены из админ-страницы «последний синк» (см. getSyncStatus).
 */
import { createHash } from 'crypto';
import { getDb } from '@/lib/db';

// ─── TTL-политики ──────────────────────────────────────────────────────────

/** Список серий: обновляем живым запросом не чаще 20ч — утренний прогрев
 * (кроны 06:20/06:30) покрывает весь день до ~02:20, включая RU-вечер. */
export const PAGE_TTL_MS = 20 * 60 * 60 * 1000;
/** Список серий: предельный возраст, при котором ещё отдаём as-is при сбое источника. */
export const PAGE_STALE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
/** Конфиг видео: CDN-ссылки содержат time-токены — перепроверяем каждые 20мин. */
export const VIDEO_TTL_MS = 20 * 60 * 1000;
/** Конфиг видео: просроченному всё ещё доверяем до 2ч (ссылки живут часы). */
export const VIDEO_STALE_MAX_MS = 2 * 60 * 60 * 1000;

// ─── Ключи ─────────────────────────────────────────────────────────────────

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 20);
}

export function pageCacheKey(url: string): string {
  return `player:page:${shortHash(url)}`;
}

export function videoCacheKey(host: string, id: string): string {
  return `player:video:${shortHash(`${host}|${id}`)}`;
}

// ─── Чтение / запись ───────────────────────────────────────────────────────

interface StoredRow {
  payload: unknown;
  updatedAt: number;
}

async function loadRow(key: string): Promise<StoredRow | null> {
  try {
    const db = getDb();
    const { data } = await db
      .from('sync_status')
      .select('details')
      .eq('source', key)
      .maybeSingle();
    const d = (data?.details || null) as Record<string, unknown> | null;
    if (!d || typeof d.updatedAt !== 'number') return null;
    return { payload: d.payload, updatedAt: d.updatedAt };
  } catch (e) {
    console.error(`player-cache load(${key.slice(0, 24)}…) failed:`, e);
    return null;
  }
}

async function saveRow(key: string, payload: unknown): Promise<void> {
  try {
    const db = getDb();
    const { error } = await db.from('sync_status').upsert(
      {
        source: key,
        last_run_at: new Date().toISOString(),
        last_status: 'ok',
        new_items: 0,
        updated_items: 0,
        details: { payload, updatedAt: Date.now() },
        error: null,
      },
      { onConflict: 'source' },
    );
    if (error) console.error(`player-cache save(${key.slice(0, 24)}…):`, error.message);
  } catch (e) {
    console.error(`player-cache save(${key.slice(0, 24)}…) failed:`, e);
  }
}

// ─── Типизированный API ────────────────────────────────────────────────────

export interface CachedPage {
  entries: [string, string][];
  age: number;
}

export async function loadCachedPage(url: string): Promise<CachedPage | null> {
  const row = await loadRow(pageCacheKey(url));
  if (!row || !Array.isArray(row.payload)) return null;
  const entries = (row.payload as [string, string][]).filter(
    (e) => Array.isArray(e) && e.length === 2,
  );
  if (!entries.length) return null;
  return { entries, age: Date.now() - row.updatedAt };
}

export async function saveCachedPage(url: string, entries: [string, string][]): Promise<void> {
  await saveRow(pageCacheKey(url), entries);
}

export interface VideoQualities {
  qualities: { label: string; urls: string[] }[];
  poster: string;
}

export async function loadCachedVideo(host: string, id: string): Promise<(VideoQualities & { age: number }) | null> {
  const row = await loadRow(videoCacheKey(host, id));
  if (!row || typeof row.payload !== 'object' || row.payload === null) return null;
  const p = row.payload as { qualities?: unknown; poster?: unknown };
  if (!Array.isArray(p.qualities) || !p.qualities.length) return null;
  return {
    qualities: p.qualities as { label: string; urls: string[] }[],
    poster: typeof p.poster === 'string' ? p.poster : '',
    age: Date.now() - row.updatedAt,
  };
}

export async function saveCachedVideo(host: string, id: string, cfg: VideoQualities): Promise<void> {
  await saveRow(videoCacheKey(host, id), cfg);
}
