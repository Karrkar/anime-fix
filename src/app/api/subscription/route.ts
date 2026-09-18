import { NextRequest, NextResponse } from 'next/server';
import { hashPassword, verifyPassword, generateToken, getUserByToken, activateSubscription, getUserByEmail, getDb, passwordNeedsRehash, capUserSessions, cleanupExpiredSessions } from '@/lib/db';
import { withRateLimit } from '@/lib/with-rate-limit';
import { getClientIp } from '@/lib/rate-limit';
import { sanitizeEmail, validatePassword, validatePasswordStrict, validatePlanId } from '@/lib/validate';
import { PLANS, Plan } from '@/lib/plans';
import { logEvent, maskEmail } from '@/lib/logger';

// F-07 fix: сессия живёт в httpOnly cookie (недоступна JS -> не крадётся при XSS).
// Bearer-токен в теле запроса остаётся как legacy-мост на время миграции.
const COOKIE_OPTS = {
  httpOnly: true as const,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 30 * 24 * 60 * 60, // 30 дней — как у сессий в БД
};

/** Токен из body (legacy) или из cookie — везде одинаково */
function tokenFromBodyOrCookie(request: NextRequest, body: Record<string, unknown>): string | undefined {
  if (typeof body.token === 'string' && body.token) return body.token;
  return request.cookies.get('anime_platform_token')?.value;
}

// ─── YooMoney payment URL builder ────────────────────────────────────────

/**
 * F-02 fix: в проекте задана переменная YOO_MONEY_RECEIVER, а код читал
 * YOO_MONEY_WALLET -> в платёжной ссылке уходил пустой receiver, и оплата
 * была невозможна в принципе. Теперь читаем обе (RECEIVER приоритетнее)
 * и проверяем формат кошелька ЮMoney (11–16 цифр, обычно 41001...).
 */
function getReceiverWallet(): string {
  const raw = process.env.YOO_MONEY_RECEIVER || process.env.YOO_MONEY_WALLET || '';
  const receiver = raw.trim();
  if (!/^\d{11,16}$/.test(receiver)) return '';
  return receiver;
}

/**
 * «Перевод по кнопке» (quickpay) — ОСНОВНАЯ платёжная ссылка.
 *
 * ИСТОРИЯ ФИКСА: до сентября 2026 ссылка строилась с устаревшими параметрами
 * quickpay-form=shop + amount= — и ЮMoney отдавала ошибку
 * «Перевести не получится» (transfer/quickpay/error?reason=default) даже после
 * идентификации кошелька. По АКТУАЛЬНОЙ доке (yoomoney.ru/docs/payment-buttons)
 * форма принимает quickpay-form=button и сумму в параметре SUM (не amount!),
 * параметр targets у button-формы не существует. С правильными параметрами
 * форма открывается: показывает сумму тарифа и способы оплаты
 * (SberPay / банковская карта / кошелёк ЮMoney), проверено в браузере.
 *
 * label (до 64 символов — наш ap_... укладывается) передаётся в вебхук,
 * что даёт ТОЧНЫЙ матчинг платежа и пользователя (см. yoomoney-notify).
 * successURL возвращает пользователя на сайт после оплаты — там его подхватит
 * авто-опрос статуса подписки.
 */
function buildYooMoneyUrl(plan: Plan, label: string): string | null {
  const receiver = getReceiverWallet();
  if (!receiver) return null;
  const params = new URLSearchParams({
    receiver,
    'quickpay-form': 'button',
    'paymentType': 'AC',
    sum: String(plan.price),
    label: label.slice(0, 64),
    successURL: 'https://anime-fix.vercel.app/',
  })
  return `https://yoomoney.ru/quickpay/confirm?${params.toString()}`
}

/**
 * Запасная ссылка: персональная страница перевода ЮMoney (yoomoney.ru/to/КОШЕЛЕК).
 *
 * Используется, только если «Перевод по кнопке» (buildYooMoneyUrl) вдруг
 * не открылся. Страница /to/ открывается у всех (проверено из зарубежного IP),
 * НО игнорирует любые query-параметры — сумма НЕ подставляется, пользователь
 * вводит её вручную (в модалке оплаты мы подсказываем нужную сумму).
 * label через неё не передать — матчинг делает вебхук по PENDING-интенту,
 * созданному при subscribe, и уникальной сумме тарифа (см. yoomoney-notify).
 */
