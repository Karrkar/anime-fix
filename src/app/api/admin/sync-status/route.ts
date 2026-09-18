import { NextRequest, NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/db';
import { withRateLimit } from '@/lib/with-rate-limit';
import { getSyncStatus, SYNC_SOURCE_LABELS } from '@/lib/sync-status';
import { logEvent } from '@/lib/logger';

/**
 * GET /api/admin/sync-status — статус последних запусков всех парсеров.
 *
 * Только для админов (users.role='admin'). Возвращает строки таблицы
 * sync_status, куда sync-роуты пишут результат каждого запуска.
 */
async function syncStatusHandler(request: NextRequest) {
  const user = await authFromRequest(request);
  if (!user || user.role !== 'admin') {
    logEvent('admin_access_denied', { path: '/api/admin/sync-status', userId: user?.id }, 'warn');
    return NextResponse.json(
      { error: 'forbidden', message: 'Доступ только для администраторов' },
      { status: 403 },
    );
  }

  const { rows, tableMissing } = await getSyncStatus();
  return NextResponse.json({
    sources: rows.map(r => ({
      source: r.source,
      label: SYNC_SOURCE_LABELS[r.source] || r.source,
      lastRunAt: r.lastRunAt,
      status: r.lastStatus,
      newItems: r.newItems,
      updatedItems: r.updatedItems,
      details: r.details,
      error: r.error,
    })),
    tableMissing,
  });
}

export const GET = withRateLimit(syncStatusHandler, '/api/admin/sync-status');
