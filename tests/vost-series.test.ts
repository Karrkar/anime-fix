/**
 * Тесты списка серий через API animevost (src/lib/vost-series.ts, фикс 26.09.2026).
 * Запуск: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractVostId, parseApiSeries } from '../src/lib/vost-series';

/* ── extractVostId ── */

test('extractVostId: canonical page URL', () => {
  assert.equal(extractVostId('https://v13.vost.pw/tip/tv/4020-hyouken-no-majutsushi-ga-sekai-wo-suberu-ii.html'), '4020');
});

test('extractVostId: короткий slug без дефиса', () => {
  assert.equal(extractVostId('https://v13.vost.pw/tip/tv/179'), '179');
});

test('extractVostId: исторические хосты', () => {
  assert.equal(extractVostId('https://vost.pw/tip/tv/3071-xian-ni.html'), '3071');
  assert.equal(extractVostId('https://13.vost.pw/tip/tv/12-name.html'), '12');
});

test('extractVostId: не-страница тайтла → null', () => {
  assert.equal(extractVostId('https://v13.vost.pw/tip/movie/4020.html'), null);
  assert.equal(extractVostId('https://v13.vost.pw/frame5.php?play=4020'), null);
  assert.equal(extractVostId('https://v13.vost.pw/watch/123'), null);
  assert.equal(extractVostId(''), null);
});

test('extractVostId: id не может начаться с 0-повтора (граница 7 цифр)', () => {
  assert.equal(extractVostId('https://v13.vost.pw/tip/tv/123456789-name.html'), null); // 9 цифр — слишком длинный
});

/* ── parseApiSeries ── */

test('parseApiSeries: питонья строка-словарь из API', () => {
  const raw = "{'1 серия':'791642107','2 серия':'374816613','3 серия':'1091448759'}";
  assert.deepEqual(parseApiSeries(raw), [
    ['1 серия', '791642107'],
    ['2 серия', '374816613'],
    ['3 серия', '1091448759'],
  ]);
});

test('parseApiSeries: ключи с пробелами вокруг двоеточия', () => {
  const raw = "{'1 серия' : '111', 'Финал':'222'}";
  assert.deepEqual(parseApiSeries(raw), [
    ['1 серия', '111'],
    ['Финал', '222'],
  ]);
});

test('parseApiSeries: пустая строка → null (анонс)', () => {
  assert.equal(parseApiSeries(''), null);
  assert.equal(parseApiSeries('   '), null);
});

test('parseApiSeries: не-строка → null', () => {
  assert.equal(parseApiSeries(null), null);
  assert.equal(parseApiSeries(undefined), null);
  assert.equal(parseApiSeries({ '1': '2' }), null);
  assert.equal(parseApiSeries(['a']), null);
});

test('parseApiSeries: словарь без пар → null', () => {
  assert.equal(parseApiSeries('{}'), null);
});

test('parseApiSeries: JSON-формат с двойными кавычками → null (API отдаёт одинарные)', () => {
  // Если источник когда-нибудь отдаст честный JSON — это другая ветка;
  // текущий парсер должен честно вернуть null, а не полуразобранный мусор.
  assert.equal(parseApiSeries('{"1 серия":"123"}'), null);
});

test('parseApiSeries: большая строка не рвётся (1000 серий)', () => {
  const parts: string[] = [];
  for (let i = 1; i <= 1000; i++) parts.push(`'${i} серия':'${1000000 + i}'`);
  const raw = `{${parts.join(',')}}`;
  const out = parseApiSeries(raw);
  assert.ok(out);
  assert.equal(out.length, 1000);
  assert.deepEqual(out[999], ['1000 серия', '1001000']);
});
