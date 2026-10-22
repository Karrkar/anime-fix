/**
 * Тесты фикса главного бага IP (октябрь 2026): rate limiter писал в БД
 * адреса edge-нод Cloudflare (172.71.x, 104.23.x, 162.158.x) вместо
 * реальных посетителей, потому что getClientIp доверял заголовкам,
 * которые за CF-прокси содержат адрес прокси. Теперь приоритет у
 * CF-Connecting-IP (Cloudflare перезаписывает его значением клиента).
 * Запуск: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getClientIp, normalizeIpCandidate } from '../src/lib/rate-limit';

function req(headers: Record<string, string>): Request {
  return new Request('https://animeplatforma-new.online/api/test', { headers });
}

// ─── normalizeIpCandidate ─────────────────────────────────────────────

test('normalizeIpCandidate: валидный IPv4 проходит', () => {
  assert.equal(normalizeIpCandidate('95.161.72.14'), '95.161.72.14');
});

test('normalizeIpCandidate: IPv4 с портом очищается', () => {
  assert.equal(normalizeIpCandidate('203.0.113.7:54321'), '203.0.113.7');
});

test('normalizeIpCandidate: IPv6 в скобках с портом очищается', () => {
  assert.equal(normalizeIpCandidate('[2001:db8::1]:443'), '2001:db8::1');
});

test('normalizeIpCandidate: IPv6 lowercased', () => {
  assert.equal(normalizeIpCandidate('2001:DB8::ABCD'), '2001:db8::abcd');
});

test('normalizeIpCandidate: мусор отбрасывается (null)', () => {
  assert.equal(normalizeIpCandidate('not-an-ip'), null);
  assert.equal(normalizeIpCandidate('<script>'), null);
  assert.equal(normalizeIpCandidate(''), null);
  assert.equal(normalizeIpCandidate(null), null);
  assert.equal(normalizeIpCandidate('999.999.999.999'), null);
});

test('normalizeIpCandidate: список через запятую — берётся первое', () => {
  assert.equal(normalizeIpCandidate('95.161.72.14, 172.71.95.90'), '95.161.72.14');
});

// ─── getClientIp: приоритет заголовков ─────────────────────────────────

test(' getClientIp: CF-Connecting-IP побеждает все остальные', () => {
  const r = req({
    'cf-connecting-ip': '95.161.72.14',
    'x-real-ip': '172.71.95.90',
    'x-forwarded-for': '104.23.166.159, 10.0.0.1',
  });
  assert.equal(getClientIp(r), '95.161.72.14');
});

test('getClientIp: без CF — x-real-ip (старое поведение сохранено)', () => {
  const r = req({
    'x-real-ip': '95.161.72.14',
    'x-forwarded-for': '172.70.240.177',
  });
  assert.equal(getClientIp(r), '95.161.72.14');
});

test('getClientIp: только x-forwarded-for — первая запись', () => {
  const r = req({ 'x-forwarded-for': '95.161.72.14, 172.71.95.90' });
  assert.equal(getClientIp(r), '95.161.72.14');
});

test('getClientIp: порт из XFF снимается', () => {
  const r = req({ 'x-forwarded-for': '203.0.113.7:54321' });
  assert.equal(getClientIp(r), '203.0.113.7');
});

test('getClientIp: спуфнутый мусорный CF-Connecting-IP игнорируется, берётся следующий валидный', () => {
  const r = req({
    'cf-connecting-ip': 'evil-injected-garbage',
    'x-real-ip': '95.161.72.14',
  });
  assert.equal(getClientIp(r), '95.161.72.14');
});

test('getClientIp: CF-заголовок с портом нормализуется', () => {
  const r = req({ 'cf-connecting-ip': '[2a02:6b8:c0xx:1:1::1]:41234' });
  // невалидный hex (c0xx) -> пропущен; ничего больше -> anon-*
  assert.ok(getClientIp(r).startsWith('anon-'));
});

test('getClientIp: валидный IPv6 из CF-заголовка принимается', () => {
  const r = req({ 'cf-connecting-ip': '2a02:6b8::1' });
  assert.equal(getClientIp(r), '2a02:6b8::1');
});

test('getClientIp: без адресов — корзина из user-agent', () => {
  const a = getClientIp(req({ 'user-agent': 'Mozilla/5.0 (Windows)' }));
  const b = getClientIp(req({ 'user-agent': 'Mozilla/5.0 (Android)' }));
  assert.ok(a.startsWith('anon-'));
  assert.notEqual(a, b);
});

test('getClientIp: сценарий прод-бага — только edge-IP Cloudflare в XFF, CF-заголовка нет', () => {
  // Так выглядел каждый запрос до фикса: всё в одну корзину CF-IP
  const r = req({ 'x-forwarded-for': '172.70.240.177' });
  assert.equal(getClientIp(r), '172.70.240.177');
});
