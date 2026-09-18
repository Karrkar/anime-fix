/**
 * Тесты единого реестра внешних источников (src/lib/sources.ts, патч F-27).
 * Гарантирует целостность данных, от которых зависят маршруты и CSP.
 * Запуск: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SOURCES,
  VOST_BASE,
  HB_BASE,
  FEELEX_BASE,
  XXX_IGRA_BASE,
  R34_BASE,
  JINA_READER,
  PLAYER_PROXY_ALLOWED_HOSTS,
  R34IMG_ALLOWED_HOSTS,
  CSP_FRAME_HOSTS,
  CSP_CONNECT_HOSTS,
} from '../src/lib/sources';

test('каждый источник имеет https-base и непустой список хостов', () => {
  for (const [name, def] of Object.entries(SOURCES)) {
    assert.ok(def.base.startsWith('https://'), `${name}: base должен быть https`);
    assert.ok(def.hosts.length > 0, `${name}: hosts не пуст`);
    for (const h of def.hosts) {
      assert.ok(!h.includes('/') && !h.includes(':'), `${name}: хост "${h}" без схемы/порта`);
    }
  }
});

test('алиасы соответствуют реестру', () => {
  assert.equal(VOST_BASE, SOURCES.vost.base);
  assert.equal(HB_BASE, SOURCES.hentaibaza.base);
  assert.equal(FEELEX_BASE, SOURCES.feelex.base);
  assert.equal(XXX_IGRA_BASE, SOURCES.xxxIgra.base);
  assert.equal(R34_BASE, SOURCES.rule34.base);
  assert.equal(JINA_READER, SOURCES.jinaReader.base);
});

test('белый список player-proxy покрывает исторические хосты плеера', () => {
  for (const h of ['vost.pw', 'www.vost.pw', '13.vost.pw']) {
    assert.ok(PLAYER_PROXY_ALLOWED_HOSTS.includes(h), `нет ${h}`);
  }
});

test('белый список r34img покрывает CDN rule34', () => {
  for (const h of ['rule34.xxx', 'wimg.rule34.xxx', 'img.rule34.xxx']) {
    assert.ok(R34IMG_ALLOWED_HOSTS.includes(h), `нет ${h}`);
  }
});

test('CSP: frame-src содержит хост плеера v13.vost.pw', () => {
  assert.ok(CSP_FRAME_HOSTS.includes('https://v13.vost.pw'));
});

test('CSP: connect-src содержит yoomoney и jina-reader (origin без слэша)', () => {
  assert.ok(CSP_CONNECT_HOSTS.includes('https://yoomoney.ru'));
  assert.ok(CSP_CONNECT_HOSTS.includes('https://r.jina.ai'));
  for (const host of CSP_CONNECT_HOSTS) {
    assert.ok(host.startsWith('https://'), `${host}: только https-оригины`);
  }
});

test('хост источника vost совпадает с хостом из его base-URL', () => {
  for (const def of Object.values(SOURCES)) {
    const origin = new URL(def.base).hostname;
    const selfHost = def.hosts.find(h => h === origin || origin.endsWith(`.${h}`) || h.endsWith(`.${origin}`));
    // base-URL обязан указывать на семейство собственных хостов
    assert.ok(selfHost || def.hosts.some(h => origin.includes(h.split('.')[0])), `base ${def.base} не согласован с hosts`);
  }
});
