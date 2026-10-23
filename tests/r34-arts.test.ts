/**
 * Тесты dapi-клиента и хранилища артов rule34 (октябрь 2026, задача
 * «все арты с источников + ежедневная подгрузка»).
 * Запуск: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDapiJson, mapDapiPost } from '../src/lib/r34-dapi';
import { R34_ARTISTS, PER_PAGE, PAGES_PER_CHUNK, POSTS_PER_CHUNK, postKey } from '../src/lib/r34-store';

/* ── parseDapiJson: защитный парсер ─────────────────────────────────── */

test('parseDapiJson: чистый JSON-массив', () => {
  const arr = parseDapiJson('[{"id":1,"tags":"a b"},{"id":2,"tags":"c"}]');
  assert.equal(arr?.length, 2);
  assert.equal(arr?.[0].id, 1);
});

test('parseDapiJson: Jina-фенс ```json ... ```', () => {
  const arr = parseDapiJson('```json\n[{"id":42,"tags":"x"}]\n```');
  assert.equal(arr?.length, 1);
  assert.equal(arr?.[0].id, 42);
});

test('parseDapiJson: HTML-мусор/CF-челлендж не парсится как массив', () => {
  assert.equal(parseDapiJson('<html><title>Attention Required</title></html>'), null);
  assert.equal(parseDapiJson('{"error":"some json object"}'), null);
  assert.equal(parseDapiJson(''), null);
  assert.equal(parseDapiJson('Just a string, no brackets'), null);
});

test('parseDapiJson: JSON внутри текста с обрамлением достаётся', () => {
  const arr = parseDapiJson('Title: Result\n[{"id":7,"tags":"t"}]\nFooter');
  assert.equal(arr?.length, 1);
  assert.equal(arr?.[0].id, 7);
});

/* ── mapDapiPost: маппинг dapi → формат грида ──────────────────────── */

const DAPI_POST = {
  id: 19124509,
  preview_url: 'https://wimg.rule34.xxx/thumbnails/813/thumbnail_abc123def456.jpg?19124509',
  file_url: 'https://wimg.rule34.xxx/images/813/abc123def456.png',
  rating: 'explicit',
  score: 87,
  tags: 'arzagod 1girl big_breasts genshin_impact amber_(genshin_impact) animated',
};

test('mapDapiPost: полные поля, подчёркивания → пробелы, artist по searchTag', () => {
  const p = mapDapiPost(DAPI_POST, 'arzagod');
  assert.ok(p);
  assert.equal(p!.id, '19124509');
  assert.equal(p!.thumbnailUrl, DAPI_POST.preview_url);
  assert.equal(p!.fullUrl, DAPI_POST.file_url);
  assert.equal(p!.score, 87);
  assert.equal(p!.rating, 'explicit');
  assert.equal(p!.artist, 'arzagod');
  // теги нормализованы: без подчёркиваний, дедуп
  assert.ok(p!.tags.includes('big breasts'));
  assert.ok(p!.tags.includes('genshin impact'));
  assert.ok(!p!.tags.some(t => t === 'big_breasts'));
  // персонажи — из скобочных тегов
  assert.ok(p!.characters.length > 0);
  assert.ok(p!.postUrl.includes('id=19124509'));
  // animated в тегах → видео-пост (бейдж GIF без деталки)
  assert.equal(p!.isVideo, true);
});

test('mapDapiPost: video-пост по file_url .mp4', () => {
  const p = mapDapiPost({ ...DAPI_POST, file_url: 'https://wimg.rule34.xxx/videos/813/xyz.mp4', tags: 'arzagod 1girl' }, 'arzagod');
  assert.ok(p);
  assert.equal(p!.isVideo, true);
  assert.equal(p!.fullUrl, 'https://wimg.rule34.xxx/videos/813/xyz.mp4');
});

test('mapDapiPost: битый пост → null', () => {
  assert.equal(mapDapiPost({} as never, 'arzagod'), null);
  assert.equal(mapDapiPost(null as never, 'arzagod'), null);
});

test('mapDapiPost: artist fallback — первый не-скобочный тег', () => {
  const p = mapDapiPost({ id: 5, tags: '1girl solo standing', preview_url: 'u', file_url: 'f' }, 'nonexistent_tag');
  assert.ok(p);
  assert.equal(p!.artist, 'solo');
});

/* ── r34-store: константы и ключи (инварианты хранилища) ───────────── */

test('R34_ARTISTS: 14 источников, уникальны, в нижнем регистре', () => {
  assert.equal(R34_ARTISTS.length, 14);
  assert.equal(new Set(R34_ARTISTS).size, 14);
  for (const t of R34_ARTISTS) assert.ok(t === t.toLowerCase() && /^[a-z0-9_]+$/.test(t));
});

test('PER_PAGE=42 (пагинация rule34) и чанк = 10 страниц = 420 постов', () => {
  assert.equal(PER_PAGE, 42);
  assert.equal(PAGES_PER_CHUNK, 10);
  assert.equal(POSTS_PER_CHUNK, 420);
});

test('postKey: формат r34_post:<id> совместим со строками от 03.10', () => {
  assert.equal(postKey('18924782'), 'r34_post:18924782');
  assert.equal(postKey(12345), 'r34_post:12345');
});
