/**
 * Тесты нормализации домена vost (v13 ← 301 ← v14, октябрь 2026)
 * и построения URL самоцепочки. Запуск: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeVostDomain, VOST_BASE, PLAYER_PROXY_ALLOWED_HOSTS } from '../src/lib/sources';
import { buildChainUrl, fetchTimeBudget } from '../src/lib/sync-chain';

// ─── normalizeVostDomain ───────────────────────────────────────────────

test('normalizeVostDomain: v14 приводится к v13', () => {
  assert.equal(
    normalizeVostDomain('https://v14.vost.pw/tip/tv/3189-hui-ming.html'),
    `${VOST_BASE}/tip/tv/3189-hui-ming.html`,
  );
});

test('normalizeVostDomain: голый vost.pw тоже к v13', () => {
  assert.equal(
    normalizeVostDomain('https://vost.pw/tip/tv/2920-maou.html'),
    `${VOST_BASE}/tip/tv/2920-maou.html`,
  );
});

test('normalizeVostDomain: v13 остаётся как есть', () => {
  const url = `${VOST_BASE}/tip/tv/3634-sanda.html`;
  assert.equal(normalizeVostDomain(url), url);
});

test('normalizeVostDomain: чужие домены не трогаются', () => {
  assert.equal(normalizeVostDomain('https://hentaibaza.com/watch/123'), 'https://hentaibaza.com/watch/123');
});

test('sources: v14 в белом списке player-proxy (плеер не сломается на новых ссылках)', () => {
  assert.ok(PLAYER_PROXY_ALLOWED_HOSTS.includes('v14.vost.pw'));
  assert.ok(PLAYER_PROXY_ALLOWED_HOSTS.includes('v13.vost.pw'));
});

// ─── buildChainUrl ─────────────────────────────────────────────────────

test('buildChainUrl: собирает абсолютный URL с параметрами', () => {
  const url = buildChainUrl('/api/sync-anime', { backfill: 1, from_page: 12, hop: 2 });
  assert.ok(url.startsWith('https://'));
  assert.ok(url.includes('/api/sync-anime?'));
  assert.ok(url.includes('from_page=12'));
  assert.ok(url.includes('hop=2'));
  assert.ok(url.includes('backfill=1'));
});

test('buildChainUrl: пустые и undefined параметры не попадают в запрос', () => {
  const url = buildChainUrl('/api/sync-games', { backfill: 1, from_page: undefined, chain: '' });
  assert.ok(url.includes('backfill=1'));
  assert.ok(!url.includes('from_page'));
  assert.ok(!url.includes('chain='));
});

test('buildChainUrl: без параметров — без вопросительного знака', () => {
  const url = buildChainUrl('/api/watchdog', {});
  assert.ok(!url.includes('?'));
});

// ─── fetchTimeBudget (кламп fetch под твёрдый лимит инвока) ───────────

test('fetchTimeBudget: в начале сегмента — полный бюджет (20с, 1 ретрай)', () => {
  const now = Date.now();
  const fb = fetchTimeBudget(now, now + 57_000); // инвок только начался
  assert.ok(fb, 'бюджет должен быть');
  assert.equal(fb.timeoutMs, 20_000);
  assert.equal(fb.retries, 1);
});

test('fetchTimeBudget: у дедлайна бюджет падает до 10с/1 ретрай', () => {
  const now = Date.now();
  const fb = fetchTimeBudget(now, now + 30_000); // осталось ~26с usable
  assert.ok(fb);
  assert.equal(fb.timeoutMs, 10_000);
  assert.equal(fb.retries, 1);
});

test('fetchTimeBudget: в последней фазе — одна быстрая попытка без ретраев', () => {
  const now = Date.now();
  const fb = fetchTimeBudget(now, now + 15_000); // usable ~11с
  assert.ok(fb);
  assert.equal(fb.retries, 0);
  assert.ok(fb.timeoutMs <= 10_000);
});

test('fetchTimeBudget: времени нет — null (сегмент завершается с сохранением)', () => {
  const now = Date.now();
  assert.equal(fetchTimeBudget(now, now + 8_000), null);
  assert.equal(fetchTimeBudget(now, now - 1_000), null); // уже за твёрдым концом
});

test('fetchTimeBudget: hardEnd по умолчанию = дедлайн + 13с', () => {
  // дедлайн «сейчас + 31с» → hardEnd = +44с → usable ~40с (< 42с порога) → 10с
  const deadline = Date.now() + 31_000;
  const fb = fetchTimeBudget(deadline);
  assert.ok(fb);
  assert.equal(fb.timeoutMs, 10_000);
  assert.equal(fb.retries, 1);
});
