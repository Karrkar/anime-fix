import { test } from 'node:test';
import assert from 'node:assert';

/**
 * 2026-10-04 fix «арты вообще не грузятся»: ключ Jina с нулевым балансом
 * (402) не должен убивать загрузку целиком — jinaHeaders обязан перейти
 * в анонимный режим на 30 минут после отвергнутого ключа.
 */

test('jinaHeaders: без JINA_API_KEY Authorization не прикладывается', async () => {
  delete process.env.JINA_API_KEY;
  const { jinaHeaders } = await import('../src/lib/jina');
  const h = jinaHeaders();
  assert.equal('Authorization' in h, false, 'ключа нет — заголовка быть не должно');
  assert.equal(h['X-Return-Format'], 'html');
});

test('jinaHeaders: после 402 (баланс) ключ уходит в 30-минутный анонимный режим', async () => {
  process.env.JINA_API_KEY = 'test-key';
  const { jinaHeaders, markJinaKeyRejected } = await import('../src/lib/jina');
  assert.ok(jinaHeaders().Authorization?.includes('test-key'), 'живой ключ прикладывается');

  markJinaKeyRejected(402);
  assert.equal('Authorization' in jinaHeaders(), false, '402 — режим анонима');

  markJinaKeyRejected(200); // не-401/402 не продлевает кулдаун и не сбрасывает
  assert.equal('Authorization' in jinaHeaders(), false, 'посторонний статус не возвращает ключ');

  markJinaKeyRejected(429); // рейт-лимит — НЕ мёртвый ключ
  // 429 не должен помечать ключ мёртвым, но и не снимает уже активный кулдаун
  assert.equal('Authorization' in jinaHeaders(), false);
});
