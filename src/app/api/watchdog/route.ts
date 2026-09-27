import { NextRequest, NextResponse } from 'next/server';
import { getDb, authFromRequest } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { recordSyncRun } from '@/lib/sync-status';
import { notifyTelegram } from '@/lib/notify';
import { logEvent } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * WATCHDOG — автопочинка платформы (аудит 27.09.2026).
 *
 * Два равнозначных способа запуска:
 *   1) Крон Vercel (ежедневно 08:30 UTC — vercel.json): Bearer CRON_SECRET.
 *   2) Внешний монитор (cron-job.org / UptimeRobot / локальный watchdog.mjs):
 *      админ-сессия (cookie/Bearer токен сессии) или ?secret=<CRON_SECRET>.
 *
 * ЧТО ПРОВЕРЯЕТ (быстрые проверки по БД, ~2с):
 *   - свежесть синков vost / hentaibaza / games (порог 26ч — сутки + запас);
 *   - наличие контента в anime_catalog (не пустой ли каталог);
 *   - наличие кэша плеера (строки player:page:*);
 *   - конфиг LLM для Лилит (env LLM_API_KEY/LLM_MODEL заданы).
 *
 * ЧТО ЛЕЧИТ (не более ОДНОГО ремонта за прогон — синк занимает ~40с из
 * бюджета 60с; остальное долечит следующий прогон):
 *   - протухший синк → дёргает соответствующий /api/sync-* с Bearer CRON_SECRET;
 *   - пустой/остывший кэш плеера → /api/player-warm?slice=0.
 *
 * Телеметрия: sync_status (source='watchdog') + logEvent + Telegram
 * (если заданы TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID).
 */

/** Сколько часов считаем данные свежими (кроны ежедневные + запас). */
const SYNC_STALE_H = 26;

interface SyncDef {
  source: string;               // строка в sync_status
  repairPath: string;           // эндпоинт ремонта
  label: string;
}

const SYNC_DEFS: SyncDef[] = [
  { source: 'vost', repairPath: '/api/sync-anime?pages=2&ongoing=2&refresh=15', label: 'аниме' },
  { source: 'hentaibaza', repairPath: '/api/sync-hentai?pages=1', label: 'хентай' },
  { source: 'games', repairPath: '/api/sync-games', label: 'игры' },
];

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function getSyncAgeH(source: string): Promise<{ ageH: number | null; status: string | null }> {
  try {
    const db = getDb();
    const { data } = await db
      .from('sync_status')
      .select('last_run_at,last_status')
      .eq('source', source)
      .maybeSingle();
    if (!data?.last_run_at) return { ageH: null, status: null };
    const ageH = (Date.now() - new Date(data.last_run_at).getTime()) / 3_600_000;
    return { ageH, status: data.last_status ?? null };
  } catch {
    return { ageH: null, status: null };
  }
}

async function countRows(table: string, like?: string, column = 'source'): Promise<number | null> {
  try {
    const db = getDb();
    let q = db.from(table).select(column, { count: 'exact', head: true });
    if (like) q = q.like(column, like);
    const { count } = await q;
    return count ?? null;
  } catch {
    return null;
  }
}

/** Запуск ремонта: Bearer CRON_SECRET (тот же рантайм-env). Долгий — таймаут 45с. */
async function triggerRepair(origin: string, path: string): Promise<{ ok: boolean; status: number | null; body: string }> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false, status: null, body: 'CRON_SECRET не задан — ремонт невозможен' };
  try {
    const r = await fetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(45_000),
    });
    const body = (await r.text()).slice(0, 300);
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: null, body: e instanceof Error ? e.message : String(e) };
  }
}

async function watchdogHandler(request: NextRequest) {
  const user = await authFromRequest(request);
  const isAdmin = !!user && user.role === 'admin';
  if (!isCronAuthorized(request) && !isAdmin) {
    logEvent('cron_denied', { path: '/api/watchdog' }, 'warn');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const t0 = Date.now();
  const origin = new URL(request.url).origin;
  const checks: CheckResult[] = [];

  // ── 1. Свежесть синков ──────────────────────────────────────────
  const stale: SyncDef[] = [];
  for (const def of SYNC_DEFS) {
    const { ageH, status } = await getSyncAgeH(def.source);
    const ok = ageH !== null && ageH <= SYNC_STALE_H;
    checks.push({
      name: `sync:${def.source}`,
      ok,
      detail: ageH === null ? 'нет записей в sync_status' : `${ageH.toFixed(1)}ч назад (${status})`,
    });
    if (!ok) stale.push(def);
  }

  // ── 2. Контент в каталоге ──────────────────────────────────────
  const catalogCount = await countRows('anime_catalog', undefined, 'id');
  checks.push({
    name: 'catalog',
    ok: catalogCount !== null && catalogCount > 50,
    detail: catalogCount === null ? 'запрос не удался' : `${catalogCount} записей`,
  });

  // ── 3. Кэш плеера ──────────────────────────────────────────────
  const playerCache = await countRows('sync_status', 'player:page:*');
  checks.push({
    name: 'player-cache',
    ok: playerCache !== null && playerCache > 20,
    detail: playerCache === null ? 'запрос не удался' : `${playerCache} страниц`,
  });

  // ── 4. LLM Лилит ───────────────────────────────────────────────
  const llmConfigured = Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL);
  checks.push({
    name: 'lilith-llm',
    ok: llmConfigured,
    detail: llmConfigured ? `${process.env.LLM_MODEL} (ок)` : 'env LLM_API_KEY/LLM_MODEL не заданы — Лилит на движке-фолбэке',
  });

  // ── Ремонт: ОДНО самое важное (по приоритету списка) ────────────
  let repair: { target: string; result: { ok: boolean; status: number | null; body: string } } | null = null;
  if (stale.length > 0) {
    const def = stale[0];
    repair = { target: def.source, result: await triggerRepair(origin, def.repairPath) };
  } else if ((playerCache !== null && playerCache < 20) || (catalogCount !== null && catalogCount <= 50)) {
    repair = { target: 'player-warm', result: await triggerRepair(origin, '/api/player-warm?slice=0') };
  }

  const failed = checks.filter(c => !c.ok);
  const allOk = failed.length === 0 && (!repair || repair.result.ok);
  const tookMs = Date.now() - t0;

  // ── Телеметрия ─────────────────────────────────────────────────
  await recordSyncRun('watchdog', {
    status: allOk ? 'ok' : 'error',
    details: {
      tookMs,
      checks: Object.fromEntries(checks.map(c => [c.name, { ok: c.ok, detail: c.detail }])),
      repaired: repair ? { target: repair.target, ok: repair.result.ok, status: repair.result.status } : null,
    },
    error: failed.length ? `неудачные проверки: ${failed.map(c => c.name).join(', ')}` : undefined,
  });
  logEvent('watchdog_run', { allOk, failed: failed.map(c => c.name), repaired: repair?.target ?? '—', tookMs }, allOk ? 'info' : 'warn');

  if (!allOk) {
    const lines = [
      '⚠️ Watchdog animeplatforma-new.online',
      ...failed.map(c => `✗ ${c.name}: ${c.detail}`),
      repair ? `🔧 ремонт ${repair.target}: ${repair.result.ok ? 'ок' : 'не удался'}` : '🔧 ремонт не требовался',
      `⏱ ${tookMs}мс`,
    ];
    void notifyTelegram(lines.join('\n'));
  }

  return NextResponse.json({
    ok: allOk,
    checks,
    repair,
    tookMs,
  });
}

export const GET = watchdogHandler;