function buildTransferUrl(plan: Plan): string | null {
  const receiver = getReceiverWallet();
  if (!receiver) return null;
  // Параметр amount оставляем: не мешает, а на мобильных клиентах ЮMoney
  // иногда подхватывается.
  const params = new URLSearchParams({
    amount: String(plan.price),
  })
  return `https://yoomoney.ru/to/${receiver}?${params.toString()}`
}

// ─── POST /api/subscription ─────────────────────────────────────────────
async function subscriptionHandler(request: NextRequest) {
  const ip = getClientIp(request)
  try {
    const body = await request.json()
    const { action } = body

    // ── REGISTER ──────────────────────────────────────────────────────
    if (action === 'register') {
      const normalizedEmail = sanitizeEmail(body.email)
      // F-09 fix: строгие требования к паролю только на регистрации
      const password = validatePasswordStrict(body.password)
      if (!normalizedEmail || !password) {
        return NextResponse.json({ error: 'Некорректный email или пароль (минимум 8 символов: буквы и цифры)' }, { status: 400 })
      }

      const db = getDb()
      const existing = await getUserByEmail(normalizedEmail)
      if (existing) {
        return NextResponse.json({ error: 'Пользователь уже существует' }, { status: 409 })
      }

      const hashedPw = await hashPassword(password)
      const { data: user, error: uErr } = await db
        .from('users')
        .insert({ email: normalizedEmail, password_hash: hashedPw, role: 'user' })
        .select('id, email, role, created_at')
        .single()

      if (uErr || !user) {
        logEvent('register_failed', { email: maskEmail(normalizedEmail), ip, reason: uErr?.message?.slice(0, 120) || 'insert_error' }, 'warn')
        return NextResponse.json({ error: 'Ошибка регистрации' }, { status: 500 })
      }

      const token = await generateToken()
      const { error: sErr } = await db
        .from('sessions')
        .insert({ user_id: user.id, token })
      if (sErr) {
        return NextResponse.json({ error: 'Ошибка создания сессии' }, { status: 500 })
      }

      const res = NextResponse.json({
        ok: true,
        token,
        user: { email: user.email, role: user.role, createdAt: user.created_at, subscription: null },
      })
      res.cookies.set('anime_platform_token', token, COOKIE_OPTS) // F-07
      logEvent('user_registered', { userId: user.id, email: maskEmail(user.email), ip })
      return res
    }

    // ── LOGIN ─────────────────────────────────────────────────────────
    if (action === 'login') {
      const normalizedEmail = sanitizeEmail(body.email)
      const password = validatePassword(body.password)
      if (!normalizedEmail || !password) {
        return NextResponse.json({ error: 'Некорректный email или пароль' }, { status: 400 })
      }
      const user = await getUserByEmail(normalizedEmail)
      if (!user) {
        logEvent('login_failed', { email: maskEmail(normalizedEmail), ip, reason: 'unknown_email' }, 'warn')
        return NextResponse.json({ error: 'Неверный email или пароль' }, { status: 401 })
      }
      const valid = await verifyPassword(password, user.password_hash)
      if (!valid) {
        logEvent('login_failed', { userId: user.id, email: maskEmail(normalizedEmail), ip, reason: 'bad_password' }, 'warn')
        return NextResponse.json({ error: 'Неверный email или пароль' }, { status: 401 })
      }

      // F-05 fix: прозрачная миграция старых SHA-256 хэшей на scrypt при входе
      if (passwordNeedsRehash(user.password_hash)) {
        const hashedPw = await hashPassword(password)
        const db2 = getDb()
        await db2.from('users').update({ password_hash: hashedPw }).eq('id', user.id)
        console.log(`login: password hash upgraded to scrypt for user ${user.id}`)
      }

      const db = getDb()
      const token = await generateToken()
      const { error: sErr } = await db
        .from('sessions')
        .insert({ user_id: user.id, token })
      if (sErr) {
        return NextResponse.json({ error: 'Ошибка создания сессии' }, { status: 500 })
      }

      // Get subscription
      const { data: sub } = await db
        .from('subscriptions')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle()

      const res = NextResponse.json({
        ok: true,
        token,
        user: {
          email: user.email,
          role: user.role,
          createdAt: user.created_at,
          subscription: sub ? {
            planId: sub.plan_id,
            activatedAt: new Date(sub.activated_at).getTime(),
            expiresAt: new Date(sub.expires_at).getTime(),
            isActive: true,
            remainingDays: Math.max(0, Math.ceil((new Date(sub.expires_at).getTime() - Date.now()) / 86400000)),
          } : null,
        },
      })
      res.cookies.set('anime_platform_token', token, COOKIE_OPTS) // F-07
      // F-13: не более 10 активных сессий на пользователя; раз в ~50 логинов
      // подметаем глобально истёкшие сессии (best-effort, не блокируем ответ)
      void capUserSessions(user.id, 10).catch(() => {})
      if (Math.random() < 0.02) void cleanupExpiredSessions().catch(() => {})
      logEvent('login_ok', { userId: user.id, email: maskEmail(user.email), ip })
      return res
    }

    // ── CHECK ─────────────────────────────────────────────────────────
    if (action === 'check') {
      // F-07 fix: токен берём из cookie; body.token — legacy-мост (миграция localStorage)
      const token = tokenFromBodyOrCookie(request, body)
      if (!token) {
        return NextResponse.json({ ok: false, reason: 'no_token' })
      }
      const user = await getUserByToken(token)
      if (!user) {
        return NextResponse.json({ ok: false, reason: 'invalid_token' })
      }
      // Миграция: легаси-пользователь с токеном из body получает cookie
      const res = NextResponse.json({ ok: true, user })
      res.cookies.set('anime_platform_token', token, COOKIE_OPTS)
      return res
    }

    // ── SUBSCRIBE (only creates payment URL, does NOT grant access) ────
    if (action === 'subscribe') {
      const token = tokenFromBodyOrCookie(request, body)
      const { planId } = body
      if (!token) return NextResponse.json({ error: 'Не авторизован' }, { status: 401 })
      const user = await getUserByToken(token)
      if (!user) return NextResponse.json({ error: 'Сессия истекла' }, { status: 401 })

      const validPlanId = validatePlanId(planId)
      if (!validPlanId) return NextResponse.json({ error: 'Некорректный план' }, { status: 400 })
      const plan = PLANS.find(p => p.id === validPlanId)
      if (!plan) return NextResponse.json({ error: 'План не найден' }, { status: 400 })

      // 64 символа — лимит label в quickpay-форме (актуальная докa).
      // Режем ДО записи в БД, чтобы вебхук сматчил label из уведомления
      // с payment_label в payments 1-в-1 даже при очень длинном email.
      const label = `ap_${plan.id}_${user.email}_${Date.now()}`.slice(0, 64)

      // Основная ссылка — «Перевод по кнопке» (сумма тарифа подставляется,
      // label уходит в вебхук для точного матчинга);
      // запасная — персональная страница /to/ (без автосуммы и label).
      const paymentUrl = buildYooMoneyUrl(plan, label)
      const paymentUrlQuickpay = buildTransferUrl(plan)

      // F-02 fix: раньше при пустом receiver молча генерировалась битая ссылка.
      // Теперь отдаём клиенту явную ошибку и пишем причину в логи Vercel.
      if (!paymentUrl) {
        console.error(
          'subscribe: env YOO_MONEY_RECEIVER (или YOO_MONEY_WALLET) не задан ' +
          'или имеет неверный формат (ожидается номер кошелька ЮMoney: 11-16 цифр). ' +
          'Приём платежей не может быть начат.'
        )
        return NextResponse.json(
          { error: 'Приём платежей временно не работает. Попробуйте позже или сообщите администратору.' },
          { status: 503 }
        )
      }

      // PENDING-интент для вебхука: строка с operation_id='PENDING' = «ждём оплату».
      // Когда придёт уведомление ЮMoney (даже без label — персональная страница
      // его не передаёт), вебхук найдёт этот интент по сумме и активирует подписку.
      const db = getDb()
      const { error: intentErr } = await db.from('payments').insert({
        user_id: user.id,
        amount: plan.price,
        payment_label: label,
        operation_id: 'PENDING',
      })
      if (intentErr) {
        // Не блокируем оплату: без интента просто не сработает amount-матчинг
        // запасной /to/-страницы, но primary-ссылка с label активирует точно.
        console.error('subscribe: failed to create PENDING payment intent', intentErr)
      }

      return NextResponse.json({
        ok: true,
        paymentUrl,
        paymentUrlQuickpay,
        message: 'Оплатите подписку через YooMoney',
      })
    }

    // ── CONFIRM-PAYMENT ────────────────────────────────────────────────
    if (action === 'confirm-payment') {
      const token = tokenFromBodyOrCookie(request, body)
      if (!token) return NextResponse.json({ ok: false, reason: 'no_token' })
      const user = await getUserByToken(token)
      if (!user) return NextResponse.json({ ok: false, reason: 'invalid_token' })

      return NextResponse.json({
        ok: true,
        hasSubscription: !!user.subscription,
        subscription: user.subscription,
      })
    }

    // ── ADMIN-ACTIVATE (ручная активация: перевод мимо вебхука ЮMoney) ──
    if (action === 'admin-activate') {
      const token = tokenFromBodyOrCookie(request, body)
      if (!token) return NextResponse.json({ error: 'Не авторизован' }, { status: 401 })
      const admin = await getUserByToken(token)
      if (!admin || admin.role !== 'admin') {
        logEvent('admin_activate_denied', { ip }, 'warn')
        return NextResponse.json({ error: 'Доступ только для администратора' }, { status: 403 })
      }

      const normalizedEmail = sanitizeEmail(body.email)
      const validPlanId = validatePlanId(body.planId)
      if (!normalizedEmail || !validPlanId) {
        return NextResponse.json({ error: 'Укажите корректный email и тариф' }, { status: 400 })
      }
      const target = await getUserByEmail(normalizedEmail)
      if (!target) {
        return NextResponse.json({ error: 'Пользователь с таким email не найден' }, { status: 404 })
      }

      await activateSubscription(target.id, validPlanId)

      const db = getDb()
      const { data: sub } = await db
        .from('subscriptions')
        .select('*')
        .eq('user_id', target.id)
        .eq('is_active', true)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle()

      logEvent('admin_activated', {
        admin: maskEmail(admin.email),
        target: maskEmail(target.email),
        planId: validPlanId,
        ip,
      })
      return NextResponse.json({
        ok: true,
        message: `Подписка активирована для ${target.email}`,
        subscription: sub ? {
          planId: sub.plan_id,
          expiresAt: new Date(sub.expires_at).getTime(),
          remainingDays: Math.max(0, Math.ceil((new Date(sub.expires_at).getTime() - Date.now()) / 86400000)),
        } : null,
      })
    }

    // ── LOGOUT ─────────────────────────────────────────────────────────
    if (action === 'logout') {
      const token = tokenFromBodyOrCookie(request, body)
      if (token) {
        const db = getDb()
        await db.from('sessions').delete().eq('token', token)
      }
      // F-07 fix: очищаем cookie на выходе
      const res = NextResponse.json({ ok: true })
      res.cookies.set('anime_platform_token', '', { ...COOKIE_OPTS, maxAge: 0 })
      logEvent('logout', { ip })
      return res
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 })
  } catch (e) {
    console.error('Subscription API error:', e)
    return NextResponse.json({ error: 'Ошибка сервера' }, { status: 500 })
  }
}

export const POST = withRateLimit(subscriptionHandler, '/api/subscription')

export async function GET() {
  return NextResponse.json({ plans: PLANS })
}
