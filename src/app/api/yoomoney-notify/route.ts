import { NextRequest, NextResponse } from 'next/server';
import { getUserByEmail, activateSubscription, getDb } from '@/lib/db';
import { withRateLimit } from '@/lib/with-rate-limit';
import { getPlanById, PLANS } from '@/lib/plans';
import { logEvent, maskEmail } from '@/lib/logger';
import { creditBalance, parseTopupLabel } from '@/lib/balance';
import { notifyTelegram } from '@/lib/notify';
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
 * ПЛЮС ПУТЬ 3 (баланс AP): label вида topup_{userId}_{ts} — пополнение
 *     внутреннего баланса (1 AP = 1 ₽). Матчинг по label из PENDING-интента
 *     → атомарное начисление RPC ap_credit → уведомление в Telegram.
 *
 * Безопасность:
 *  - Подпись уведомления: НОВАЯ `sign` (HMAC-SHA256, с 18.05.2026 ЮMoney
 *    отключил sha1_hash) + легаси sha1_hash для старых ретраев (constant-time)
 *  - fail-closed: без YOO_MONEY_SECRET ничего не активируется (503)
 *  - идемпотентность по operation_id И по payment_label (ретраи ЮMoney не
 *    активируют подписку повторно)
 *
 * КОМИССИЯ CARD-PLATЁЖЕЙ (фикс 26.10.2026, подтверждено телеметрией: платёж
 * 100 ₽ → на кошелёк 97.00 ₽): amount в уведомлении — ЗАЧИСЛЕННАЯ сумма,
 * withdraw_amount — списанная с плательщика. Матчинг цены тарифа ведём по
 * withdraw_amount (точная сумма плательщика), с фолбэком на amount и
 * коридор ±6% (стандартная комиссия приёма карт ~3%).
 */

