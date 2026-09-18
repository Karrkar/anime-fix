import { NextRequest, NextResponse } from 'next/server';
import { getUserByEmail, activateSubscription, getDb } from '@/lib/db';
import { withRateLimit } from '@/lib/with-rate-limit';
import { getPlanById, PLANS } from '@/lib/plans';
import { logEvent, maskEmail } from '@/lib/logger';
import crypto from 'crypto';

/**
 * YooMoney Instant Payment Notification (IPN) webhook endpoint.
 *
 * Setup in YooMoney settings:
 *   Notification URL: https://<домен>/api/yoomoney-notify
 *   Secret: тот же, что в env YOO_MONEY_SECRET
 *
 * ДВА ПУТИ АКТИВАЦИИ (поддерживают «заплатил → подписка активировалась»
 * для обоих способов оплаты):
 *
 *  1. quickpay-ссылка (запасной путь) — label вида ap_{planId}_{email}_{ts}
 *     приходит в уведомлении → точный матчинг → активация.
 *
 *  2. персональная страница перевода yoomoney.ru/to/{кошелёк} (основной путь) —
 *     label через неё НЕ передаётся. При subscribe мы записываем в payments
 *     PENDING-интент (operation_id='PENDING', сумма тарифа, user_id). Когда
 *     приходит уведомление без label — вебхук берёт САМЫЙ СВЕЖИЙ PENDING-интент
 *     с той же суммой за последние 24 часа и активирует подписку его владельцу.
 *     Цены тарифов уникальны (100/250/500/1000 ₽) → коллизий практически нет.
 *
 * Безопасность:
 *  - SHA-1 по официальной схеме p2p-incoming (constant-time сравнение)
 *  - fail-closed: без YOO_MONEY_SECRET ничего не активируется (503)
 *  - идемпотентность по operation_id И по payment_label (ретраи ЮMoney не
 *    активируют подписку повторно)
 */

interface YooMoneyNotification {
  notification_type?: string; // 'p2p-incoming'
  operation_id?: string;
  amount?: string;            // строка, напр. "250.00"
  withdraw_amount?: string;   // сумма списанная с плательщика
  currency?: string;          // '643' (RUB)
  datetime?: string;
  sender?: string;
  codepro?: string;           // 'false'
  label?: string;
  sha1_hash?: string;
}

