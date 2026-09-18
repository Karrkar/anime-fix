/**
 * Тесты модуля валидации (src/lib/validate.ts) — часть F-30.
 * Запуск: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeString,
  sanitizeEmail,
  sanitizeSearchQuery,
  validatePassword,
  validatePasswordStrict,
  validateAnimeId,
  validatePlanId,
  validateEpisodeNumber,
  isPrivateIp,
  validateExternalUrl,
  isAgeVerifiedFromRequest,
} from '../src/lib/validate';

// ─── Парольная политика (F-09) ───────────────────────────────────────────

test('validatePasswordStrict: отвергает короткий пароль "123"', () => {
  assert.equal(validatePasswordStrict('123'), null);
});

test('validatePasswordStrict: отвергает 8 символов без цифр', () => {
  assert.equal(validatePasswordStrict('abcdefgh'), null);
});

test('validatePasswordStrict: отвергает 8 цифр без букв', () => {
  assert.equal(validatePasswordStrict('12345678'), null);
});

test('validatePasswordStrict: принимает буквы+цифры от 8 символов', () => {
  assert.equal(validatePasswordStrict('anime2026'), 'anime2026');
});

test('validatePasswordStrict: не-строка -> null', () => {
  assert.equal(validatePasswordStrict(12345678 as unknown), null);
});

test('validatePassword (логин): мягкая политика допускает короткий пароль', () => {
  assert.equal(validatePassword('123'), '123');
});

// ─── Санитайзеры ─────────────────────────────────────────────────────────

test('sanitizeString вырезает HTML-теги', () => {
  assert.equal(sanitizeString('<script>alert(1)</script>hi'), 'alert(1)hi');
});

test('sanitizeEmail приводит к нижнему регистру и валидирует', () => {
  assert.equal(sanitizeEmail('  User@Example.COM '), 'user@example.com');
  assert.equal(sanitizeEmail('not-an-email'), null);
});

test('sanitizeSearchQuery вырезает спецсимволы и ограничивает длину', () => {
  const out = sanitizeSearchQuery('<naruto>{*}   ');
  assert.equal(out, 'naruto');
  assert.ok(sanitizeSearchQuery('a'.repeat(500)).length <= 200);
});

test('validateAnimeId: алфавитно-цифровой id проходит, мусор — нет', () => {
  assert.equal(validateAnimeId('anime-123_abc'), 'anime-123_abc');
  assert.equal(validateAnimeId('../etc/passwd'), null);
  assert.equal(validateAnimeId('bad id!'), null);
});

test('validatePlanId: только известные тарифы', () => {
  assert.equal(validatePlanId('3m'), '3m');
  assert.equal(validatePlanId('forever'), null);
});

test('validateEpisodeNumber: целые 1..9999', () => {
  assert.equal(validateEpisodeNumber('12'), 12);
  assert.equal(validateEpisodeNumber(0), null);
  assert.equal(validateEpisodeNumber(99999), null);
});

// ─── SSRF-блоклист (F-14) ────────────────────────────────────────────────

test('isPrivateIp: блокирует RFC1918, loopback, CGNAT, link-local', () => {
  assert.equal(isPrivateIp('10.1.2.3'), true);
  assert.equal(isPrivateIp('172.16.0.1'), true);
  assert.equal(isPrivateIp('172.31.255.255'), true);
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('100.64.0.1'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true); // metadata AWS
  assert.equal(isPrivateIp('0.0.0.0'), true);
});

test('isPrivateIp: пропускает публичные адреса', () => {
  assert.equal(isPrivateIp('172.32.0.1'), false);   // сразу за границей 172.16/12
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('1.1.1.1'), false);
});

test('isPrivateIp: IPv6 loopback, ULA, mapped-IPv4', () => {
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('fd00::1'), true);
  assert.equal(isPrivateIp('fe80::1'), true);
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIp('::ffff:8.8.8.8'), false);
});

test('validateExternalUrl: отвергает localhost и приватные литералы', () => {
  assert.equal(validateExternalUrl('http://localhost:3000/x'), null);
  assert.equal(validateExternalUrl('http://10.0.0.5/admin'), null);
  assert.equal(validateExternalUrl('http://169.254.169.254/latest/meta-data/'), null);
  assert.equal(validateExternalUrl('http://2130706433/'), null); // 127.0.0.1 в десятичной записи
  assert.equal(validateExternalUrl('file:///etc/passwd'), null);
  assert.equal(validateExternalUrl('not a url'), null);
});

test('validateExternalUrl: пропускает публичный https', () => {
  const out = validateExternalUrl('https://v13.vost.pw/page');
  assert.ok(out && out.startsWith('https://v13.vost.pw'));
});

// ─── Возрастной гейт (F-15) ──────────────────────────────────────────────

test('isAgeVerifiedFromRequest: cookie anime_age_confirmed=1 проходит', () => {
  const req = new Request('https://site.test/api/hentai', {
    headers: { cookie: 'other=1; anime_age_confirmed=1; session=x' },
  });
  assert.equal(isAgeVerifiedFromRequest(req), true);
});

test('isAgeVerifiedFromRequest: без cookie / с чужими cookie — отказ', () => {
  const noCookie = new Request('https://site.test/api/hentai');
  const wrong = new Request('https://site.test/api/hentai', {
    headers: { cookie: 'anime_age_confirmed=0' },
  });
  assert.equal(isAgeVerifiedFromRequest(noCookie), false);
  assert.equal(isAgeVerifiedFromRequest(wrong), false);
});