interface YooMoneyNotification {
  notification_type?: string; // 'p2p-incoming' | 'card-incoming'
  operation_id?: string;
  amount?: string;            // строка, напр. "250.00" — зачислено на кошелёк
  withdraw_amount?: string;   // списано с плательщика (для card-incoming с комиссией)
  currency?: string;          // '643' (RUB)
  datetime?: string;
  sender?: string;
  codepro?: string;           // 'false'
  label?: string;
  sha1_hash?: string;        // легаси-подпись SHA-1 (ЮMoney отключил с 18.05.2026)
  sign?: string;             // НОВАЯ подпись HMAC-SHA256 (с 18.05.2026 — единственная)
  test_notification?: string | boolean; // тестовое уведомление (кнопка «Протестировать»)
  unaccepted?: string;
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

/** RFC 3986 URL-кодирование значения (encodeURIComponent не кодирует !'()* ) */
function rfc3986Encode(v: string): string {
  return encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * НОВАЯ подпись уведомлений ЮMoney (fix 26.10.2026, официальная документация
 * «Уведомление о входящем переводе» — Certification of authenticity):
 *   sign = HEX( HMAC-SHA256( secret, canonical ) )
 *   canonical = «k1=v1&k2=v2&…» — ВСЕ поля уведомления, кроме самого sign,
 *   отсортированные по алфавиту; значения — RFC 3986 URL-encoding;
 *   пустые значения остаются «k=». Результат — hex в нижнем регистре.
 * sha1_hash отключён ЮMoney с 18.05.2026 — без поддержки sign вебхук
 * отвергал бы даже корректно подписанные уведомления.
 */
function computeNotificationSign(params: Record<string, string>, secret: string): string {
  const canonical = Object.keys(params)
    .filter((k) => k !== 'sign')
    .sort()
    .map((k) => `${k}=${rfc3986Encode(params[k] ?? '')}`)
    .join('&');
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

function timingSafeEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufB, bufB); // выравниваем время сравнения
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
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
 * ТЕЛЕМЕТРИЯ (fix 26.10.2026): юMoney-уведомления доходят (rate_limits
 * фиксировал вызовы с IP юMoney), но ни один реальный платёж за историю
 * не активирован (49 PENDING, 0 подтверждений). Без Vercel-логов причину
 * не видно, поэтому каждое уведомление + вердикт обработки пишем в
 * rate_limits (bucket /ymn/<вердикт>/<ms>) — читается из БД.
 */
async function telemetry(n: Partial<YooMoneyNotification> | null, verdict: string): Promise<void> {
  try {
    const db = getDb();
    const summary = JSON.stringify({
      type: n?.notification_type || '',
      op: n?.operation_id || '',
      amount: n?.amount || '',
      curr: n?.currency || '',
      label: (n?.label || '').slice(0, 60),
      sender: n?.sender || '',
      codepro: n?.codepro || '',
      hash: n?.sha1_hash ? 'yes' : 'no',
      sign: n?.sign ? 'yes' : 'no',
      test: n?.test_notification ? 'yes' : 'no',
      wa: (n?.withdraw_amount || '').slice(0, 12),
    }).slice(0, 320);
    await db.from('rate_limits').insert({
      bucket_key: `/ymn/${verdict}/${Date.now()}`,
      ip: summary,
    });
  } catch { /* телеметрия не должна ломать вебхук */ }
}

/**
 * Сумма платежа подходит интенту/тарифу?
 * Матчим: точное совпадение с зачислением ИЛИ суммой плательщика,
 * либо коридор ±6% (комиссия card-incoming ~3%, интент хранит цену тарифа).
 */
function amountMatches(intentAmount: number, paid: number, payerAmount: number): boolean {
  const a = Number(intentAmount);
  if (!Number.isFinite(a) || a <= 0) return false;
  return Math.abs(a - paid) <= 0.01
    || Math.abs(a - payerAmount) <= 0.01
    || (a >= paid * 0.94 && a <= paid * 1.06)
    || (a >= payerAmount * 0.94 && a <= payerAmount * 1.06);
}

/**
 * Ищем самый свежий PENDING-интент с подходящей суммой за последние 24 часа.
 * Защита от отсутствия колонки created_at: фолбэк без временного окна.
 */
async function findPendingIntent(db: ReturnType<typeof getDb>, paid: number, payerAmount: number): Promise<PendingIntent | null> {
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  try {
    const { data, error } = await db
      .from('payments')
      .select('id, user_id, payment_label, amount')
      .eq('operation_id', 'PENDING')
      .gt('created_at', dayAgo)
      .order('created_at', { ascending: false })
      .limit(50);
    if (!error) return (data?.find(r => amountMatches(r.amount, paid, payerAmount)) as PendingIntent) ?? null;
  } catch { /* фолбэк ниже */ }
  // Фолбэк: без окна по времени (если created_at нет в схеме)
  const { data } = await db
    .from('payments')
    .select('id, user_id, payment_label, amount')
    .eq('operation_id', 'PENDING')
    .in('amount', [paid, payerAmount])
    .order('created_at', { ascending: false })
    .limit(1);
  return (data?.[0] as PendingIntent) ?? null;
}

async function yoomoneyNotifyHandler(request: NextRequest) {
  try {
    // ── 1. Секрет ОБЯЗАТЕЛЕН (fail-closed) ──────────────────────────────
    const secret = process.env.YOO_MONEY_SECRET;
    if (!secret) {
      console.error('YooMoney webhook: YOO_MONEY_SECRET не задан — уведомления отклоняются (fail-closed). Активация подписок невозможна.');
      await telemetry(null, 'no_secret');
      return new NextResponse('Server not configured', { status: 503 });
    }

    // ЮMoney присылает уведомление как application/x-www-form-urlencoded.
    // Поддерживаем формально и JSON — на случай ручных тестов.
    const raw = await request.text();
    // Исходные пары «ключ=значение» — для проверки sign нужны ВСЕ поля
    // уведомления (включая неизвестные интерфейсу ниже), а не только типизированные.
    let rawParams: Record<string, string> = {};
    let n: YooMoneyNotification;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      rawParams = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? '')]));
      n = parsed as unknown as YooMoneyNotification;
    } catch {
      rawParams = Object.fromEntries(new URLSearchParams(raw).entries());
      n = rawParams as unknown as YooMoneyNotification;
    }
    const { label, amount, currency, operation_id, notification_type } = n;

    // Кнопка «Протестировать» в настройках HTTP-уведомлений ЮMoney шлёт ПУСТОЕ
    // уведомление (без amount/label) — подтверждаем доступность, ничего не активируя.
    if (String(n.test_notification ?? '') === 'true' || n.test_notification === true) {
      await telemetry(n, 'test_notification');
      return new NextResponse('OK (test)', { status: 200 });
    }

    if (!amount) {
      await telemetry(n, 'no_amount');
      return new NextResponse('Bad request', { status: 400 });
    }

    // ── 2. Проверка подписи ──────────────────────────────────────────────
    // С 18.05.2026 ЮMoney подписывает уведомления параметром sign
    // (HMAC-SHA256, см. computeNotificationSign). Легаси sha1_hash оставлен
    // на случай старых ретраев — формула не изменилась.
    const signGiven = typeof n.sign === 'string' ? n.sign.toLowerCase() : '';
    if (signGiven) {
      if (!timingSafeEq(signGiven, computeNotificationSign(rawParams, secret))) {
        logEvent('webhook_invalid_sign', { label: label || '—', operationId: operation_id || '—' }, 'warn');
        await telemetry(n, 'invalid_sign');
        return new NextResponse('Invalid signature', { status: 403 });
      }
    } else if (n.sha1_hash) {
      if (!verifyNotificationHash(n, secret)) {
        logEvent('webhook_invalid_hash', { label: label || '—', operationId: operation_id || '—' }, 'warn');
        await telemetry(n, 'invalid_hash');
        return new NextResponse('Invalid hash', { status: 403 });
      }
    } else {
      logEvent('webhook_missing_signature', { label: label || '—' }, 'warn');
      await telemetry(n, 'no_signature');
      return new NextResponse('Missing signature', { status: 403 });
    }

    // ── 3. Тип операции и валюта ────────────────────────────────────────
    // Оба типа валидны: p2p-incoming (перевод из кошелька юMoney) и
    // card-incoming (перевод с банковской карты — все платежи по нашим
    // quickpay-ссылкам с paymentType=AC). Формула подписи одна и та же.
    const VALID_TYPES = ['p2p-incoming', 'card-incoming'];
    if (notification_type && !VALID_TYPES.includes(notification_type)) {
      console.error('YooMoney webhook: unexpected notification_type', notification_type);
      await telemetry(n, `bad_type_${notification_type}`);
      return new NextResponse('Unexpected notification type', { status: 400 });
    }
    if (currency && currency !== '643') {
      console.error('YooMoney webhook: unexpected currency', currency);
      await telemetry(n, `bad_currency_${currency}`);
      return new NextResponse('Unexpected currency', { status: 400 });
    }

    const paid = Number(amount);
    if (!Number.isFinite(paid)) {
      await telemetry(n, 'bad_amount');
      return new NextResponse('Bad amount', { status: 400 });
    }

    // Сумма плательщика: card-incoming зачисляет сумму за вычетом комиссии
    // (100 ₽ → 97 ₽). withdraw_amount — сколько реально списали с карты/кошелька.
    const withdraw = n.withdraw_amount ? Number(n.withdraw_amount) : NaN;
    const payerAmount = Number.isFinite(withdraw) && withdraw > 0 ? withdraw : paid;

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
        await telemetry(n, 'duplicate_op');
        return new NextResponse('OK (duplicate)', { status: 200 });
      }
    }

    const opId = operation_id || 'PAID';

    // ── 5. ПУТЬ 3: label topup_<userId>_<ts> — пополнение AP-баланса ────
    if (label && label.startsWith('topup_')) {
      const parsedTopup = parseTopupLabel(label);
      if (!parsedTopup) {
        console.error('YooMoney webhook: invalid topup label format', label);
        return new NextResponse('Invalid label', { status: 400 });
      }
      const ap = Math.round(payerAmount); // 1 AP = 1 ₽ по сумме плательщика; комиссию платит платформа
      if (ap <= 0) {
        console.error('YooMoney webhook: topup amount too small', amount);
        return new NextResponse('Bad amount', { status: 400 });
      }

      // PENDING-интент пополнения (создаётся /api/balance topup)
      const { data: intent } = await db
        .from('payments')
        .select('id, user_id, operation_id')
        .eq('payment_label', label)
        .maybeSingle();

      if (intent) {
        if (intent.operation_id && intent.operation_id !== 'PENDING') {
          console.log(`YooMoney webhook: duplicate topup ${label}, skipping`);
          return new NextResponse('OK (duplicate)', { status: 200 });
        }
        await db.from('payments').update({ operation_id: opId }).eq('id', intent.id);
      } else {
        // Интент не нашли (напр. истёк/затёрт) — label сам содержит userId,
        // а подпись SHA-1 гарантиает, что label не подделан: начисляем по нему.
        const { error: payErr } = await db.from('payments').insert({
          user_id: parsedTopup.userId,
          amount: payerAmount,
          payment_label: label,
          operation_id: opId,
        });
        if (payErr) {
          console.error('YooMoney webhook: failed to record topup payment', payErr);
          return new NextResponse('Payment record failed', { status: 500 });
        }
      }

      try {
        const newBalance = await creditBalance(parsedTopup.userId, ap, 'topup', {
          via: 'webhook', operationId: opId, amountRub: paid,
        });
        logEvent('webhook_topup', { userId: parsedTopup.userId, ap, amount, newBalance, label });
        void notifyTelegram(`💰 Пополнение баланса: +${ap} AP (${amount} ₽)\nБаланс после: ${newBalance} AP`);
        return new NextResponse('OK', { status: 200 });
      } catch (e) {
        // ap_credit RPC нет (миграция ШАГ1 не применена) или ошибка БД —
        // платёж записан, но не начислен: 500 → ЮMoney ретраит уведомление,
        // после применения миграции начисление пройдёт. Кричим владельцу —
        // молча терять деньги пользователей нельзя.
        console.error('YooMoney webhook: topup credit failed', e);
        void notifyTelegram(
          `⚠️ ТОПАП ОПЛАЧЕН, НО НЕ ЗАЧИСЛЕН: +${ap} AP (${amount} ₽, ${label}).\n` +
          `Причина: ${e instanceof Error ? e.message.slice(0, 150) : 'БД'}.\n` +
          'Примените миграцию ШАГ1 (таблицы баланса) в Supabase SQL Editor — ретраи ЮMoney зачислят сами. ' +
          'Если ретраи иссякли — начислите вручную (user_id в платеже).',
        );
        return new NextResponse('Credit failed', { status: 500 });
      }
    }

    // ── 6. ПУТЬ 1: label задан (quickpay-ссылка) ───────────────────────
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

      // Сверка суммы с ценой тарифа: по сумме плательщика (withdraw_amount),
      // зачислению (amount) или коридору комиссии ±6% (100 ₽ → 97 ₽ — валидно)
      if (!amountMatches(plan.price, paid, payerAmount)) {
        logEvent('webhook_amount_mismatch', { paid, payerAmount, withdraw: n.withdraw_amount || '', expected: plan.price, planId: parsed.planId, label }, 'warn');
        await telemetry(n, 'amount_mismatch');
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
        await telemetry(n, 'activated_label');
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
        amount: payerAmount,
        payment_label: label,
        operation_id: opId,
      });
      if (payErr) {
        console.error('YooMoney webhook: failed to record payment', payErr);
        return new NextResponse('Payment record failed', { status: 500 });
      }

      await activateSubscription(user.id, parsed.planId);
      logEvent('webhook_activated', { via: 'label-legacy', email: maskEmail(parsed.email), planId: parsed.planId, amount, label });
      await telemetry(n, 'activated_label_legacy');
      return new NextResponse('OK', { status: 200 });
    }

    // ── 7. ПУТЬ 2: label пустой (персональная страница /to/) ───────────
    // Матчинг: самый свежий PENDING-интент с подходящей суммой за 24 часа.
    const pending = await findPendingIntent(db, paid, payerAmount);
    if (!pending) {
      // Платёж реальный, но сопоставить некому — НЕ отдаём ошибку, чтобы
      // ЮMoney не ретраил впустую; администратор увидит запись в логах.
      logEvent('webhook_unmatched', { amount: paid, operationId: operation_id || '—' }, 'warn');
      await telemetry(n, 'unmatched');
      return new NextResponse('OK (unmatched)', { status: 200 });
    }

    // Интент пополнения баланса (topup_) без label: пополняем баланс владельцу
    if (pending.payment_label && pending.payment_label.startsWith('topup_')) {
      const pt = parseTopupLabel(pending.payment_label);
      const ap = Math.round(payerAmount);
      if (pt && ap > 0) {
        await db.from('payments').update({ operation_id: opId }).eq('id', pending.id);
        try {
          const newBalance = await creditBalance(pt.userId, ap, 'topup', {
            via: 'webhook-amount-match', operationId: opId, amountRub: paid,
          });
          logEvent('webhook_topup', { via: 'amount-match', userId: pt.userId, ap, amount, newBalance });
          void notifyTelegram(`💰 Пополнение баланса: +${ap} AP (${amount} ₽)\nБаланс после: ${newBalance} AP`);
        } catch (e) {
          console.error('YooMoney webhook: topup credit (amount-match) failed', e);
          void notifyTelegram(
            `⚠️ ТОПАП ОПЛАЧЕН, НО НЕ ЗАЧИСЛЕН (матчинг по сумме): +${ap} AP (${amount} ₽, user ${pt.userId}).\n` +
            `Причина: ${e instanceof Error ? e.message.slice(0, 150) : 'БД'}.\n` +
            'Примените миграцию ШАГ1 (таблицы баланса) в Supabase SQL Editor — ретраи ЮMoney зачислят сами.',
          );
          return new NextResponse('Credit failed', { status: 500 });
        }
        return new NextResponse('OK', { status: 200 });
      }
      // Битый topup-label в интенте — не матчим на тариф ниже
      logEvent('webhook_unmatched', { amount: paid, reason: 'bad_topup_intent', operationId: operation_id || '—' }, 'warn');
      await telemetry(n, 'unmatched_bad_topup');
      return new NextResponse('OK (unmatched)', { status: 200 });
    }

    // План: сначала из label интента, иначе — по уникальной цене тарифа
    let planId = '';
    const parsed = pending.payment_label ? parseLabel(pending.payment_label) : null;
    if (parsed) planId = parsed.planId;
    let plan = planId ? getPlanById(planId) : null;
    if (!plan) plan = PLANS.find(p => amountMatches(p.price, paid, payerAmount)) || null;
    if (!plan) {
      logEvent('webhook_unmatched', { amount: paid, reason: 'no_plan_for_amount', operationId: operation_id || '—' }, 'warn');
      await telemetry(n, 'unmatched_no_plan');
      return new NextResponse('OK (unmatched)', { status: 200 });
    }

    await db.from('payments').update({ operation_id: opId }).eq('id', pending.id);
    await activateSubscription(pending.user_id, plan.id);
    logEvent('webhook_activated', { via: 'amount-match', planId: plan.id, amount, label: pending.payment_label || '—' });
    await telemetry(n, 'activated_amount_match');
    return new NextResponse('OK', { status: 200 });
  } catch (e) {
    console.error('YooMoney webhook error:', e)
    return new NextResponse('Error', { status: 500 })
  }
}

export const POST = withRateLimit(yoomoneyNotifyHandler, '/api/yoomoney-notify')
