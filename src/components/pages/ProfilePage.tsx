'use client';

import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, X, Sparkles, AlertTriangle, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { Page } from '@/lib/client-types';

export function ProfilePage({ onSubscriptionChange, onNavigate }: { onSubscriptionChange: (active: boolean) => void; onNavigate: (p: Page) => void }) {
  // ── State ──
  const [token, setToken] = useState('');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [subscription, setSubscription] = useState<{ planId: string; expiresAt: number; isActive: boolean; remainingDays: number } | null>(null);
  const [plans, setPlans] = useState<Array<{ id: string; label: string; months: number; price: number; pricePerMonth: number; popular?: boolean }>>([]);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false); // «глазок»: частая причина ошибки входа — не та раскладка
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [showPayment, setShowPayment] = useState<string | null>(null); // planId being paid
  const [paymentDone, setPaymentDone] = useState(false);
  const [payError, setPayError] = useState(''); // F-03 fix: ошибка оплаты возле кнопки
  const [checkingPayment, setCheckingPayment] = useState(false); // F-03 fix: проверка оплаты после возврата
  const [paymentOpened, setPaymentOpened] = useState(false); // оплата открыта в новой вкладке
  const [quickpayUrl, setQuickpayUrl] = useState<string | null>(null); // запасная quickpay-ссылка ЮMoney

  // F-07 fix: сессия живёт в httpOnly cookie. localStorage читается один раз
  // только для миграции: сервер проверит старый токен и выдаст cookie.
  useEffect(() => {
    const savedToken = localStorage.getItem('anime_platform_token');
    // Verify session
    fetch('/api/subscription', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check', ...(savedToken ? { token: savedToken } : {}) }),
    }).then(r => r.json()).then(d => {
      if (d.ok && d.user) {
        setToken('session'); // маркер сессии; реальный токен — в httpOnly cookie
        setUserEmail(d.user.email);
        setRole(d.user.role || '');
        localStorage.removeItem('anime_platform_token'); // миграция завершена
        setSubscription(d.user.subscription ?? null);
        // Фикс: флаг доступа обновляем ВСЕГДА, а не только при наличии подписки.
        // Админ имеет полный бесплатный доступ к 18+ без подписки — раньше
        // свежелогиненный админ упирался в пейволл до перезагрузки страницы.
        onSubscriptionChange(d.user.role === 'admin' || !!d.user.subscription?.isActive);
      } else {
        localStorage.removeItem('anime_platform_token');
        setToken('');
        setRole('');
        onSubscriptionChange(false);
      }
    }).catch(() => {});
    // Load plans
    fetch('/api/subscription').then(r => r.json()).then(d => setPlans(d.plans || [])).catch(() => {});
  }, []);

  const handleAuth = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);
    try {
      const d = await fetch('/api/subscription', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: authMode, email, password }),
      }).then(r => r.json());
      if (d.error) { setAuthError(d.error); }
      else if (d.ok && d.token) {
        // F-07 fix: токен НЕ сохраняем в JS — сервер уже поставил httpOnly cookie.
        // Старый localStorage-токен чистим, если был.
        localStorage.removeItem('anime_platform_token');
        setToken('session');
        setUserEmail(d.user.email);
        setRole(d.user.role || '');
        setSubscription(d.user.subscription ?? null);
        // Фикс: как в check-на-маунте — вызываем всегда; админ без подписки
        // тоже получает полный доступ, иначе видит пейволл 18+ после логина.
        onSubscriptionChange(d.user.role === 'admin' || !!d.user.subscription?.isActive);
      }
    } catch { setAuthError('Ошибка подключения'); }
    setAuthLoading(false);
  }, [authMode, email, password, onSubscriptionChange]);

  const handleSubscribe = useCallback(async (planId: string) => {
    setShowPayment(planId);
    setPaymentDone(false);
    setPayError('');
    setPaymentOpened(false);
    setQuickpayUrl(null);
  }, []);

  const handlePaymentConfirm = useCallback(async () => {
    if (!showPayment || !token) return;
    setSubscribing(true);
    setPayError('');
    try {
      const d = await fetch('/api/subscription', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'subscribe', planId: showPayment }),
      }).then(r => r.json());
      if (d.ok && d.paymentUrl) {
        // Оплата через «Перевод по кнопке» ЮMoney (quickpay с актуальными
        // параметрами quickpay-form=button + sum — сумма тарифа подставляется
        // автоматически) — открываем в НОВОЙ вкладке, пользователь возвращается
        // на сайт и подписка активируется автоматически (авто-опрос + вебхук
        // с точным матчингом по label).
        const win = window.open(d.paymentUrl, '_blank');
        if (win) {
          win.opener = null; // отсекаем window.opener (безопасность)
          setPaymentOpened(true);
          setQuickpayUrl(d.paymentUrlQuickpay || null);
          setSubscribing(false);
          return;
        }
        // Попап заблокирован браузером (или строгий мобильный Safari) —
        // уходим на оплату в этой же вкладке, как раньше.
        window.location.href = d.paymentUrl;
        return;
      }
      setPayError(d.error || 'Не удалось создать платёж. Попробуйте позже.');
    } catch {
      setPayError('Ошибка подключения. Проверьте интернет и попробуйте ещё раз.');
    }
    setSubscribing(false);
  }, [showPayment, token]);

  // Полная автоматизация: после вебхука ЮMoney подписка активируется на бэке,
  // сайт сам до-прашивает статус — молча, без ошибок и без лишних лоадеров.
  const silentRecheck = useCallback(async () => {
    if (!token) return false;
    try {
      const d = await fetch('/api/subscription', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm-payment' }),
      }).then(r => r.json());
      if (d.ok && d.subscription) {
        setSubscription(d.subscription);
        onSubscriptionChange(true);
        setPaymentDone(true); // модалка покажет «Подписка активна!»
        setPaymentOpened(false);
        setPayError('');
        return true;
      }
    } catch {}
    return false;
  }, [token, onSubscriptionChange]);

  // Авто-опрос пока открыта модалка и оплата ушла в ЮMoney: каждые 5 секунд +
  // мгновенно при возврате пользователя на вкладку сайта. Никаких кнопок:
  // заплатил во вкладке ЮMoney → вернулся → «Подписка активна!» уже на экране.
  useEffect(() => {
    if (!paymentOpened || !showPayment) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const ok = await silentRecheck();
      if (ok) stopped = true;
    };
    const iv = setInterval(tick, 5000);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stopped = true; clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, [paymentOpened, showPayment, silentRecheck]);

  // F-03 fix: ручная кнопка остаётся как запасной вариант (нетерпеливый пользователь)
  const recheckSubscription = useCallback(async () => {
    setCheckingPayment(true);
    setPayError('');
    const ok = await silentRecheck();
    if (!ok) {
      setPayError('Оплата пока не найдена. Активация идёт автоматически (обычно 1–2 минуты) — проверка продолжается сама.');
    }
    setCheckingPayment(false);
  }, [silentRecheck]);

  const handleLogout = useCallback(() => {
    // F-07 fix: сервер удаляет сессию и очищает cookie; legacy localStorage чистим сами
    fetch('/api/subscription', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    }).catch(() => {});
    localStorage.removeItem('anime_platform_token');
    setToken('');
    setUserEmail('');
    setRole('');
    setSubscription(null);
    onSubscriptionChange(false);
  }, [onSubscriptionChange]);

  const selectedPlan = plans.find(p => p.id === showPayment);
  const hasActiveSub = subscription && subscription.isActive;

  return (
    <div className="animate-fade-in max-w-lg mx-auto py-4 sm:py-8 px-4">
      {/* ── Not logged in: Auth form ── */}
      {!token ? (
        <div className="max-w-sm mx-auto">
          <div className="text-center mb-6">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-[var(--primary)] to-[var(--accent)] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-[var(--primary)]/20">
              <User className="w-10 h-10 text-white" />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold">Аккаунт</h1>
            <p className="text-sm text-[var(--muted-foreground)] mt-1">Войдите или создайте аккаунт для доступа к контенту 18+</p>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mb-6 bg-[var(--muted)] rounded-xl p-1">
            {(['register', 'login'] as const).map(m => (
              <button
                key={m}
                onClick={() => { setAuthMode(m); setAuthError(''); }}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${authMode === m
                  ? 'bg-[var(--card)] text-[var(--foreground)] shadow-sm'
                  : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'}`}
              >
                {m === 'register' ? 'Регистрация' : 'Вход'}
              </button>
            ))}
          </div>

          <form onSubmit={handleAuth} className="space-y-3">
            <div>
              <label className="text-xs text-[var(--muted-foreground)] mb-1 block">Email</label>
              <input
                type="email" required value={email} onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                // Мобильные клавиатуры: без автозаглавных/автозамен/пробелов —
                // иначе iOS подставляет заглавную первую букву и вход «ломается»
                autoComplete="email" inputMode="email" autoCapitalize="none"
                autoCorrect="off" spellCheck={false}
                className="w-full px-4 py-3 rounded-xl bg-[var(--card)] border border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-[var(--primary)]/50 focus:ring-1 focus:ring-[var(--primary)]/20 transition-all text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-[var(--muted-foreground)] mb-1 block">Пароль</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'} required value={password} onChange={e => setPassword(e.target.value)}
                  placeholder={authMode === 'register' ? 'Минимум 8 символов: буквы и цифры' : ''}
                  minLength={authMode === 'register' ? 8 : 1}
                  autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  className="w-full px-4 py-3 pr-12 rounded-xl bg-[var(--card)] border border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-[var(--primary)]/50 focus:ring-1 focus:ring-[var(--primary)]/20 transition-all text-sm"
                />
                <button
                  type="button" onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? 'Скрыть пароль' : 'Показать пароль'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {authMode === 'login' && (
                <p className="text-[11px] text-[var(--muted-foreground)] mt-1.5">
                  Проверьте раскладку клавиатуры (EN/РУС) — частая причина ошибки входа
                </p>
              )}
            </div>
            {authError && (
              <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />{authError}
              </div>
            )}
            <button
              type="submit" disabled={authLoading}
              className="w-full py-3 rounded-xl font-semibold text-white bg-gradient-to-r from-[var(--primary)] to-[var(--accent)] hover:opacity-90 transition-all shadow-lg shadow-[var(--primary)]/20 disabled:opacity-50 active:scale-[0.98] text-sm"
            >
              {authLoading ? 'Загрузка...' : authMode === 'register' ? 'Создать аккаунт' : 'Войти'}
            </button>
          </form>
        </div>
      ) : (
        /* ── Logged in: Profile + Subscription ── */
        <div>
          {/* Profile header */}
          <div className="flex items-center gap-4 mb-6">
            <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-gradient-to-br from-[var(--primary)] to-[var(--accent)] flex items-center justify-center shadow-lg shadow-[var(--primary)]/20 flex-shrink-0">
              <span className="text-xl sm:text-2xl font-bold text-white">{userEmail[0]?.toUpperCase() || '?'}</span>
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-lg sm:text-xl font-bold truncate">{userEmail}</h1>
              {hasActiveSub ? (
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="flex items-center gap-1 text-xs font-medium text-emerald-400 bg-emerald-500/15 px-2 py-0.5 rounded-full">
                    <Sparkles className="w-3 h-3" />Подписка активна
                  </span>
                  <span className="text-xs text-[var(--muted-foreground)]">{subscription!.remainingDays} дн.</span>
                </div>
              ) : role === 'admin' ? (
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="flex items-center gap-1 text-xs font-medium text-amber-400 bg-amber-500/15 px-2 py-0.5 rounded-full">
                    <Sparkles className="w-3 h-3" />Админ — полный доступ
                  </span>
                </div>
              ) : (
                <p className="text-sm text-[var(--muted-foreground)] mt-1">Нет активной подписки</p>
              )}
            </div>
            <button
              onClick={handleLogout}
              className="p-2 rounded-lg border border-[var(--border)] text-[var(--muted-foreground)] hover:text-red-400 hover:border-red-500/30 transition-colors"
              title="Выйти"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Subscription status card */}
          {hasActiveSub && subscription && (
            <div className="bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border border-emerald-500/20 rounded-xl p-4 mb-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-emerald-400">Текущая подписка</span>
                <span className="text-xs text-[var(--muted-foreground)]">до {new Date(subscription.expiresAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
              </div>
              <div className="w-full bg-[var(--muted)] rounded-full h-2 mb-1">
                <div className="bg-gradient-to-r from-emerald-500 to-teal-400 h-2 rounded-full transition-all" style={{ width: `${Math.min(100, (subscription.remainingDays / (plans.find(p => p.id === subscription.planId)?.months || 1) / 30) * 100)}%` }} />
              </div>
              <p className="text-xs text-[var(--muted-foreground)]">Осталось {subscription.remainingDays} дней</p>
            </div>
          )}

          {/* Plans */}
          <div className="mb-4">
            <h2 className="text-base sm:text-lg font-bold mb-1">
              {hasActiveSub ? 'Продлить подписку' : role === 'admin' ? 'Подписка' : 'Доступ к контенту 18+'}
            </h2>
            <p className="text-xs sm:text-sm text-[var(--muted-foreground)] mb-4">
              {role === 'admin' ? 'Как администратору вам доступен весь 18+ контент бесплатно — оформление подписки не требуется.' : 'Получите доступ ко всей коллекции артов и видео'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {plans.map(plan => (
              <motion.div
                key={plan.id}
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.98 }}
                className={`relative rounded-xl border p-4 cursor-pointer transition-all ${plan.popular
                  ? 'border-[var(--primary)]/50 bg-[var(--primary)]/5'
                  : 'border-[var(--border)] bg-[var(--card)] hover:border-[var(--primary)]/30'}`}
                onClick={() => handleSubscribe(plan.id)}
              >
                {plan.popular && (
                  <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-gradient-to-r from-[var(--primary)] to-[var(--accent)] text-white shadow-lg shadow-[var(--primary)]/30">
                    Популярный
                  </span>
                )}
                <div className="text-center">
                  <p className="text-sm font-semibold mb-1">{plan.label}</p>
                  <p className="text-2xl sm:text-3xl font-extrabold">{plan.price}<span className="text-sm font-normal text-[var(--muted-foreground)]"> ₽</span></p>
                  {plan.pricePerMonth < plan.price && (
                    <p className="text-[10px] text-[var(--muted-foreground)] mt-1">{plan.pricePerMonth} ₽/мес</p>
                  )}
                  <div className="mt-3 py-1.5 rounded-lg bg-[var(--primary)]/15 text-[var(--primary)] text-xs font-medium">
                    Выбрать
                  </div>
                </div>
              </motion.div>
            ))}
          </div>

          {/* Info text */}
          <p className="text-[10px] text-[var(--muted-foreground)] text-center mt-4 leading-relaxed">
            Оплата происходит на защищённой странице ЮMoney (в новой вкладке).
            Подписка не продлевается автоматически — для продления оплатите тариф повторно.
          </p>

          {/* F-03 fix: проверка оплаты после возврата с ЮMoney */}
          {payError && (
            <p className="text-xs text-red-400 text-center mt-3 px-2">{payError}</p>
          )}
          <button
            onClick={recheckSubscription}
            disabled={checkingPayment}
            className="w-full py-2.5 mt-3 rounded-xl text-sm border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:border-[var(--primary)]/40 transition-all disabled:opacity-50"
          >
            {checkingPayment ? 'Проверяем оплату...' : 'Я оплатил — проверить подписку'}
          </button>

          {/* Админ-доступ: статус синхронизаций парсеров */}
          {role === 'admin' && (
            <button
              onClick={() => onNavigate('admin')}
              className="w-full py-2.5 mt-3 rounded-xl text-sm border border-[var(--primary)]/30 bg-[var(--primary)]/5 text-[var(--primary)] hover:bg-[var(--primary)]/10 transition-all flex items-center justify-center gap-2"
            >
              <RefreshCw className="w-4 h-4" /> Статус синхронизаций (админ)
            </button>
          )}
        </div>
      )}

      {/* ── Payment Modal ── */}
      <AnimatePresence>
        {showPayment && selectedPlan && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => !subscribing && !paymentDone && setShowPayment(null)}
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
              className="bg-[var(--card)] border border-[var(--border)] rounded-2xl p-6 sm:p-8 max-w-sm w-full"
              onClick={e => e.stopPropagation()}
            >
              {paymentDone ? (
                <div className="text-center py-4">
                  <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto mb-4">
                    <Sparkles className="w-8 h-8 text-emerald-400" />
                  </div>
                  <h3 className="text-lg font-bold mb-2">Подписка активна!</h3>
                  <p className="text-sm text-[var(--muted-foreground)]">Доступ к контенту 18+ открыт</p>
                </div>
              ) : (
                <>
                  <h3 className="text-lg font-bold mb-1">Оформление подписки</h3>
                  <p className="text-sm text-[var(--muted-foreground)] mb-6">{selectedPlan.label} — {selectedPlan.price} ₽</p>

                  {/* F-03 fix: фиктивная «карта VISA» убрана — оплата проходит на стороне ЮMoney */}
                  <div className="space-y-3 mb-6">
                    <div className="bg-[var(--muted)] rounded-xl p-4 space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-[var(--muted-foreground)]">К оплате</span>
                        <span className="text-xl font-bold">{selectedPlan.price} ₽</span>
                      </div>
                      <p className="text-xs text-[var(--muted-foreground)] leading-relaxed">
                        Откроется страница ЮMoney с суммой {selectedPlan.price} ₽ —
                        способы оплаты: SberPay, банковская карта, кошелёк ЮMoney.
                        Реквизиты вводятся только на стороне ЮMoney. Просто оплатите
                        и вернитесь на сайт — подписка активируется сама (обычно 1–2 минуты),
                        ничего нажимать не нужно.
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={paymentOpened ? recheckSubscription : handlePaymentConfirm}
                    disabled={subscribing || checkingPayment}
                    className="w-full py-3.5 rounded-xl font-semibold text-white bg-gradient-to-r from-[var(--primary)] to-[var(--accent)] hover:opacity-90 transition-all shadow-lg shadow-[var(--primary)]/20 disabled:opacity-50 active:scale-[0.98] text-sm"
                  >
                    {paymentOpened
                      ? (checkingPayment ? 'Проверяем оплату...' : 'Проверить оплату')
                      : (subscribing ? 'Перенаправляем на ЮMoney...' : `Оплатить ${selectedPlan.price} ₽`)}
                  </button>
                  {paymentOpened && (
                    <>
                      <p className="flex items-center justify-center gap-1.5 text-xs text-emerald-400 mt-3">
                        <RefreshCw className="w-3 h-3 animate-spin" />
                        Ждём оплату — подписка активируется автоматически
                      </p>
                      <button
                        onClick={handlePaymentConfirm}
                        disabled={subscribing}
                        className="w-full py-2.5 mt-2 rounded-xl text-sm border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:border-[var(--primary)]/40 transition-all disabled:opacity-50"
                      >
                        {subscribing ? 'Открываем...' : 'Открыть оплату ещё раз'}
                      </button>
                      {quickpayUrl && (
                        <p className="text-center text-[11px] text-[var(--muted-foreground)] mt-2">
                          Страница оплаты не открывается?{' '}
                          <a
                            href={quickpayUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:text-[var(--foreground)]"
                          >
                            Запасная страница перевода
                          </a>{' '}
                          — на ней введите сумму {selectedPlan.price} ₽ вручную
                        </p>
                      )}
                    </>
                  )}
                  <details className="mt-3">
                    <summary className="text-xs text-[var(--muted-foreground)] cursor-pointer hover:text-[var(--foreground)] select-none">
                      Оплата не проходит?
                    </summary>
                    <p className="mt-2 text-[11px] text-[var(--muted-foreground)] leading-relaxed">
                      Переведите сумму тарифа вручную на кошелёк ЮMoney{' '}
                      <span className="font-semibold text-[var(--foreground)]">4100118182998706</span>,
                      в комментарии укажите свой email — администратор активирует подписку вручную
                      (обычно в течение часа).
                    </p>
                  </details>
                  {payError && (
                    <p className="text-xs text-red-400 mt-2 text-center">{payError}</p>
                  )}
                  <button
                    onClick={() => { setShowPayment(null); setPayError(''); }}
                    disabled={subscribing}
                    className="w-full py-2.5 mt-2 rounded-xl text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors disabled:opacity-50"
                  >
                    Отмена
                  </button>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ──────────────────── 18+ Age Gate + Subscription ──────────────────── */
