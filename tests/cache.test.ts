/**
 * Тесты ограниченного TTL-кэша (src/lib/cache.ts, патч F-20).
 * Запуск: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BoundedTTLCache } from '../src/lib/cache';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('get/set: базовая запись и чтение', () => {
  const c = new BoundedTTLCache<string, number>(10, 60_000);
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('missing'), null);
});

test('TTL: просроченная запись отбрасывается лениво (без таймеров)', async () => {
  const c = new BoundedTTLCache<string, number>(10, 15);
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  await sleep(40);
  assert.equal(c.get('a'), null);
  assert.equal(c.size, 0); // удаление при обращении
});

test('LRU: при переполнении вытесняется самая старая по использованию запись', () => {
  const c = new BoundedTTLCache<string, number>(2, 60_000);
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.get('a'), 1); // 'a' становится свежей
  c.set('c', 3);               // вытесняется 'b', не 'a'
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('b'), null);
  assert.equal(c.get('c'), 3);
});

test('граница: size никогда не превышает maxEntries', () => {
  const c = new BoundedTTLCache<number, number>(5, 60_000);
  for (let i = 0; i < 100; i++) c.set(i, i);
  assert.equal(c.size, 5);
});

test('maxEntries < 1 приводится к 1 (без бесконечного роста)', () => {
  const c = new BoundedTTLCache<number, number>(0, 60_000);
  c.set(1, 1);
  c.set(2, 2);
  assert.equal(c.size, 1);
  assert.equal(c.get(2), 2); // осталась последняя
});

test('delete удаляет запись', () => {
  const c = new BoundedTTLCache<string, number>(10, 60_000);
  c.set('a', 1);
  c.delete('a');
  assert.equal(c.get('a'), null);
});