function verifyNotificationHash(n: YooMoneyNotification, secret: string): boolean {
  // Официальный порядок полей из документации ЮMoney (HTTP-уведомления p2p-incoming).
  // Отсутствующий label участвует в подписи как пустая строка.
  const canonical = [
    n.notification_type || '',
    n.operation_id || '',
    n.amount || '',
    n.currency || '',
    n.datetime || '',
    n.sender || '',
    n.codepro || '',
    secret,
    n.label || '',
  ].join('&');

  const expected = crypto.createHash('sha1').update(canonical).digest('hex');
  const given = n.sha1_hash || '';

  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** Парсим planId и email из label вида ap_{planId}_{email}_{timestamp} */
function parseLabel(label: string): { planId: string; email: string } | null {
  const parts = label.split('_');
  if (parts.length < 4 || parts[0] !== 'ap') return null;
  const planId = parts[1];
  const email = parts.slice(2, -1).join('_').toLowerCase();
  if (!planId || !email) return null;
  return { planId, email };
}

interface PendingIntent {
  id: string;
  user_id: string;
  payment_label: string | null;
}

/**
 * Ищем самый свежий PENDING-интент с той же суммой за последние 24 часа.
 * Защита от отсутствия колонки created_at: фолбэк без временного окна.
 */
async function findPendingIntent(db: ReturnType<typeof getDb>, paid: number): Promise<PendingIntent | null> {
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  try {
    const { data, error } = await db
      .from('payments')
      .select('id, user_id, payment_label')
      .eq('operation_id', 'PENDING')
      .eq('amount', paid)
      .gt('created_at', dayAgo)
      .order('created_at', { ascending: false })
      .limit(1);
    if (!error) return (data?.[0] as PendingIntent) ?? null;
  } catch { /* фолбэк ниже */ }
  // Фолбэк: без окна по времени (если created_at нет в схеме)
  const { data } = await db
    .from('payments')
    .select('id, user_id, payment_label')
    .eq('operation_id', 'PENDING')
    .eq('amount', paid)
    .limit(1);
  return (data?.[0] as PendingIntent) ?? null;
}

async function yoomoneyNotifyHandler(request: NextRequest) {
  try {
    // ── 1. Секрет ОБЯЗАТЕЛЕН (fail-closed) ──────────────────────────────
    const secret = process.env.YOO_MONEY_SECRET;
    if (!secret) {
      console.error('YooMoney webhook: YOO_MONEY_SECRET не задан — уведомления отклоняются (fail-closed). Активация подписок невозможна.');
      return new NextResponse('Server not configured', { status: 503 });
    }

    // ЮMoney присылает уведомление как application/x-www-form-urlencoded.
    // Поддерживаем формально и JSON — на случай ручных тестов.
    const raw = await request.text();
    let n: YooMoneyNotification;
    try {
      n = JSON.parse(raw) as YooMoneyNotification;
    } catch {
      n = Object.fromEntries(new URLSearchParams(raw).entries()) as YooMoneyNotification;
    }
    const { label, amount, currency, operation_id, notification_type } = n;

    if (!amount) {
      return new NextResponse('Bad request', { status: 400 });
    }

    // ── 2. Официальная проверка SHA-1 (обязательно, label может быть пустым) ──
    if (!n.sha1_hash) {
      logEvent('webhook_missing_hash', { label: label || '—' }, 'warn');
      return new NextResponse('Missing hash', { status: 403 });
    }
    if (!verifyNotificationHash(n, secret)) {
      logEvent('webhook_invalid_hash', { label: label || '—', operationId: operation_id || '—' }, 'warn');
      return new NextResponse('Invalid hash', { status: 403 });
    }

    // ── 3. Тип операции и валюта ────────────────────────────────────────
    if (notification_type && notification_type !== 'p2p-incoming') {
      console.error('YooMoney webhook: unexpected notification_type', notification_type);
      return new NextResponse('Unexpected notification type', { status: 400 });
    }
    if (currency && currency !== '643') {
      console.error('YooMoney webhook: unexpected currency', currency);
      return new NextResponse('Unexpected currency', { status: 400 });
    }

    const paid = Number(amount);
    if (!Number.isFinite(paid)) {
      return new NextResponse('Bad amount', { status: 400 });
    }

    const db = getDb();

    // ── 4. Идемпотентность по operation_id (ретраи ЮMoney) ─────────────
    if (operation_id) {
      const { data: byOp } = await db
        .from('payments')
        .select('id')
        .eq('operation_id', operation_id)
        .maybeSingle();
      if (byOp) {
        console.log(`YooMoney webhook: duplicate operation ${operation_id}, skipping`);
        return new NextResponse('OK (duplicate)', { status: 200 });
      }
    }

    const opId = operation_id || 'PAID';

    // ── 5. ПУТЬ 1: label задан (quickpay-ссылка) ───────────────────────
    if (label && label.startsWith('ap_')) {
      const parsed = parseLabel(label);
      if (!parsed) {
        console.error('YooMoney webhook: invalid label format', label);
        return new NextResponse('Invalid label', { status: 400 });
      }
      const plan = getPlanById(parsed.planId);
      if (!plan) {
        console.error('YooMoney webhook: invalid planId', parsed.planId);
        return new NextResponse('Invalid plan', { status: 400 });
      }

      // Сверка суммы с ценой тарифа
      if (Math.abs(paid - plan.price) > 0.01) {
        logEvent('webhook_amount_mismatch', { paid: amount, expected: plan.price, planId: parsed.planId, label }, 'warn');
        return new NextResponse('Amount mismatch', { status: 403 });
      }

      // Есть ли PENDING-интент с этим label?
      const { data: intent } = await db
        .from('payments')
        .select('id, user_id, operation_id')
        .eq('payment_label', label)
        .maybeSingle();

      if (intent) {
        if (intent.operation_id && intent.operation_id !== 'PENDING') {
          console.log(`YooMoney webhook: duplicate payment ${label}, skipping`);
          return new NextResponse('OK (duplicate)', { status: 200 });
        }
        // Резолвим интент и активируем владельцу
        await db.from('payments').update({ operation_id: opId }).eq('id', intent.id);
        await activateSubscription(intent.user_id, parsed.planId);
        logEvent('webhook_activated', { via: 'label', email: maskEmail(parsed.email), planId: parsed.planId, amount, label });
        return new NextResponse('OK', { status: 200 });
      }

      // Легаси/прямые тесты: интента нет — находим/создаём юзера по email из label
      let user = await getUserByEmail(parsed.email);
      if (!user) {
        const randomPw = crypto.randomBytes(16).toString('hex');
        const { hashPassword } = await import('@/lib/db');
        const hashedPw = await hashPassword(randomPw);
        const { data: newUser, error: createErr } = await db
          .from('users')
          .insert({ email: parsed.email, password_hash: hashedPw, role: 'user' })
          .select('id')
          .single();
        if (createErr || !newUser) {
          console.error('YooMoney webhook: failed to create user', createErr);
          return new NextResponse('User creation failed', { status: 500 });
        }
        user = { id: newUser.id, email: parsed.email };
      }

      const { error: payErr } = await db.from('payments').insert({
        user_id: user.id,
        amount: paid,
        payment_label: label,
        operation_id: opId,
      });
      if (payErr) {
        console.error('YooMoney webhook: failed to record payment', payErr);
        return new NextResponse('Payment record failed', { status: 500 });
      }

      await activateSubscription(user.id, parsed.planId);
      logEvent('webhook_activated', { via: 'label-legacy', email: maskEmail(parsed.email), planId: parsed.planId, amount, label });
      return new NextResponse('OK', { status: 200 });
    }

    // ── 6. ПУТЬ 2: label пустой (персональная страница /to/) ───────────
    // Матчинг: самый свежий PENDING-интент с той же суммой за 24 часа.
    const pending = await findPendingIntent(db, paid);
    if (!pending) {
      // Платёж реальный, но сопоставить некому — НЕ отдаём ошибку, чтобы
      // ЮMoney не ретраил впустую; администратор увидит запись в логах.
      logEvent('webhook_unmatched', { amount: paid, operationId: operation_id || '—' }, 'warn');
      return new NextResponse('OK (unmatched)', { status: 200 });
    }

    // План: сначала из label интента, иначе — по уникальной цене тарифа
    let planId = '';
    const parsed = pending.payment_label ? parseLabel(pending.payment_label) : null;
    if (parsed) planId = parsed.planId;
    let plan = planId ? getPlanById(planId) : null;
    if (!plan) plan = PLANS.find(p => Math.abs(p.price - paid) <= 0.01) || null;
    if (!plan) {
      logEvent('webhook_unmatched', { amount: paid, reason: 'no_plan_for_amount', operationId: operation_id || '—' }, 'warn');
      return new NextResponse('OK (unmatched)', { status: 200 });
    }

    await db.from('payments').update({ operation_id: opId }).eq('id', pending.id);
    await activateSubscription(pending.user_id, plan.id);
    logEvent('webhook_activated', { via: 'amount-match', planId: plan.id, amount, label: pending.payment_label || '—' });
    return new NextResponse('OK', { status: 200 });
  } catch (e) {
    console.error('YooMoney webhook error:', e)
    return new NextResponse('Error', { status: 500 })
  }
}

export const POST = withRateLimit(yoomoneyNotifyHandler, '/api/yoomoney-notify')
