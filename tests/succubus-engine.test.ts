import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, extractName, engineReply, detectGenre, mirrorWords, type ChatMsg } from '../src/lib/succubus';

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
