/**
 * YooMoney: платёжные ссылки (общий модуль).
 *
 * Исторически билдеры жили внутри /api/subscription — теперь их использует
 * и /api/balance (пополнение AP-баланса), поэтому вынесены сюда 1:1.
 *
 * F-02 fix сохранён: читаем YOO_MONEY_RECEIVER (приоритет) и YOO_MONEY_WALLET,
 * формат кошелька — 11–16 цифр (обычно 41001…).
 */

/** Номер кошелька ЮMoney из env ('' если не задан/битый формат). */
export function getReceiverWallet(): string {
  const raw = process.env.YOO_MONEY_RECEIVER || process.env.YOO_MONEY_WALLET || '';
  const receiver = raw.trim();
  if (!/^\d{11,16}$/.test(receiver)) return '';
  return receiver;
}

/** Домен запроса для successURL (возврат после оплаты на тот же домен). */
export function getSuccessUrl(hostHeader: string | null, protoHeader: string | null): string {
  const host = hostHeader || 'animeplatforma-new.online';
  const proto = protoHeader || 'https';
  return `${proto}://${host}/`;
}

/**
 * «Перевод по кнопке» (quickpay) — ОСНОВНАЯ платёжная ссылка.
 *
 * По АКТУАЛЬНОЙ доке (yoomoney.ru/docs/payment-buttons) форма принимает
 * quickpay-form=button и сумму в параметре SUM. label (≤64 симв.) уходит в
 * вебхук → точный матчинг платежа и пользователя (см. yoomoney-notify).
 */
export function buildYooMoneyUrl(amountRub: number, label: string, successUrl: string): string | null {
  const receiver = getReceiverWallet();
  if (!receiver) return null;
  const params = new URLSearchParams({
    receiver,
    'quickpay-form': 'button',
    'paymentType': 'AC',
    sum: String(amountRub),
    label: label.slice(0, 64),
    successURL: successUrl,
  });
  return `https://yoomoney.ru/quickpay/confirm?${params.toString()}`;
}

/**
 * Запасная ссылка: персональная страница перевода (yoomoney.ru/to/КОШЕЛЕК).
 * Игнорирует query-параметры (сумма вручную); label не передаётся — матчинг
 * вебхука идёт по PENDING-интенту и сумме.
 */
export function buildTransferUrl(amountRub: number): string | null {
  const receiver = getReceiverWallet();
  if (!receiver) return null;
  const params = new URLSearchParams({
    amount: String(amountRub),
  });
  return `https://yoomoney.ru/to/${receiver}?${params.toString()}`;
}
