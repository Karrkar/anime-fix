/**
 * Тарифы подписки — общий источник истины (патч F-04 из аудита).
 *
 * Раньше PLANS жили внутри src/app/api/subscription/route.ts, из-за чего
 * вебхук yoomoney-notify не мог сверить сумму платежа с ценой тарифа.
 * Теперь и подписка, и вебхук импортируют один и тот же список.
 */

export interface Plan {
  id: string;
  label: string;
  months: number;
  price: number;
  pricePerMonth: number;
  popular?: boolean;
}

export const PLANS: Plan[] = [
  { id: '1m',  label: '1 месяц',  months: 1,  price: 100,  pricePerMonth: 100 },
  { id: '3m',  label: '3 месяца', months: 3,  price: 250,  pricePerMonth: 83, popular: true },
  { id: '6m',  label: '6 месяцев', months: 6,  price: 500,  pricePerMonth: 83 },
  { id: '1y',  label: '1 год',   months: 12, price: 1000, pricePerMonth: 83 },
];

/** Цена тарифа по id (или null, если тариф неизвестен). */
export function getPlanById(planId: string): Plan | null {
  return PLANS.find(p => p.id === planId) || null;
}
