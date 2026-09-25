import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, extractName, engineReply, detectGenre, mirrorWords,
  sanitizeProfile, extractProfileDelta, detectMood,
  type ChatMsg,
} from '../src/lib/succubus';

const RECS = [
  { title: 'Ван-Пис', genres: 'приключения, фэнтези' },
  { title: 'Твоё имя', genres: 'романтика, драма' },
  { title: 'Тетрадь смерти', genres: 'триллер, детектив' },
];

test('classify: приветствие, просьба совета, 18+, имя', () => {
  assert.equal(classify('Привет!'), 'greeting');
  assert.equal(classify('посоветуй что-нибудь на вечер'), 'rec');
  assert.equal(classify('покажи хентай'), 'lewd');
  assert.equal(classify('меня зовут Артём'), 'name');
  assert.equal(classify('как дела?'), 'how-are-you');
});

test('classify: повтор сообщения распознаётся', () => {
  assert.equal(classify('что нового?', 'что нового?'), 'repeat');
});

test('extractName: имя капитализируется', () => {
  assert.equal(extractName('меня зовут артём'), 'Артём');
  assert.equal(extractName('просто привет'), null);
});

test('engineReply: ответ всегда непустой и не падает на пустой истории', () => {
  const r = engineReply('привет', { history: [], recs: RECS });
  assert.ok(typeof r === 'string' && r.length > 15);
});

test('engineReply: лёвит-запрос не выдаёт откровенности и отправляет в 18+', () => {
  const r = engineReply('разденься', { history: [], recs: RECS });
  assert.match(r, /18\+|подписк|светск/);
});

test('engineReply: рекомендация содержит реальный тайтл из переданного списка', () => {
  const r = engineReply('посоветуй аниме на вечер', { history: [], recs: RECS });
  assert.ok(RECS.some(t => r.includes(`«${t.title}»`)), `ожидали тайтл в ответе: ${r}`);
});

test('engineReply: помнит имя из истории', () => {
  const history: ChatMsg[] = [
    { role: 'user', content: 'меня зовут Артём' },
    { role: 'assistant', content: 'Запомнила, Артём.' },
  ];
  const r = engineReply('болтаю просто так', { history, recs: RECS });
  assert.ok(r.includes('Артём'), `имя должно быть в ответе: ${r}`);
});

test('engineReply: повтор получает дразнящий ответ', () => {
  // Конвенция вызова: history включает текущее сообщение последним элементом
  const history: ChatMsg[] = [
    { role: 'user', content: 'что нового?' },
    { role: 'assistant', content: 'ответ' },
    { role: 'user', content: 'что нового?' },
  ];
  const r = engineReply('что нового?', { history, recs: RECS });
  assert.match(r, /Повторяешься/);
});

test('engineReply: обычное сообщение не считается повтором', () => {
  const history: ChatMsg[] = [
    { role: 'user', content: 'привет' },
    { role: 'assistant', content: 'Привет-привет!' },
    { role: 'user', content: 'кто ты такая?' },
  ];
  const r = engineReply('кто ты такая?', { history, recs: RECS });
  assert.ok(!r.includes('Повторяешься'), `не должно быть повтора: ${r}`);
  assert.match(r, /Лилит|хранительница|суккуб/i);
});

test('engineReply: флирт звучит живо (эмодзи/дразнилка), не канцелярит', () => {
  const r = engineReply('ты такая красивая', { history: [], recs: RECS });
  assert.match(r, /😏|💜|😈|🔥|хихика|подмиг|губк|ресниц|вздох/, `флирт-ответ без живости: ${r}`);
});

test('engineReply: лёвит в 18+ разделе — дразнит, но не выдаёт, упоминает 18+', () => {
  const r = engineReply('хочу тебя', { history: [], recs: RECS });
  assert.match(r, /18\+|подписк|светск/);
  assert.match(r, /😏|😈|флирт|соблазн|интрига/i);
});

test('detectGenre: романтика и триллер', () => {
  assert.equal(detectGenre('хочу что-то в жанре романтики'), 'романтика');
  assert.equal(detectGenre('посоветуй триллер'), 'триллер');
  assert.equal(detectGenre('мне скучно'), null);
  assert.equal(detectGenre('просто привет'), null);
});

test('mirrorWords: не более 2 слов, стоп-слова отфильтрованы', () => {
  const w = mirrorWords('Я просто мечтаю про путешествия и драконов');
  assert.ok(w.length <= 2 && w.length >= 1);
  assert.ok(!w.includes('просто'));
});

test('engineReply: 30 прогонов дают хотя бы 5 уникальных ответов (живость)', () => {
  const set = new Set<string>();
  for (let i = 0; i < 30; i++) set.add(engineReply('расскажи о себе', { history: [], recs: RECS }));
  assert.ok(set.size >= 5, `слишком мало вариаций: ${set.size}`);
});

test('engineReply: 30 приветствий дают хотя бы 8 уникальных ответов (разнообразие)', () => {
  const set = new Set<string>();
  for (let i = 0; i < 30; i++) set.add(engineReply('привет', { history: [], recs: RECS }));
  assert.ok(set.size >= 8, `слишком мало вариаций приветствий: ${set.size}`);
});

