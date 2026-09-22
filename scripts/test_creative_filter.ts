/**
 * Юнит-тест фильтра «только арты» на реальных подписях из БД.
 * Запуск: npx tsx scripts/test_creative_filter.ts
 */
import { isArtPost, sanitizeCaption } from '../src/lib/creative-filter';

// ── DROP-кейсы (пост = мусор) ──────────────────────────────────────────────
const dropCases: Array<[string, any, string]> = [
  ['текстовый пост без визуала', { photos: [], videoPoster: undefined, caption: 'Просто текст' }, 'нет фото/постера'],
  ['кросс-промо списком', { photos: ['https://cdn4.telesco.pe/file/abc'], caption: '🔞 https://t.me/zzz18po 🔞 https://t.me/MonikaDDLC18 🔞 https://t.me/sarvente18' }, '3 ссылки'],
  ['реклама', { photos: ['x'], caption: 'Реклама в канале: по вопросам размещения пишите' }, 'реклам'],
  ['казино', { photos: ['x'], caption: 'Лучшие ставки на спорт прямо сейчас' }, 'букмекер/ставки'],
  ['стрим-анонс', { photos: ['x'], caption: 'Объявление @everyone ! Стрим в Таверне, Новую лигу открываем в POE 2 !!! https://youtube.com/live/ehjh3MmJ660' }, 'стрим'],
  ['youtube-прохождение', { photos: ['x'], caption: 'Финал прохождения Replaced, кто желает заходите) https://www.youtube.com/watch?v=abc' }, 'прохожден'],
  ['миграция канала', { photos: ['x'], caption: 'Старый канал заблокирован, новый https://t.me/neyroeros_3' }, 'канал заблокирован'],
  ['техпроблемы сервиса', { photos: ['x'], caption: 'Небольшие технические проблемы, мы уже работаем' }, 'технические проблемы'],
];

// ── KEEP-кейсы (пост = арт) ────────────────────────────────────────────────
const keepCases: Array<[string, any]> = [
  ['чистый арт без подписи', { photos: ['x'], caption: '' }],
  ['арт с тайтлом', { photos: ['x'], caption: 'Ria | Isekai Nonbiri Nouka' }],
  ['арт с 1 ссылкой атрибуции', { photos: ['x'], caption: 'Где я ещё размещаю арты: t.me/neuroart1215' }],
  ['арт с футером автора', { photos: ['x'], caption: 'Сбежать не удастся 😈 #LTX #Video #Delta #NSFW 🌐 Предложка 🌐 Заказать арт/лору 🌐 Поддержать канал' }],
  ['арт + VK випка', { photos: ['x'], caption: 'Lefiya Viridis | DanMachi Хентай альбом Лефии тут (приватная випка): https://vk.com/album-123 Вступить в VIP группу: https://vk.com/simple_elf_art' }],
  ['видео-арт', { photos: [], videoPoster: 'poster', caption: 'Ищу подходящую турбо-лору на Н3 👌 #ComfyUI #NSFW 🌐 Мой Бусти 🌐 Предложка' }],
  ['личный пост художника про арты', { photos: ['x'], caption: 'Привет всем, я наконец-то вернулся из отпуска и возвращаюсь к артам, сегодня представляю нового героя' }],
  ['сущность &#33;', { photos: ['x'], caption: 'Всем привет&#33; Новый арт&#33;' }],
  ['арт с донат+стрим-футером neuroart1215 (#4422)', { photos: ['x','x','x','x','x','x'], caption: 'Извращенная мышь из ZZZ Jane Doe, без лишних комментариев прошу любить и жаловать ❤️ Поддержать и заказать тему дня: donationalerts.com/r/neuro_artist 🖌 Мои арты: civitai.com/user/zeneron vk.com/neuroart1215 📺 Стримы: youtube.com/@zeneron1215' }],
  ['арт с стрим-футером (#4347)', { photos: ['x'], caption: 'Привет всем, сегодня у нас Йоруичи из Блича, её лучшее появление) ❤️ Поддержать и заказать тему дня: donationalerts.com/r/neuro_artist 🖌 Мои арты: civitai.com/user/zeneron 📺 Стримы: youtube.com/@zeneron1215' }],
];

// ── SANITIZE-кейсы: что должно остаться от подписи ────────────────────────
const sanitizeCases: Array<[string, string, string]> = [
  ['футер stefanfalkokmoth', 'Сбежать не удастся 😈 #LTX #Video #Delta #NSFW 🌐 Предложка 🌐 Заказать арт/лору 🌐 Поддержать канал 🌐 SFW канал/резерв', 'Сбежать не удастся 😈 #LTX #Video #Delta #NSFW'],
  ['футер simple_elf', 'Lefiya Viridis | DanMachi Хентай альбом Лефии тут (приватная випка): https://vk.com/album-1 Вступить в VIP группу: https://vk.com/x', 'Lefiya Viridis | DanMachi'],
  ['атрибуция', 'Привет! Строгая леди Эвелин из Zenless Zone Zero. Где я ещё размещаю арты: Civit AI: civitai.com/user/zeneron', 'Привет! Строгая леди Эвелин из Zenless Zone Zero.'],
  ['футер neuroart1215 (донат+арты+стримы)', 'Извращенная мышь из ZZZ Jane Doe, без лишних комментариев прошу любить и жаловать ❤️ Поддержать и заказать тему дня: donationalerts.com/r/neuro_artist 🖌 Мои арты: civitai.com/user/zeneron vk.com/neuroart1215 📺 Стримы: youtube.com/@zeneron1215', 'Извращенная мышь из ZZZ Jane Doe, без лишних комментариев прошу любить и жаловать ❤️'],
  ['чистая подпись не трогается', 'Tsaritsa | Genshin Impact', 'Tsaritsa | Genshin Impact'],
  ['пустая', '', ''],
  ['только ссылки', 'https://t.me/a https://t.me/b', ''],
  ['футер с полным альбомом', 'Фулл альбом Ольги тут: https://vk.com/album-2 (закрытая випка) Фулл альбом Хлои тут: https://vk.com/album-3', ''],
  ['декоративный футер cncstyle', '🔠 🔠 🔠 🟣 Доступ в приватку 🟣 Заказать картинку 🟣 Забустить канал 🔠 🔠 🔠 Молечка #cncstyle', 'Молечка #cncstyle'],
];

let fails = 0;
console.log('── DROP ──');
for (const [name, raw, why] of dropCases) {
  const ok = isArtPost(raw) === false;
  if (!ok) { fails++; console.log(`FAIL (не отброшен): ${name} [${why}]`); }
  else console.log(`ok    ${name}`);
}
console.log('── KEEP ──');
for (const [name, raw] of keepCases) {
  const ok = isArtPost(raw) === true;
  if (!ok) { fails++; console.log(`FAIL (отброшен зря): ${name} → ${JSON.stringify(raw).slice(0, 120)}`); }
  else console.log(`ok    ${name}`);
}
console.log('── SANITIZE ──');
for (const [name, input, expected] of sanitizeCases) {
  const got = sanitizeCaption(input);
  const ok = got === expected;
  if (!ok) { fails++; console.log(`FAIL ${name}\n   ожидалось: ${JSON.stringify(expected)}\n   получено:  ${JSON.stringify(got)}`); }
  else console.log(`ok    ${name}`);
}
console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
process.exit(fails ? 1 : 0);
