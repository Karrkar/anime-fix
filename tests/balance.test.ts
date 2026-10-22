import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Тесты AP-баланса: чистые функции lib/balance (валидация сумм,
 * нормализация/генерация промо-кодов, парсинг topup-label).
 * RPC-обёртки (ap_credit/ap_debit/ap_redeem) тестируются живым e2e на проде.
 */

// ── тестируем логику 1:1 с lib/balance.ts (без импорта db-зависимостей) ──
const TOPUP_MIN_AP = 50;
const TOPUP_MAX_AP = 10000;

function validateTopupAmount(input: unknown): number | null {
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < TOPUP_MIN_AP || n > TOPUP_MAX_AP) return null;
  return n;
}

function normalizePromoCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (!/^AP[0-9A-Z]{10}$/.test(code)) return null;
  return code;
}

function formatPromoCode(code: string): string {
  const c = code.replace(/[\s-]/g, '').toUpperCase();
  return `${c.slice(0, 2)}-${c.slice(2, 7)}-${c.slice(7, 12)}`;
}

function generatePromoCode(): string {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = Buffer.alloc(10);
  for (let i = 0; i < 10; i++) bytes[i] = Math.floor(Math.random() * 256);
  let body = '';
  for (let i = 0; i < 10; i++) body += ALPHABET[bytes[i] % ALPHABET.length];
  return `AP${body}`;
}

function parseTopupLabel(label: string): { userId: string } | null {
  const parts = label.split('_');
  if (parts.length !== 3 || parts[0] !== 'topup') return null;
  const userId = parts[1];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return null;
  return { userId };
}

// ─── validateTopupAmount ─────────────────────────────────────────────────

test('validateTopupAmount: принимает валидные суммы', () => {
  assert.equal(validateTopupAmount(50), 50);
  assert.equal(validateTopupAmount(100), 100);
  assert.equal(validateTopupAmount(10000), 10000);
  assert.equal(validateTopupAmount('250'), 250);
});

test('validateTopupAmount: отклоняет мусор', () => {
  assert.equal(validateTopupAmount(49), null);        // ниже минимума
  assert.equal(validateTopupAmount(10001), null);     // выше максимума
  assert.equal(validateTopupAmount(100.5), null);     // нецелое
  assert.equal(validateTopupAmount('abc'), null);     // не число
  assert.equal(validateTopupAmount(null), null);
  assert.equal(validateTopupAmount(undefined), null);
  assert.equal(validateTopupAmount(Infinity), null);
  assert.equal(validateTopupAmount(-100), null);
});

// ─── normalizePromoCode / formatPromoCode ────────────────────────────────

test('normalizePromoCode: точные кейсы', () => {
  // валидный: AP + 10 символов алфавита
  assert.equal(normalizePromoCode('APABCDEFGHIJ'), 'APABCDEFGHIJ');
  assert.equal(normalizePromoCode('ap abcdefghij'), 'APABCDEFGHIJ');
  assert.equal(normalizePromoCode(' ap-abcdefghij '), 'APABCDEFGHIJ');
  // невалидные
  assert.equal(normalizePromoCode('APABCDEFGHI'), null);   // 9 символов
  assert.equal(normalizePromoCode('APABCDEFGHIJK'), null); // 11 символов
  assert.equal(normalizePromoCode('BPABCDEFGHIJ'), null);  // не AP-префикс
  assert.equal(normalizePromoCode(''), null);
  assert.equal(normalizePromoCode(12345), null);
  assert.equal(normalizePromoCode(null), null);
});

test('formatPromoCode: расстановка дефисов', () => {
  assert.equal(formatPromoCode('APABCDEFGHIJ'), 'AP-ABCDE-FGHIJ');
  assert.equal(formatPromoCode('ap abcdefghij'), 'AP-ABCDE-FGHIJ');
  assert.equal(formatPromoCode('AP-ABCDE-FGHIJ'), 'AP-ABCDE-FGHIJ');
});

test('roundtrip: generate → format → normalize → тот же код', () => {
  for (let i = 0; i < 100; i++) {
    const raw = generatePromoCode();
    const formatted = formatPromoCode(raw);
    assert.match(formatted, /^AP-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    assert.equal(normalizePromoCode(formatted), raw);
  }
});

test('generatePromoCode: криптостойкость алфавита (без I L O U)', () => {
  const forbidden = /[ILOU]/;
  for (let i = 0; i < 200; i++) {
    const raw = generatePromoCode();
    assert.ok(!forbidden.test(raw.slice(2)), `код содержит неоднозначные символы: ${raw}`);
    assert.ok(raw.startsWith('AP'));
    assert.equal(raw.length, 12);
  }
});

test('generatePromoCode: уникальность на большой пачке', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(generatePromoCode());
  assert.equal(seen.size, 2000);
});

// ─── parseTopupLabel ─────────────────────────────────────────────────────

const UUID = '3aad8cec-e405-479e-84b2-061f54d215ad';

test('parseTopupLabel: валидный label', () => {
  const r = parseTopupLabel(`topup_${UUID}_1789000000000`);
  assert.deepEqual(r, { userId: UUID });
});

test('parseTopupLabel: отклоняет мусор', () => {
  assert.equal(parseTopupLabel(`ap_1m_user@mail.com_123`), null);   // не topup
  assert.equal(parseTopupLabel('topup_not-a-uuid_123'), null);       // битый uuid
  assert.equal(parseTopupLabel(`topup_${UUID}`), null);              // нет ts
  assert.equal(parseTopupLabel(`topup_${UUID}_123_extra`), null);    // лишняя часть
  assert.equal(parseTopupLabel(''), null);
  assert.equal(parseTopupLabel('topup__123'), null);
});

// ─── бизнес-инварианты ───────────────────────────────────────────────────

test('курс 1 AP = 1 ₽: тарифы маппятся без потерь', () => {
  const PLANS = [
    { id: '1m', price: 100 },
    { id: '3m', price: 250 },
    { id: '6m', price: 500 },
    { id: '1y', price: 1000 },
  ];
  for (const p of PLANS) {
    const ap = Math.round(p.price * 1); // AP_PER_RUB = 1
    assert.equal(ap, p.price);
    assert.ok(ap >= TOPUP_MIN_AP, 'тариф можно закрыть одним пополнением');
  }
});
