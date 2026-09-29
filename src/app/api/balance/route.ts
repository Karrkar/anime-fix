import { NextRequest, NextResponse } from 'next/server';
import { getUserByToken, activateSubscription, getDb } from '@/lib/db';
import { withRateLimit } from '@/lib/with-rate-limit';
import { getClientIp } from '@/lib/rate-limit';
import { validatePlanId } from '@/lib/validate';
import { PLANS } from '@/lib/plans';
import { logEvent } from '@/lib/logger';
import { buildYooMoneyUrl, buildTransferUrl, getSuccessUrl } from '@/lib/yoomoney';
import {
  getBalance, getHistory, creditBalance, debitBalance, redeemCode,
  validateTopupAmount, AP_PER_RUB,
} from '@/lib/balance';

export const dynamic = 'force-dynamic';

/**
 * AP-БАЛАНС: внутренняя валюта платформы (1 AP = 1 ₽).
 *
 * GET  → { balance, transactions[] }      — мой баланс и история (последние 20)
 * POST { action } — все действия требуют сессию (httpOnly cookie / Bearer):
 *   topup  { amountAp }  — платёжная ссылка ЮMoney на пополнение (label topup_…)
 *   spend  { planId }    — списать тариф с баланса → мгновенная активация
 *   redeem { code }      — активировать промо-код AP-XXXXX-XXXXX
 *
 * Безопасность: rate-limit на роут; списание атомарно (RPC ap_debit, где
 * WHERE balance >= amount); при сбое активации после списания — автокомпенсация
 * (начисляем списанное обратно, kind=admin, meta refund).
 */

function tokenFrom(request: NextRequest): string | undefined {
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return request.cookies.get('anime_platform_token')?.value;
}

async function balanceHandler(request: NextRequest) {
  const ip = getClientIp(request);
  try {
    const body = request.method === 'POST' ? await request.json() : {};
    const { action } = body;

    // ── аутентификация для всех действий ──
    const token = tokenFrom(request) || (typeof body.token === 'string' ? body.token : undefined);
    if (!token) return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
    const user = await getUserByToken(token);
    if (!user) return NextResponse.json({ error: 'Сессия истекла' }, { status: 401 });

    // ── GET / any read action: баланс + история ──
    if (request.method === 'GET' || !action || action === 'history') {
      const [balance, transactions] = await Promise.all([
        getBalance(user.id),
        getHistory(user.id, 20),
      ]);
      return NextResponse.json({
        ok: true,
        balance,
        apPerRub: AP_PER_RUB,
        transactions,
      });
    }

    // ── TOPUP: платёжная ссылка на пополнение ──
    if (action === 'topup') {
      const amountAp = validateTopupAmount(body.amountAp);
      if (!amountAp) {
        return NextResponse.json(
          { error: 'Сумма пополнения: целое число от 50 до 10000 AP (1 AP = 1 ₽)' },
          { status: 400 },
        );
      }

      // label вида topup_<userId>_<ts> — uuid не содержит '_', разбор однозначен
      const label = `topup_${user.id}_${Date.now()}`.slice(0, 64);
      const paymentUrl = buildYooMoneyUrl(
        amountAp * AP_PER_RUB,
        label,
        getSuccessUrl(request.headers.get('x-forwarded-host') || request.headers.get('host'), request.headers.get('x-forwarded-proto')),
      );
      if (!paymentUrl) {
        console.error('balance topup: YOO_MONEY_RECEIVER не задан или битый формат');
        return NextResponse.json({ error: 'Приём платежей временно не работает. Попробуйте позже.' }, { status: 503 });
      }
      const paymentUrlQuickpay = buildTransferUrl(amountAp * AP_PER_RUB);

      // PENDING-интент: вебхук найдёт по label и начислит баланс
      const db = getDb();
      const { error: intentErr } = await db.from('payments').insert({
        user_id: user.id,
        amount: amountAp * AP_PER_RUB,
        payment_label: label,
        operation_id: 'PENDING',
      });
      if (intentErr) console.error('balance topup: PENDING intent failed', intentErr);

      logEvent('balance_topup_started', { userId: user.id, amountAp, ip });
      return NextResponse.json({
        ok: true,
        paymentUrl,
        paymentUrlQuickpay,
        amountAp,
        label,
        message: 'Оплатите пополнение через YooMoney',
      });
    }

    // ── SPEND: купить подписку с баланса ──
    if (action === 'spend') {
      const validPlanId = validatePlanId(body.planId);
      if (!validPlanId) return NextResponse.json({ error: 'Некорректный план' }, { status: 400 });
      const plan = PLANS.find(p => p.id === validPlanId);
      if (!plan) return NextResponse.json({ error: 'План не найден' }, { status: 400 });

      const priceAp = plan.price; // 1 AP = 1 ₽
      const balanceBefore = await getBalance(user.id);
      if (balanceBefore < priceAp) {
        return NextResponse.json(
          { error: `Недостаточно AP: нужно ${priceAp}, на балансе ${balanceBefore}`, need: priceAp, balance: balanceBefore },
          { status: 402 },
        );
      }

      // атомарное списание (RPC вернёт null, если кто-то успел списать раньше)
      const newBalance = await debitBalance(user.id, priceAp, 'spend', { planId: plan.id });
      if (newBalance === null) {
        return NextResponse.json({ error: 'Недостаточно AP (баланс изменился)', balance: await getBalance(user.id) }, { status: 402 });
      }

      // активация подписки; при сбое — компенсация списанного
      try {
        await activateSubscription(user.id, plan.id);
      } catch (e) {
        await creditBalance(user.id, priceAp, 'admin', { refund: true, planId: plan.id, reason: 'activate_failed' })
          .catch(() => console.error('balance spend: REFUND FAILED — ручная проверка!', user.id, priceAp));
        console.error('balance spend: activateSubscription failed', e);
        return NextResponse.json({ error: 'Не удалось активировать подписку — AP возвращены на баланс' }, { status: 500 });
      }

      logEvent('balance_spend', { userId: user.id, planId: plan.id, priceAp, newBalance, ip });
      return NextResponse.json({
        ok: true,
        balance: newBalance,
        planId: plan.id,
        message: 'Подписка активирована с баланса AP',
      });
    }

    // ── REDEEM: активировать промо-код ──
    if (action === 'redeem') {
      const code = typeof body.code === 'string' ? body.code.slice(0, 64) : '';
      if (!code) return NextResponse.json({ error: 'Введите промо-код' }, { status: 400 });
      const result = await redeemCode(user.id, code);
      if (!result.ok) {
        const msg = result.reason === 'already'
          ? 'Этот код уже активирован вами ранее'
          : 'Код не найден, истёк или исчерпан';
        logEvent('promo_redeem_failed', { userId: user.id, reason: result.reason, ip });
        return NextResponse.json({ error: msg }, { status: 400 });
      }
      logEvent('promo_redeemed', { userId: user.id, amountAp: result.amountAp, ip });
      return NextResponse.json({
        ok: true,
        amountAp: result.amountAp,
        balance: result.balance,
        message: `Промо-код активирован: +${result.amountAp} AP`,
      });
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
  } catch (e) {
    console.error('balance route error:', e);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}

export const GET = withRateLimit(balanceHandler, '/api/balance');
export const POST = withRateLimit(balanceHandler, '/api/balance');