test('engineReply: анти-повтор — 6 одинаковых сообщений подряд дают ≥4 уникальных ответа', () => {
  let history: ChatMsg[] = [];
  const replies: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = engineReply('болтаю просто так', { history, recs: RECS });
    replies.push(r);
    history = [...history, { role: 'user', content: 'болтаю просто так' }, { role: 'assistant', content: r }];
  }
  const uniq = new Set(replies).size;
  assert.ok(uniq >= 4, `много повторов подряд: ${uniq}/6 уникальных\n${replies.join('\n---\n')}`);
});

test('engineReply: свободная тема (усталость) получает живой разговор, а не подборку аниме', () => {
  const r = engineReply('я так устал на работе сегодня', { history: [], recs: RECS });
  assert.ok(!r.includes('«'), `не должно быть списка тайтлов: ${r}`);
  assert.match(r, /устал|день|слушаю|отвлек|ноч|расскаж|дедлайн|работ|сил/i, `нет живой реакции: ${r}`);
});

// ─── Доработка общения: профиль-память, тайтлы, живость ──────────────────

test('sanitizeProfile: whitelist-очистка, лимиты и капитализация имени', () => {
  const p = sanitizeProfile({
    name: 'артём',
    favGenres: ['романтика', '<script>alert(1)</script>', ''],
    favTitles: ['Твоё имя'],
    facts: ['работает ночью'],
    hack: 'x',
  });
  assert.equal(p.name, 'Артём');
  assert.deepEqual(p.favGenres, ['романтика']);
  assert.deepEqual(p.favTitles, ['Твоё имя']);
  assert.deepEqual(p.facts, ['работает ночью']);
  assert.equal((p as Record<string, unknown>).hack, undefined);
  assert.deepEqual(sanitizeProfile(null), {});
  assert.deepEqual(sanitizeProfile('oops'), {});
  assert.deepEqual(sanitizeProfile(42), {});
});

test('engineReply: помнит имя из профиля даже без истории', () => {
  const r = engineReply('привет', { history: [], recs: RECS, profile: { name: 'Артём' } });
  assert.ok(r.includes('Артём'), `имя из профиля: ${r}`);
});

test('engineReply: реакция на упоминание тайтла из каталога', () => {
  const r = engineReply('смотрел Ван-Пис на выходных', { history: [], recs: RECS });
  assert.ok(r.includes('Ван-Пис'), `тайтл в ответе: ${r}`);
});

test('engineReply: негатив про тайтл — дразнящий ответ без обиды', () => {
  const r = engineReply('Ван-Пис скучный, бросил', { history: [], recs: RECS });
  assert.ok(r.includes('Ван-Пис'), `тайтл в ответе: ${r}`);
  assert.match(r, /приверед|по зубам|записала|сери|исправлю/i, `нет дразнилки: ${r}`);
});

test('engineReply: короткое «ок» получает подначку раскрыться', () => {
  const r = engineReply('ок', { history: [], recs: RECS });
  assert.match(r, /развёрнут|подробн|продолжай|расскаж|телепат/i, `подначка: ${r}`);
});

test('engineReply: оценка рекомендации — живая реакция, а не новый список', () => {
  const history: ChatMsg[] = [
    { role: 'user', content: 'посоветуй аниме' },
    { role: 'assistant', content: 'Мой вердикт «Твоё имя», «Тетрадь смерти». Глянь трейлер. Не зайдёт — вернись' },
    { role: 'user', content: 'глянул, зашло!' },
  ];
  const r = engineReply('глянул, зашло!', { history, recs: RECS });
  assert.ok(!r.includes('«'), `не должен снова вываливать список: ${r}`);
  assert.match(r, /😏|💜/, `нет живости в реакции: ${r}`);
});

test('engineReply: жанровый вопрос («про любовь?») — ответ тайтлами', () => {
  const r = engineReply('а есть что-нибудь про любовь?', { history: [], recs: RECS });
  assert.ok(RECS.some(t => r.includes(`«${t.title}»`)), `тайтл в ответе: ${r}`);
});

test('engineReply: профиль — любимый жанр не ломает рекомендацию', () => {
  const r = engineReply('посоветуй аниме', { history: [], recs: RECS, profile: { favGenres: ['романтика'] } });
  assert.ok(RECS.some(t => r.includes(`«${t.title}»`)), `тайтл в ответе: ${r}`);
});

test('extractProfileDelta: имя, жанр и тайтл при позитиве', () => {
  const d = extractProfileDelta('меня зовут Артём, люблю романтику и Ван-Пис обожаю', RECS);
  assert.equal(d.name, 'Артём');
  assert.deepEqual(d.favGenres, ['романтика']);
  assert.deepEqual(d.favTitles, ['Ван-Пис']);
});

test('extractProfileDelta: без позитива жанр не запоминается', () => {
  const d = extractProfileDelta('ненавижу романтику в аниме', RECS);
  assert.equal(d.favGenres, undefined);
});

test('detectMood: усталость, радость и нейтраль', () => {
  assert.equal(detectMood([{ role: 'user', content: 'я так устал' }]), 'low');
  assert.equal(detectMood([{ role: 'user', content: 'получилось! ура!' }]), 'high');
  assert.equal(detectMood([]), 'neutral');
});
