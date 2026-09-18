/**
 * Тесты тарифов (src/lib/plans.ts) — единый источник истины для
 * подписки и вебхука ЮMoney (патчи F-02/F-04). Запуск: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PLANS, getPlanById } from '../src/lib/plans';

test('PLANS: непустой список тарифов с корректной структурой', () => {
  assert.ok(PLANS.length >= 3);
  for (const p of PLANS) {
    assert.ok(p.id.length > 0, 'id обязателен');
    assert.ok(p.label.length > 0, 'label обязателен');
    assert.ok(p.months >= 1, 'months >= 1');
    assert.ok(p.price > 0, 'price > 0');
    assert.ok(p.pricePerMonth > 0, 'pricePerMonth > 0');
  }
});

test('PLANS: идентификаторы уникальны', () => {
  const ids = PLANS.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('getPlanById: находит существующий тариф', () => {
  const plan = getPlanById('3m');
  assert.ok(plan);
  assert.equal(plan!.months, 3);
  assert.equal(plan!.price, 250);
});

test('getPlanById: неизвестный id -> null', () => {
  assert.equal(getPlanById('forever'), null);
  assert.equal(getPlanById(''), null);
});

test('цена за месяц длинных тарифов не выше месячного', () => {
  const monthly = getPlanById('1m')!;
  for (const p of PLANS) {
    assert.ok(
      p.pricePerMonth <= monthly.pricePerMonth,
      `${p.id}: pricePerMonth=${p.pricePerMonth} должен быть <= ${monthly.pricePerMonth}`
    );
  }
});
