/**
 * Тесты автопостера Instagram (src/lib/instagram.ts) — генерация подписей,
 * хэштеги из жанров, URL обложек. Запуск: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractHashtags, buildFallbackCaption, buildCoverUrl, type CatalogRow } from '../src/lib/instagram';

const row = (over: Partial<CatalogRow> = {}): CatalogRow => ({
  vost_id: 4084,
  title: 'Kusuriya no Hitorigoto',
  title_russian: 'Монолог фармацевта',
  description: 'Девушка-аптекарь Маомао оказывается во внутреннем дворце императора'.repeat(6),
  image_url: 'https://v13.vost.pw/uploads/posts/2026-09/1789455638_1.jpg?v2',
  genres: 'Детектив, Драма, Исторический, Романтика',
  score: 90,
  year: 2026,
  type: 'ТВ',
  updated_at: '2026-10-26T00:00:00Z',
  ...over,
});

test('extractHashtags: жанры через запятую → валидные хэштеги', () => {
  assert.deepEqual(extractHashtags('Комедия, Драма, Школа'), ['#комедия', '#драма', '#школа']);
  assert.deepEqual(extractHashtags('Детектив; Драма / Исторический, Романтика'), [
    '#детектив', '#драма', '#исторический', '#романтика',
  ]);
});

test('extractHashtags: мусор и пустые значения отбрасываются', () => {
  assert.deepEqual(extractHashtags(null), []);
  assert.deepEqual(extractHashtags(''), []);
  assert.deepEqual(extractHashtags('a, ab, , ###'), []);
  // максимум 4 жанра
  assert.equal(extractHashtags('1abc, 2abc, 3abc, 4abc, 5abc, 6abc').length, 4);
});

test('buildFallbackCaption: заголовок, ссылка на тайтл, хэштеги, лимит IG 2200', () => {
  const c = buildFallbackCaption(row());
  assert.ok(c.includes('Монолог фармацевта'), 'русское название в подписи');
  assert.ok(c.includes('https://animeplatforma-new.online/anime/db-4084'), 'ссылка на страницу тайтла');
  assert.ok(c.includes('#детектив'), 'хэштег жанра');
  assert.ok(c.includes('Рейтинг 90/100'), 'рейтинг при score>=70');
  assert.ok(c.length <= 2200, 'лимит подписи Instagram');
  assert.ok(c.includes('…'), 'длинное описание обрезано с многоточием');
});

test('buildFallbackCaption: без описания и рейтинга — без пустых блоков', () => {
  const c = buildFallbackCaption(row({ description: null, score: 40 }));
  assert.ok(!c.includes('Рейтинг'), 'низкий рейтинг не показываем');
  assert.ok(c.includes('▶ Смотреть бесплатно'), 'ссылка остаётся');
});

test('buildCoverUrl: обложка через оптимизатор своего домена (https)', () => {
  const url = buildCoverUrl('https://v13.vost.pw/uploads/posts/2026-09/x.jpg?v2');
  assert.ok(url.startsWith('https://animeplatforma-new.online/_next/image?url='), 'через наш домен');
  assert.ok(url.includes('w=1080'), 'ширина 1080px — в допустимых пределах IG');
  assert.equal(buildCoverUrl('http://insecure.example/x.jpg'), 'http://insecure.example/x.jpg', 'http не проксируем');
  assert.equal(buildCoverUrl('не-url'), 'не-url', 'битый адрес — как есть');
});
