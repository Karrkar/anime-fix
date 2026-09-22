#!/usr/bin/env node
/**
 * Чистка «Креатива»: в ленте — только тематические арты.
 *
 * Что делает (порт src/lib/creative-filter.ts на чистый JS, логика 1:1):
 *  1) по 8 оставшимся каналам: прогоняет посты через isArtPost
 *     (без визуала / кросс-промо списком / жёсткие рекламные маркеры → вон),
 *     у оставшихся чистит подписи sanitizeCaption (футеры Предложка/Заказать/
 *     VIP/ссылки атрибуции) и пишет строку обратно;
 *  2) удаляет строки creative_depth_/creative_cache_ двух не-артовых каналов
 *     (ai_harem — промо сервиса; StefanFalkokAI — ИИ-новости);
 *  3) удаляет из Storage зеркала удалённых постов (каналы целиком + отбраковка).
 *
 * Запуск:  node scripts/cleanup_creative.mjs --dry   (только отчёт)
 *          node scripts/cleanup_creative.mjs         (боевой прогон)
 */
const SB = 'https://uymeyfnuxfbkwisggzdt.supabase.co';
const SK = process.env.SUPABASE_SERVICE_ROLE_KEY || 'REDACTED-ROTATE-KEY-IN-SUPABASE';
const DRY = process.argv.includes('--dry');

const KEEP_CHANNELS = ['pornofullp','art_Hub_ai','neuroart1215','neyroanime','stefanfalkokmoth','simple_elf','the_horny_ai','genshin3416'];
const REMOVE_CHANNELS = ['ai_harem', 'StefanFalkokAI'];

// ═════════════════ ПОРТ creative-filter.ts (1:1) ═════════════════

const URL_RE = new RegExp(
  [
    'https?://\\S+',
    '(?:^|\\s)(?:t\\.me|vk\\.com|vk\\.ru|clck\\.ru|bit\\.ly|youtu\\.be)/\\S+',
    '(?:^|\\s)[a-z0-9-]+\\.(?:com|ru|net|org|me|io|red|gg|xyz|to|app|dev|art|fun|link|su|pro|site|online|club|page|pics|gallery|boosty)\\/?\\S*',
  ].join('|'),
  'gi',
);
function stripUrls(cap) { return cap.replace(URL_RE, ' '); }
function countLetters(s) { return (s.match(/[\p{L}\p{N}]/gu) || []).length; }
function decodeNumericEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}
const AD_HARD_RE = new RegExp(
  [
    '\\bреклам[аыуе]\\b', 'спонсор', 'промокод', 'промо\\s+код', '\\bказино\\b', 'букмекер',
    'ставк[а-яё]*\\s+на\\s', 'подпишись', 'подписывайся', 'подписывайтесь', 'скидк[аи]',
    'стрим', 'ютуб', 'твич', 'прохожден',
    '(?:новый|второй|запасной|резервный)\\s+канал', 'канал\\s+заблокирован',
    'технические\\s+проблемы', 'сервис\\s+(?:восстановлен|работает)', 'мы\\s+переехали',
    'страничк[а-яё]*\\s+на\\s', 'по\\s+вопросам\\s+(?:рекламы|сотрудничества|размещения)',
  ].join('|'),
  'i',
);
function isArtPost(raw) {
  const photos = raw.photos || [];
  if (!photos.length && !raw.videoPoster) return false;
  const cap = decodeNumericEntities(raw.caption || '').replace(/\s+/g, ' ').trim();
  if (!cap) return true;
  const urls = cap.match(URL_RE);
  if (urls && urls.length >= 2) {
    const letters = countLetters(stripUrls(cap));
    if (letters < 6) return false;
  }
  // жёсткие маркеры — по ОЧИЩЕННОЙ подписи (футеры вырезаны до проверки)
  const cleaned = sanitizeCaption(cap);
  if (cleaned && AD_HARD_RE.test(cleaned)) return false;
  return true;
}
const FOOTER_KEYWORDS = [
  'предложк', 'заказать', 'поддержа', 'забусти', 'приватк', 'доступ в', 'чатик', 'наш чат',
  'sfw канал', 'swf канал', 'бусти', 'boosty', 'випк',
  'vip[- ]?(?:групп|канал|доступ|подписк|раздел|чат)', 'вступ',
  'фулл альбом', 'хентай альбом', 'полный альбом', 'второй канал',
  'подписывайс', 'подпишит',
];
// «по вопросам» НЕ футерное слово — это рекламный маркер (см. AD_HARD_RE).
const SEPARATOR_RE = /\s*(?:\uD83C\uDF10|\uD83D\uDD20|\uD83D\uDFE3|\u27A1|\uD83D\uDCA0)\s*/g;
const CHUNK_DROP_RE = [
  /где\s+(?:я\s+)?ещ[её]\s+размещаю/i,
  /ссылк[аи]?\s+на\s+(?:все\s+)?(?:мои\s+)?(?:работы|арты|профиль)/i,
  /^(?:civit\s*ai|civitai|deviantart|pixiv|boosty|патреон|patreon|artstation|twitter|телеграм|telegram|тг)$/i,
];
const HAS_WORDCHAR_RE = /[\p{L}\p{N}]/u;
function sanitizeCaption(rawCaption) {
  let s = decodeNumericEntities(rawCaption || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = stripUrls(s);
  s = s.replace(/\([^)]*(?:випк|vip|приватн|закрыт|закрыта|платн)[^)]*\)/gi, ' ');
  const chunks = s
    .replace(SEPARATOR_RE, '\u2023')
    .split(/\u2023|(?<=[.!?…])\s+/)
    .map(c => c.trim())
    .filter(Boolean);
  const kept = [];
  for (let chunk of chunks) {
    for (const kw of FOOTER_KEYWORDS) {
      const re = new RegExp(kw + '.*$', 'i');
      if (re.test(chunk)) chunk = chunk.replace(re, '').trim();
      if (!chunk) break;
    }
    chunk = chunk
      .replace(/\s+/g, ' ')
      .replace(/^[|·—–:;,\s]+/, '')
      .replace(/[|·—–:;,\s]+$/, '')
      .trim();
    if (chunk.length < 2) continue;
    if (!HAS_WORDCHAR_RE.test(chunk)) continue;
    if (/[:\uFF1A]$/.test(chunk)) continue;
    if (CHUNK_DROP_RE.some(re => re.test(chunk))) continue;
    kept.push(chunk);
  }
  let out = kept.join(' ').replace(/\s+/g, ' ').trim();
  out = out.replace(/\s*([.!?…])\s*/g, '$1 ');
  out = out.replace(/\s+$/, '').trim();
  return out.slice(0, 600);
}

