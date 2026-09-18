'use client';

import { useState, useEffect, useCallback } from 'react';
import { Clock, ChevronLeft, RefreshCw, CheckCircle2, XCircle, Users, Wallet, Hourglass } from 'lucide-react';
import { SkeletonCard } from '@/components/ui';
import { Page } from '@/lib/client-types';
import { apiFetch } from '@/lib/client-utils';
import { PLANS } from '@/lib/plans';

// ─── Admin: подписчики (профили + подписки + платежи ЮMoney) ─────────────
interface SubscriberCard {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  hasActiveSub: boolean;
  activePlan: string | null;
  activeFrom: string | null;
  activeTo: string | null;
  remainingDays: number;
  totalPaid: number;
  confirmedPayments: number;
  pendingPayments: number;
  pendingAmount: number;
  lastPaymentAt: string | null;
  subCount: number;
}

interface SubscribersData {
  stats: {
    totalUsers: number;
    activeSubs: number;
    totalRevenue: number;
    pendingCount: number;
    pendingAmount: number;
  };
  subscribers: SubscriberCard[];
}

function SubscribersSection() {
  const [data, setData] = useState<SubscribersData | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    apiFetch<SubscribersData>('/api/admin/subscribers')
      .then(d => { setData(d); setForbidden(false); })
      .catch(e => {
        if (e.message?.includes('403')) setForbidden(true);
        else setError(String(e.message || e));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const fmt = (iso: string | null) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: '2-digit' });
  };

  if (forbidden) return null; // раздел целиком админский — неинтересным не показываем

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2"><Users className="w-4 h-4 text-[var(--primary)]" /> Подписчики</h2>
          <p className="text-xs text-[var(--muted-foreground)]">Профили, подписки и платежи ЮMoney — только для админа</p>
        </div>
        <button onClick={load} disabled={loading} className="p-2 rounded-lg bg-[var(--card)] border border-[var(--border)] hover:bg-[var(--muted)] disabled:opacity-50" title="Обновить">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-xs text-red-400 mb-3">{error}</div>}

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 2 }, (_, i) => <SkeletonCard key={i} aspect="h-20" />)}</div>
      ) : data && (
        <>
          {/* Сводка */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-3">
              <p className="text-[10px] text-[var(--muted-foreground)]">Пользователей</p>
              <p className="text-xl font-bold">{data.stats.totalUsers}</p>
            </div>
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-3">
              <p className="text-[10px] text-[var(--muted-foreground)]">Активных подписок</p>
              <p className="text-xl font-bold text-emerald-400">{data.stats.activeSubs}</p>
            </div>
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-3">
              <p className="text-[10px] text-[var(--muted-foreground)]">Подтверждено оплат</p>
              <p className="text-xl font-bold">{data.stats.totalRevenue} ₽</p>
            </div>
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-3">
              <p className="text-[10px] text-[var(--muted-foreground)]">Ожидают оплаты</p>
              <p className="text-xl font-bold text-amber-400">{data.stats.pendingCount}<span className="text-xs font-normal text-[var(--muted-foreground)]"> · {data.stats.pendingAmount} ₽</span></p>
            </div>
          </div>

          {/* Карточки подписчиков */}
          <div className="space-y-2">
            {data.subscribers.map(s => (
              <div key={s.id} className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-semibold truncate">{s.email}</span>
                    {s.role === 'admin' && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--primary)]/15 text-[var(--primary)] font-bold uppercase flex-shrink-0">админ</span>}
                  </div>
                  {s.hasActiveSub ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-semibold flex-shrink-0">активна · {s.activePlan}</span>
                  ) : s.pendingPayments > 0 ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-semibold flex-shrink-0">ожидает оплаты</span>
                  ) : s.totalPaid > 0 ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400 font-semibold flex-shrink-0">истекла</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[11px] text-[var(--muted-foreground)]">
                  <span>рег. {fmt(s.createdAt)}</span>
                  {s.hasActiveSub && s.activeTo && (
                    <span className="text-emerald-400">до {fmt(s.activeTo)} ({s.remainingDays} дн.)</span>
                  )}
                  {s.confirmedPayments > 0 && (
                    <span className="flex items-center gap-1"><Wallet className="w-3 h-3" />{s.confirmedPayments} опл. на {s.totalPaid} ₽</span>
                  )}
                  {s.subCount > 1 && <span>подписок: {s.subCount}</span>}
                </div>
                {s.pendingPayments > 0 && (
                  <p className="flex items-center gap-1 mt-1.5 text-[11px] text-amber-400">
                    <Hourglass className="w-3 h-3 flex-shrink-0" />
                    Ожидают подтверждения: {s.pendingPayments} на {s.pendingAmount} ₽{!s.hasActiveSub && ' — если деньги пришли, активируйте вручную выше'}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}


// ─── Admin: статус синхронизаций (last sync) ─────────────────────────────
export interface SyncStatusEntry {
  source: string;
  label: string;
  lastRunAt: string;
  status: string;
  newItems: number;
  updatedItems: number;
  details: Record<string, unknown>;
  error: string | null;
}

export function AdminPage({ onBack, onNavigate }: { onBack: () => void; onNavigate: (p: Page) => void }) {
  const [rows, setRows] = useState<SyncStatusEntry[] | null>(null);
  const [tableMissing, setTableMissing] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  // Ручная активация подписки (платежи мимо вебхука ЮMoney)
  const [actEmail, setActEmail] = useState('');
  const [actPlan, setActPlan] = useState('1m');
  const [actBusy, setActBusy] = useState(false);
  const [actMsg, setActMsg] = useState('');
  const [actErr, setActErr] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    apiFetch<{ sources: SyncStatusEntry[]; tableMissing: boolean }>('/api/admin/sync-status')
      .then(d => { setRows(d.sources); setTableMissing(d.tableMissing); setForbidden(false); })
      .catch(e => {
        if (e.message?.includes('403')) setForbidden(true);
        else setError(String(e.message || e));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const activateManually = useCallback(async () => {
    setActBusy(true); setActMsg(''); setActErr('');
    try {
      const d = await apiFetch<{ ok: boolean; message: string }>('/api/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'admin-activate', email: actEmail, planId: actPlan }),
      });
      setActMsg(d.message || 'Подписка активирована');
      setActEmail('');
    } catch (e) {
      const m = String((e as Error).message || e);
      setActErr(
        m.includes('403') ? 'Доступ только для администратора'
        : m.includes('404') ? 'Пользователь с таким email не найден'
        : m.includes('400') ? 'Укажите корректный email и тариф'
        : 'Ошибка сервера, попробуйте ещё раз'
      );
    }
    setActBusy(false);
  }, [actEmail, actPlan]);

  const fmtDate = (iso: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="animate-fade-in max-w-2xl mx-auto">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] mb-4 transition-colors">
        <ChevronLeft className="w-4 h-4" /> В профиль
      </button>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><RefreshCw className="w-5 h-5 text-[var(--primary)]" /> Статус синхронизаций</h1>
          <p className="text-xs text-[var(--muted-foreground)] mt-1">Последний запуск парсеров по каждому источнику</p>
        </div>
        <button onClick={load} disabled={loading} className="p-2 rounded-lg bg-[var(--card)] border border-[var(--border)] hover:bg-[var(--muted)] disabled:opacity-50" title="Обновить">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Подписчики: профили + подписки + платежи — только админ */}
      {!forbidden && <SubscribersSection />}

      {/* Ручная активация подписки (платежи мимо вебхука ЮMoney) — только админ */}
      {!forbidden && (
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4 mb-4">
          <h2 className="text-sm font-semibold mb-1">Активировать подписку вручную</h2>
          <p className="text-[11px] text-[var(--muted-foreground)] mb-3">
            Для платежей мимо вебхука: прямой перевод на кошелёк ЮMoney, СБП или личная договорённость.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={actEmail}
              onChange={e => setActEmail(e.target.value)}
              placeholder="email пользователя"
              type="email"
              className="flex-1 px-3 py-2 rounded-lg bg-[var(--muted)] border border-[var(--border)] text-sm outline-none focus:border-[var(--primary)]/50"
            />
            <select
              value={actPlan}
              onChange={e => setActPlan(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[var(--muted)] border border-[var(--border)] text-sm outline-none"
            >
              {PLANS.map(p => (
                <option key={p.id} value={p.id}>{p.label} — {p.price} ₽</option>
              ))}
            </select>
            <button
              onClick={activateManually}
              disabled={actBusy || !actEmail}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-gradient-to-r from-[var(--primary)] to-[var(--accent)] hover:opacity-90 disabled:opacity-50 transition-all"
            >
              {actBusy ? 'Активируем...' : 'Активировать'}
            </button>
          </div>
          {actMsg && <p className="text-xs text-emerald-400 mt-2">✓ {actMsg}</p>}
          {actErr && <p className="text-xs text-red-400 mt-2">{actErr}</p>}
        </div>
      )}

      {forbidden && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400 flex items-center gap-2">
          <XCircle className="w-4 h-4 flex-shrink-0" /> Доступ только для администраторов (users.role = admin).
        </div>
      )}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">{error}</div>
      )}
      {tableMissing && !loading && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-sm text-amber-300 mb-4">
          Таблица sync_status ещё не создана. Выполните скрипт <code className="text-xs">scripts/create-sync-status-table.sql</code> в Supabase SQL Editor.
        </div>
      )}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => <SkeletonCard key={i} aspect="h-24" />)}
        </div>
      ) : !forbidden && !error && rows && rows.length === 0 ? (
        <div className="text-center py-16 text-[var(--muted-foreground)]">
          <Clock className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p>Кроны ещё не запускались — данные появятся после первого прогона (ежедневно в 06:00 UTC).</p>
        </div>
      ) : rows && rows.length > 0 && (
        <div className="space-y-3">
          {rows.map(r => (
            <div key={r.source} className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  {r.status === 'ok'
                    ? <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    : <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{r.label}</p>
                    <p className="text-[11px] text-[var(--muted-foreground)]">{fmtDate(r.lastRunAt)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {r.newItems > 0 && <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-semibold">+{r.newItems} новых</span>}
                  {r.updatedItems > 0 && <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400 font-semibold">{r.updatedItems} обновл.</span>}
                </div>
              </div>
              {r.error && <p className="text-xs text-red-400 mt-1">{r.error}</p>}
              {r.details && Object.keys(r.details).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {Object.entries(r.details).map(([k, v]) => (
                    <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--muted)] text-[var(--muted-foreground)]">{k}: {String(v)}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <button onClick={() => onNavigate('profile')} className="mt-6 text-xs text-[var(--muted-foreground)] hover:text-[var(--primary)] transition-colors">
        Вернуться в профиль
      </button>
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────
