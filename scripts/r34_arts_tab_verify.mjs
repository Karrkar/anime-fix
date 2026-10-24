/**
 * r34_arts_tab_verify.mjs — полная проверка работы вкладки «Арты» (раздел 18+)
 * на живом проде по всем её реальным пользовательским сценариям:
 *
 *   1. /api/rule34 — список:
 *      - дефолт (без tags) + агрегат «все художники»
 *      - выборка художников (первая страница)
 *      - ГЛУБОКИЕ страницы (пост ~30k у balecxi, ~21k у maldo, ~14k у futarush)
 *      - ПОСЛЕДНИЕ страницы (хвост, arzagod ~8.6k)
 *   2. /api/rule34-post — деталка арта (обычный + видео-пост)
 *   3. /api/r34img — прокси миниатюры (сетка грида грузится через него)
 *
 * Работает служебной сессией админа (создаётся и УДАЛЯЕТСЯ в конце).
 *   node scripts/r34_arts_tab_verify.mjs
 */
import crypto from 'crypto';
import { readFileSync } from 'fs';

const env = {};
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const BASE = 'https://animeplatforma-new.online';

const results = []; // {name, ok, info}
function record(name, ok, info) { results.push({ name, ok, info }); console.log(`  ${ok ? 'OK ' : 'FAIL'} ${name} — ${info}`); }

async function fetchT(url, opts = {}, timeoutMs = 25_000) {
  const t0 = Date.now();
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  return { r, ms: Date.now() - t0 };
}