// ═════════════════ Supabase REST helpers ═════════════════

async function rest(path, method = 'GET', body = null, extraHeaders = {}) {
  const headers = { apikey: SK, Authorization: `Bearer ${SK}`, ...extraHeaders };
  if (body !== null) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${SB}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, text };
}
async function restJson(path, method, body) {
  const { status, text } = await rest(path, method, body);
  if (status >= 300) throw new Error(`${method} ${path} → ${status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function loadRow(source) {
  const rows = await restJson(`/rest/v1/sync_status?select=source,details&source=eq.${encodeURIComponent(source)}`);
  return rows && rows.length ? rows[0] : null;
}

// ═════════════════ Основной прогон ═════════════════

const dropReasons = { no_visual: 0, promo_list: 0, ad_marker: 0 };
const allDroppedPaths = []; // зеркала удалённых постов (оставшиеся каналы)
let totalBefore = 0, totalAfter = 0;

function classifyDrop(p) {
  const photos = p.photos || [];
  if (!photos.length && !p.videoPoster) return 'no_visual';
  const cap = decodeNumericEntities(p.caption || '').replace(/\s+/g, ' ').trim();
  const urls = cap.match(URL_RE);
  if (urls && urls.length >= 2 && countLetters(stripUrls(cap)) < 6) return 'promo_list';
  return 'ad_marker';
}
function storagePathOf(u) {
  if (!u || typeof u !== 'string') return null;
  const m = u.match(/\/storage\/v1\/object\/public\/covers\/(creative\/\S+?)(?:\?|$)/);
  return m ? m[1] : null;
}

console.log(`Режим: ${DRY ? 'DRY-RUN (без записи)' : 'БОЕВОЙ'}\n`);

for (const ch of KEEP_CHANNELS) {
  const source = `creative_depth_${ch}`;
  const row = await loadRow(source);
  if (!row || !row.details || !Array.isArray(row.details.posts)) {
    console.log(`[${ch}] строка не найдена — пропуск`);
    continue;
  }
  const posts = row.details.posts;
  const kept = [];
  const dropped = [];
  for (const p of posts) {
    if (isArtPost(p)) {
      const before = p.caption || '';
      p.caption = sanitizeCaption(before);
      kept.push(p);
    } else {
      dropped.push(p);
      dropReasons[classifyDrop(p)]++;
      for (const u of [...(p.photos || []), p.videoPoster]) {
        const path = storagePathOf(u);
        if (path) allDroppedPaths.push(path);
      }
    }
  }
  totalBefore += posts.length;
  totalAfter += kept.length;
  console.log(`[${ch}] ${posts.length} → ${kept.length} (−${dropped.length})`);
  if (process.argv.includes('--samples')) {
    for (const d of dropped.slice(0, 4)) {
      console.log(`   DROP(${classifyDrop(d)}) #${d.msgId}: ${(d.caption || '').replace(/\s+/g, ' ').slice(0, 90) || '(без подписи)'} [ph=${(d.photos || []).length} v=${d.videoPoster ? 1 : 0}]`);
    }
    for (const k of kept.slice(0, 4)) {
      const orig = (row.details.posts.find(p => p.msgId === k.msgId) || {}).caption || '';
      if (orig.replace(/\s+/g, ' ').trim() !== k.caption.trim()) {
        console.log(`   CLEAN #${k.msgId}:\n     до:  ${orig.replace(/\s+/g, ' ').slice(0, 120)}\n     после: ${k.caption.slice(0, 120)}`);
      }
    }
  }

  if (!DRY) {
    const details = { ...row.details, posts: kept, savedAt: new Date().toISOString() };
    const { status, text } = await rest(
      `/rest/v1/sync_status?source=eq.${encodeURIComponent(source)}`,
      'PATCH',
      JSON.stringify({ details, last_run_at: new Date().toISOString() }),
      { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    );
    if (status >= 300) console.log(`   ОШИБКА записи: ${status} ${text.slice(0, 150)}`);
  }

  // сэмплы чистки подписей
  const sample = kept.filter(p => p.caption && p.caption !== '(была ссылка/футер)').slice(0, 3);
  void sample;
}

