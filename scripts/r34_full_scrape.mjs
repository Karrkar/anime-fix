/**
 * ФИНАЛЬНЫЙ СКРЕЙП rule34.xxx — 14 художников, ВСЕ страницы, ~143k постов.
 *
 * Выяснено экспериментально:
 * - CF выдаёт челлендж стохастически (~20% запросов при нормальной репутации IP)
 * - Молоты/параллельные вкладки сжигают репутацию → спираль челленджей
 * - Тихий период ~20 мин восстанавливает репутацию
 * - Стратегия: 1 вкладка, пауза 7-10с, при челлендже — cooldown 3-4 мин тихо
 *
 * Порядок: round-robin по художникам с прогрессивным углублением
 * (стр.1 всех → стр.2 всех → ...), чтобы в любой момент остановки все
 * художники были одинаково глубоки. Новые посты (стр.1) — первыми.
 *
 * Вывод: r34-data/<tag>.ndjson + <tag>.state.json (резюмируемо).
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/z/.npm-global/lib/node_modules/playwright');

const OUT_DIR = '/home/z/my-project/r34-data';
const TAGS = ['arzagod', 'balecxi', 'kaistar', 'kinkimya', 'rognezart', 'hypet',
  'backdoorsenpai', 'milfhunter228', 'futarush', 'kiraamane', 'aliusnext',
  'meitabuu', 'maldo', 'duxvector'];
// Точные счётчики постов (autocomplete API, 2026-10-23) — знают total_pages заранее
const COUNTS = {
  arzagod: 8619, balecxi: 33243, kaistar: 6774, kinkimya: 1230, rognezart: 14062,
  hypet: 8790, backdoorsenpai: 2797, milfhunter228: 867, futarush: 14772,
  kiraamane: 11189, aliusnext: 4064, meitabuu: 8042, maldo: 21537, duxvector: 7334,
};
const PER_PAGE = 42;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const rnd = (a, b) => a + Math.random() * (b - a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.mkdirSync(OUT_DIR, { recursive: true });

function parseListPage(html, searchTag) {
  const posts = [];
  const thumbRegex = /<span id="s(\d+)" class="thumb"[^>]*>\s*<a id="p(\d+)" href="([^"]+)">[\s\S]*?<img[^>]*src="([^"]+)"[^>]*title="([^"]+)"/g;
  let match;
  while ((match = thumbRegex.exec(html)) !== null) {
    const [, , postId, href, thumbSrc, titleAttr] = match;
    const titleText = titleAttr.trim();
    const tags = [];
    let score = 0;
    let rating = 'explicit';
    const parts = titleText.split(/\s+/);
    const seen = new Set();
    for (const p of parts) {
      if (p.startsWith('score:')) { score = parseInt(p.replace('score:', ''), 10) || 0; }
      else if (p.startsWith('rating:')) { rating = p.replace('rating:', ''); }
      else if (p && !p.startsWith('(') && !p.startsWith(')')) {
        const normalized = p.replace(/_/g, ' ');
        if (!seen.has(normalized.toLowerCase())) { seen.add(normalized.toLowerCase()); tags.push(normalized); }
      }
    }
    const charTags = tags.filter(t => t.includes('('));
    const displayTitle = charTags.length > 0
      ? charTags.slice(0, 2).map(c => c.replace(/ \(.*\)$/, '')).join(', ')
      : tags.slice(0, 3).join(', ');
    const searchTagLower = searchTag.toLowerCase().replace(/_/g, ' ');
    const artistTag = tags.find(t => t.toLowerCase() === searchTagLower) ||
      tags.find(t => !t.includes('(') && t !== '1girl' && t !== '1boy' && !t.startsWith('ai '));
    const characterTags = tags.filter(t => t.includes('(') && !t.includes('fate') && !t.includes('series'));
    posts.push({
      id: postId, thumbnailUrl: thumbSrc, tags, artist: artistTag || 'Unknown',
      characters: characterTags.map(c => c.replace(/ \(.*\)$/, '')),
      score, rating, title: displayTitle,
      postUrl: `https://rule34.xxx${href}`,
    });
  }
  return posts;
}

function loadState(tag) {
  const f = path.join(OUT_DIR, `${tag}.state.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { done_pages: {} }; }
}
function saveState(tag, st) { fs.writeFileSync(path.join(OUT_DIR, `${tag}.state.json`), JSON.stringify(st)); }
function appendPosts(tag, posts) {
  if (posts.length) fs.appendFileSync(path.join(OUT_DIR, `${tag}.ndjson`), posts.map(p => JSON.stringify(p)).join('\n') + '\n');
}

(async () => {
  // Сколько страниц у каждого художника
  const pages = {};
  const states = {};
  for (const tag of TAGS) {
    pages[tag] = Math.ceil(COUNTS[tag] / PER_PAGE);
    states[tag] = loadState(tag);
  }
  console.log('План:', TAGS.map(t => `${t}:${pages[t]}c`).join(' '));
  console.log(`Всего страниц: ${Object.values(pages).reduce((a, b) => a + b, 0)}`);

  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--window-size=1920,1080'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, userAgent: UA, locale: 'en-US' });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  // Картинки НЕ блокируем полностью, но и не ждём их (load → domcontentloaded достаточно;
  // лёгкая эвристика CF: пусть главные грузятся). Блокируем только тяжёлую рекламу.
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (/exoclick|doubleclick|google-analytics|googletagmanager|\/iads|juicyads|popunder/.test(u)) return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();

  // Round-robin очередь: уровень за уровнем
  const queue = [];
  const maxPages = Math.max(...Object.values(pages));
  for (let lvl = 0; lvl < maxPages; lvl++) {
    for (const tag of TAGS) {
      if (lvl < pages[tag]) queue.push({ tag, page: lvl });
    }
  }
  // Пропускаем уже сделанные
  const todo = queue.filter(({ tag, page: pg }) => !states[tag].done_pages[pg]);
  console.log(`В очереди: ${todo.length} страниц (из ${queue.length})`);

  const t0 = Date.now();
  let done = 0, totalPosts = 0, challenges = 0;
  let stop = false;
  process.on('SIGTERM', () => { stop = true; });

  for (const { tag, page: pg } of todo) {
    if (stop) break;
    const pid = pg * PER_PAGE;
    const url = `https://rule34.xxx/index.php?page=post&s=list&tags=${tag}&pid=${pid}`;

    let html = null;
    // До 6 попыток; челлендж → тихий cooldown 3-4 мин
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await sleep(rnd(1200, 2200));
        let h = await page.content();
        if (h.includes('Just a moment') || h.includes('Attention Required')) {
          challenges++;
          const cool = rnd(180000, 240000);
          console.log(`\n[challenge] ${tag}#${pg + 1} (попытка ${attempt}) — тишина ${(cool / 60000).toFixed(1)} мин [${new Date().toISOString().slice(11, 19)}]`);
          await sleep(cool);
          continue;
        }
        // thumb-ы могли чуть опоздать
        if (!h.includes('class="thumb"') && !h.includes('chickens')) {
          await sleep(rnd(1500, 3000));
          h = await page.content();
          if (h.includes('Just a moment')) { challenges++; await sleep(rnd(120000, 180000)); continue; }
        }
        html = h;
        break;
      } catch (e) {
        console.log(`\n[goto-err] ${tag}#${pg + 1}: ${e.message.split('\n')[0].slice(0, 80)}`);
        await sleep(rnd(15000, 30000));
      }
    }

    if (html === null) {
      console.log(`\n[skip] ${tag}#${pg + 1} не даётся — пропускаю, вернёмся позже`);
      fs.appendFileSync(path.join(OUT_DIR, 'skipped.log'), `${tag}#${pg}\n`);
    } else {
      const posts = parseListPage(html, tag);
      appendPosts(tag, posts);
      states[tag].done_pages[pg] = true;
      saveState(tag, states[tag]);
      totalPosts += posts.length;
    }
    done++;

    const elapsed = (Date.now() - t0) / 60000;
    const rate = done / Math.max(elapsed, 0.01);
    const eta = ((todo.length - done) / Math.max(rate, 0.01)) / 60;
    console.log(`\r[${done}/${todo.length}] ${tag} стр.${pg + 1}/${pages[tag]} | постов: ${totalPosts} | челленджей: ${challenges} | ${elapsed.toFixed(1)}м, ETA ${eta.toFixed(0)}м   `);

    await sleep(rnd(6500, 10500)); // человеческий темп
  }

  const totalMin = ((Date.now() - t0) / 60000).toFixed(0);
  console.log(`\n\nЭТАП ЗАВЕРШЁН: ${done} страниц, ${totalPosts} постов за ${totalMin} мин`);
  const summary = {};
  for (const tag of TAGS) {
    let n = 0;
    try { n = fs.readFileSync(path.join(OUT_DIR, `${tag}.ndjson`), 'utf8').trim().split('\n').filter(Boolean).length; } catch {}
    summary[tag] = { scraped: n, expected: COUNTS[tag], pages_done: Object.keys(states[tag].done_pages).length, pages_total: pages[tag] };
  }
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