// ── 1. служебная сессия админа ────────────────────────────────────────────
const u = await fetchT(`${SB}/rest/v1/users?select=id,role&role=eq.admin&limit=1`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
const [admin] = await u.r.json();
if (!admin) { console.error('админ не найден'); process.exit(1); }
const token = crypto.randomBytes(32).toString('hex');
const ins = await fetch(`${SB}/rest/v1/sessions`, {
  method: 'POST',
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
  body: JSON.stringify({ user_id: admin.id, token }),
});
if (ins.status !== 201) { console.error('сессия не создана:', ins.status); process.exit(1); }
const COOKIE = { cookie: `anime_age_confirmed=1; anime_platform_token=${token}` };
console.log('Служебная сессия админа создана. Проверяю вкладку «Арты»...\n');

try {
  // ── 2. СПИСОК: дефолт + художники + глубокие + хвосты + агрегат ────────
  console.log('=== /api/rule34 — список ===');
  const listChecks = [
    ['дефолт (tags пусто)', 'tags=&pid=0'],
    ['arzagod стр.1', 'tags=arzagod&pid=0'],
    ['balecxi стр.1', 'tags=balecxi&pid=0'],
    ['maldo стр.1', 'tags=maldo&pid=0'],
    ['kinkimya стр.1', 'tags=kinkimya&pid=0'],
    ['duxvector стр.1', 'tags=duxvector&pid=0'],
    ['ГЛУБОКО balecxi ~33k', 'tags=balecxi&pid=29400'],
    ['ГЛУБОКО balecxi ~33k (хвост)', 'tags=balecxi&pid=33018'],
    ['ГЛУБОКО maldo ~21k', 'tags=maldo&pid=21000'],
    ['ГЛУБОКО futarush ~14.4k', 'tags=futarush&pid=14406'],
    ['ХВОСТ arzagod ~8.6k', 'tags=arzagod&pid=8610'],
    ['агрегат all стр.1', 'tags=all&pid=0'],
    ['агрегат all глубоко', 'tags=all&pid=142800'],
  ];
  let firstPosts = null, videoPost = null, imagePost = null;
  for (const [name, q] of listChecks) {
    try {
      const { r, ms } = await fetchT(`${BASE}/api/rule34?${q}`, { headers: COOKIE });
      const stale = r.headers.get('x-data-stale') ? ' STALE' : '';
      if (!r.ok) { record(name, false, `HTTP ${r.status}${stale}: ${(await r.text()).slice(0, 90)}`); continue; }
      const d = await r.json();
      const n = d.posts?.length ?? 0;
      record(name, n > 0, `${n} постов, total ${d.total}, стр ${d.totalPages}, ${ms}мс${stale}`);
      if (q === 'tags=&pid=0' && n > 0) firstPosts = d.posts;
    } catch (e) { record(name, false, `сеть: ${String(e).slice(0, 80)}`); }
  }

  // ── 3. ДЕТАЛКА /api/rule34-post (обычный пост + видео, если найдём) ────
  console.log('\n=== /api/rule34-post — лайтбокс ===');
  if (firstPosts) {
    imagePost = firstPosts.find(p => !p.isVideo) || firstPosts[0];
    videoPost = firstPosts.find(p => p.isVideo);
    const tryDetail = async (post, label) => {
      const q = `id=${post.id}&thumb=${encodeURIComponent(post.thumbnailUrl || '')}`;
      const { r, ms } = await fetchT(`${BASE}/api/rule34-post?${q}`, { headers: COOKIE }, 35_000);
      if (!r.ok) { record(label, false, `HTTP ${r.status}: ${(await r.text()).slice(0, 90)}`); return; }
      const d = await r.json();
      const hasImg = !!d.imageUrl;
      record(label, hasImg, `id=${post.id}, ${hasImg ? 'полный URL получен' : 'НЕТ imageUrl'}, video=${!!d.isVideo}, ${ms}мс`);
    };
    await tryDetail(imagePost, 'деталка картинка');
    if (videoPost) await tryDetail(videoPost, 'деталка видео');
    else console.log('  —    видео-пост на первой странице не попался (не критично)');
  } else {
    record('деталка', false, 'нет постов для проверки (список пуст)');
  }

  // ── 4. ПРОКСИ КАРТИНОК /api/r34img (сетка грида) ───────────────────────
  console.log('\n=== /api/r34img — прокси миниатюр ===');
  if (firstPosts?.[0]?.thumbnailUrl) {
    const thumb = firstPosts[0].thumbnailUrl;
    const { r, ms } = await fetchT(`${BASE}/api/r34img?url=${encodeURIComponent(thumb)}`, { headers: COOKIE }, 30_000);
    const ct = r.headers.get('content-type') || '';
    const buf = r.ok ? await r.arrayBuffer() : null;
    record('миниатюра через прокси', r.ok && ct.startsWith('image/') && buf?.byteLength > 1000,
      `HTTP ${r.status}, ${ct || '?'}, ${buf ? (buf.byteLength / 1024 | 0) + 'КБ' : '—'}, ${ms}мс`);
  } else {
    record('миниатюра через прокси', false, 'нет thumbnailUrl');
  }

  // ── 5. гейт 18+: без куки возраст НЕ должен пускать ───────────────────
  console.log('\n=== гейт 18+ (без cookies) ===');
  const noAge = await fetchT(`${BASE}/api/rule34?tags=arzagod&pid=0`, {}, 15_000);
  record('чужак без подтверждения возраста → 403', noAge.r.status === 403, `HTTP ${noAge.r.status}`);
  const onlyAge = await fetchT(`${BASE}/api/rule34?tags=arzagod&pid=0`, { headers: { cookie: 'anime_age_confirmed=1' } }, 15_000);
  record('возраст есть, подписки нет → 403', onlyAge.r.status === 403, `HTTP ${onlyAge.r.status}`);

  // ── итог ────────────────────────────────────────────────────────────────
  const okN = results.filter(x => x.ok).length;
  console.log(`\n=== ИТОГ: ${okN}/${results.length} проверок пройдено ===`);
  const failed = results.filter(x => !x.ok);
  if (failed.length) { console.log('Провалено:'); failed.forEach(f => console.log(`  - ${f.name}: ${f.info}`)); process.exitCode = 2; }
} finally {
  await fetch(`${SB}/rest/v1/sessions?token=eq.${token}`, {
    method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  console.log('(служебная сессия удалена)');
}
