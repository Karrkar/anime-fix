import { NextRequest, NextResponse } from 'next/server';
import { authFromRequest, getDb } from '@/lib/db';
import { withRateLimit } from '@/lib/with-rate-limit';
import { getPlanById } from '@/lib/plans';
import { logEvent } from '@/lib/logger';

/**
 * GET /api/admin/subscribers — платные подписчики для админ-раздела «Подписчики».
 *
 * Только для админов (users.role='admin') — проверка НА СЕРВЕРЕ по сессии:
 * обычный пользователь получает 403 и данные не покидают API вовсе
 * (скрытие кнопки в UI — лишь удобство, настоящая защита здесь).
 *
 * Агрегирует три таблицы Supabase:
 *  - users          → профиль (email, role, дата регистрации)
 *  - subscriptions  → тарифы, даты активации/окончания, is_active
 *  - payments       → платежи ЮMoney: operation_id='PENDING' = интент без
 *                     подтверждения вебхуком; остальное = подтверждено
 */

interface UserRow {
  id: string;
  email: string;
  role: string;
  created_at: string;
}

interface SubRow {
  id: string;
  user_id: string;
  plan_id: string;
  activated_at: string;
  expires_at: string;
  is_active: boolean;
}

interface PayRow {
  id: number;
  user_id: string;
  amount: number;
  operation_id: string | null;
  payment_label: string | null;
  created_at: string;
}

export interface SubscriberCard {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  hasActiveSub: boolean;
  activePlan: string | null;      // label тарифа, напр. «3 месяца»
  activeFrom: string | null;
  activeTo: string | null;
  remainingDays: number;
  totalPaid: number;              // сумма подтверждённых платежей, ₽
  confirmedPayments: number;      // сколько платежей подтверждено вебхуком
  pendingPayments: number;        // интентов без подтверждения
  pendingAmount: number;          // сумма интентов, ₽
  lastPaymentAt: string | null;
  subCount: number;               // всего записей подписок (вкл. продления)
}

async function subscribersHandler(request: NextRequest) {
  // ── Серверный гейт: только admin ───────────────────────────────────────
  const user = await authFromRequest(request);
  if (!user || user.role !== 'admin') {
    logEvent('admin_access_denied', { path: '/api/admin/subscribers', userId: user?.id }, 'warn');
    return NextResponse.json(
      { error: 'forbidden', message: 'Доступ только для администраторов' },
      { status: 403 },
    );
  }

  const db = getDb();

  const [usersRes, subsRes, paysRes] = await Promise.all([
    db.from('users').select('id, email, role, created_at').order('created_at', { ascending: false }).limit(2000),
    db.from('subscriptions').select('id, user_id, plan_id, activated_at, expires_at, is_active').order('activated_at', { ascending: false }).limit(5000),
    db.from('payments').select('id, user_id, amount, operation_id, payment_label, created_at').order('created_at', { ascending: false }).limit(5000),
  ]);

  const users = (usersRes.data || []) as UserRow[];
  const subs = (subsRes.data || []) as SubRow[];
  const pays = (paysRes.data || []) as PayRow[];

  const nowIso = new Date().toISOString();

  // Индексы по user_id
  const subsByUser = new Map<string, SubRow[]>();
  for (const s of subs) {
    const arr = subsByUser.get(s.user_id) || [];
    arr.push(s);
    subsByUser.set(s.user_id, arr);
  }
  const paysByUser = new Map<string, PayRow[]>();
  for (const p of pays) {
    const arr = paysByUser.get(p.user_id) || [];
    arr.push(p);
    paysByUser.set(p.user_id, arr);
  }

  let confirmedRevenue = 0;
  let pendingCount = 0;
  let pendingAmount = 0;

  const subscribers: SubscriberCard[] = users.map(u => {
    const uSubs = subsByUser.get(u.id) || [];
    const uPays = paysByUser.get(u.id) || [];

    const activeSub = uSubs.find(s => s.is_active && s.expires_at > nowIso) || null;
    const confirmed = uPays.filter(p => p.operation_id && p.operation_id !== 'PENDING');
    const pending = uPays.filter(p => !p.operation_id || p.operation_id === 'PENDING');

    const totalPaid = confirmed.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const pendAmt = pending.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    confirmedRevenue += totalPaid;
    pendingCount += pending.length;
    pendingAmount += pendAmt;

    const lastPay = uPays[0]?.created_at || null;

    return {
      id: u.id,
      email: u.email,
      role: u.role,
      createdAt: u.created_at,
      hasActiveSub: !!activeSub,
      activePlan: activeSub ? (getPlanById(activeSub.plan_id)?.label || activeSub.plan_id) : null,
      activeFrom: activeSub?.activated_at || null,
      activeTo: activeSub?.expires_at || null,
      remainingDays: activeSub
        ? Math.max(0, Math.ceil((new Date(activeSub.expires_at).getTime() - Date.now()) / 86400000))
        : 0,
      totalPaid,
      confirmedPayments: confirmed.length,
      pendingPayments: pending.length,
      pendingAmount: pendAmt,
      lastPaymentAt: lastPay,
      subCount: uSubs.length,
    };
  });

  // Сортировка: активные подписчики → есть ожидающие платежи → остальные,
  // внутри — по сумме оплат, затем по дате регистрации
  subscribers.sort((a, b) => {
    if (a.hasActiveSub !== b.hasActiveSub) return a.hasActiveSub ? -1 : 1;
    const ap = a.pendingPayments > 0 ? 1 : 0;
    const bp = b.pendingPayments > 0 ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (a.totalPaid !== b.totalPaid) return b.totalPaid - a.totalPaid;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const activeSubs = subscribers.filter(s => s.hasActiveSub).length;

  return NextResponse.json({
    stats: {
      totalUsers: users.length,
      activeSubs,
      totalRevenue: confirmedRevenue,
      pendingCount,
      pendingAmount,
    },
    subscribers,
  });
}

export const GET = withRateLimit(subscribersHandler, '/api/admin/subscribers');
