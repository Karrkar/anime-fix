/**
 * Статус синхронизаций для админ-страницы «last sync».
 *
 * Каждый sync-роут (vost / hentaibaza / games) после завершения (успех или
 * ошибка) делает upsert одной строки в таблицу sync_status. Админ-эндпоинт
 * /api/admin/sync-status читает таблицу целиком.
 *
 * Таблица создаётся скриптом scripts/create-sync-status-table.sql
 * (RLS включён, политик нет — чтение/запись только через service_role,
 * т.е. только с сервера).
 */
import { getDb } from '@/lib/db';

export interface SyncRunInfo {
  status: 'ok' | 'error';
  newItems?: number;
  updatedItems?: number;
  details?: Record<string, unknown>;
  error?: string;
}

export async function recordSyncRun(source: string, run: SyncRunInfo): Promise<void> {
  try {
    const db = getDb();
    const row = {
      source,
      last_run_at: new Date().toISOString(),
      last_status: run.status,
      new_items: run.newItems ?? 0,
      updated_items: run.updatedItems ?? 0,
      details: run.details ?? {},
      error: run.error ?? null,
    };
    const { error } = await db
      .from('sync_status')
      .upsert(row, { onConflict: 'source' });
    if (error) console.error(`recordSyncRun(${source}):`, error.message);
  } catch (e) {
    console.error(`recordSyncRun(${source}) failed:`, e);
  }
}

export interface SyncStatusRow {
  source: string;
  lastRunAt: string;
  lastStatus: string;
  newItems: number;
  updatedItems: number;
  details: Record<string, unknown>;
  error: string | null;
}

/** Читает статус всех источников. null — таблицы нет (SQL не выполнен). */
export async function getSyncStatus(): Promise<{ rows: SyncStatusRow[]; tableMissing: boolean }> {
  try {
    const db = getDb();
    const { data, error } = await db
      .from('sync_status')
      .select('*')
      .order('last_run_at', { ascending: false });
    if (error) {
      const code = (error as { code?: string }).code || '';
      if (code === '42P01' || /relation .* does not exist/i.test(error.message)) {
        return { rows: [], tableMissing: true };
      }
      console.error('getSyncStatus:', error.message);
      return { rows: [], tableMissing: false };
    }
    const rows = (data || []).map((r: Record<string, unknown>) => ({
      source: String(r.source || ''),
      lastRunAt: String(r.last_run_at || ''),
      lastStatus: String(r.last_status || ''),
      newItems: Number(r.new_items || 0),
      updatedItems: Number(r.updated_items || 0),
      details: (r.details && typeof r.details === 'object' ? r.details : {}) as Record<string, unknown>,
      error: (r.error as string) || null,
    }));
    return { rows, tableMissing: false };
  } catch (e) {
    console.error('getSyncStatus failed:', e);
    return { rows: [], tableMissing: false };
  }
}

/** Человекочитаемые названия источников */
export const SYNC_SOURCE_LABELS: Record<string, string> = {
  vost: 'v13.vost.pw — аниме и новые серии',
  hentaibaza: 'hentaibaza.com — 18+ каталог',
  games: 'feelex.fun / xxx-igra.com — 18+ игры',
};