console.log(`\nИТОГО по 8 каналам: ${totalBefore} → ${totalAfter} (−${totalBefore - totalAfter})`);
console.log(`Причины отбраковки: ${JSON.stringify(dropReasons)}`);

// ── Удаление строк двух не-артовых каналов ──
console.log(`\nУдаляем каналы целиком: ${REMOVE_CHANNELS.join(', ')}`);
for (const ch of REMOVE_CHANNELS) {
  for (const prefix of [`creative_depth_${ch}`, `creative_cache_${ch}`]) {
    if (DRY) { console.log(`  [dry] DELETE строку ${prefix}`); continue; }
    const { status, text } = await rest(`/rest/v1/sync_status?source=eq.${encodeURIComponent(prefix)}`, 'DELETE');
    console.log(`  DELETE ${prefix} → ${status}${status >= 300 ? ' ' + text.slice(0, 120) : ''}`);
  }
}

// ── Удаление зеркал из Storage ──
async function listStorage(prefix) {
  // ВАЖНО: API листинга этого Supabase матчит префикс только по границе ПАПКИ
  // ('creative/'), глубже ('creative/ai_harem-') — пусто; имена возвращаются
  // ОТНОСИТЕЛЬНО папки. Поэтому листим всю папку и фильтруем сами.
  const out = [];
  let offset = 0;
  for (;;) {
    const batch = await restJson('/storage/v1/object/list/covers', 'POST', {
      prefix: 'creative/', limit: 1000, offset, sortBy: { column: 'name', order: 'asc' },
    });
    if (!batch.length) break;
    out.push(...batch.map(o => o.name));
    if (batch.length < 1000) break;
    offset += 1000;
  }
  const folder = prefix.replace(/^creative\//, '');
  return out.filter(n => n.startsWith(folder));
}
async function deleteStorage(paths) {
  let done = 0;
  for (let i = 0; i < paths.length; i += 500) {
    const batch = paths.slice(i, i + 500);
    const { status, text } = await rest('/storage/v1/object/covers', 'DELETE', { prefixes: batch });
    if (status >= 300) { console.log(`  ОШИБКА Storage DELETE: ${status} ${text.slice(0, 150)}`); break; }
    done += batch.length;
  }
  return done;
}

if (!DRY) {
  // объекты каналов, удалённых целиком
  for (const ch of REMOVE_CHANNELS) {
    const paths = await listStorage(`creative/${ch}-`);
    console.log(`Storage creative/${ch}-*: ${paths.length} объектов`);
    if (paths.length) {
      const n = await deleteStorage(paths);
      console.log(`  удалено ${n}`);
    }
  }
  // зеркала отбракованных постов оставшихся каналов
  const uniq = [...new Set(allDroppedPaths)];
  console.log(`\nStorage: зеркала отбракованных постов — ${uniq.length} объектов`);
  if (uniq.length) {
    const n = await deleteStorage(uniq);
    console.log(`  удалено ${n}`);
  }
} else {
  console.log(`\n[dry] Storage: было бы удалено зеркал отбракованных постов: ${new Set(allDroppedPaths).size}`);
}

console.log('\nГотово.');
