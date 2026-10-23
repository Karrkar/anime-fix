/**
 * Живая проверка вкладки «Арты» на проде: создаёт служебную сессию админа,
 * дёргает /api/rule34 (художник + агрегат), печатает результат, УДАЛЯЕТ сессию.
 *   node scripts/verify_live_arts.mjs [тег]   (по умолчанию arzagod)
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
const TAG = process.argv[2] || 'arzagod';

async function retryFetch(url, opts = {}, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) }); }
    catch (e) { if (i === tries) throw e; await new Promise(r => setTimeout(r, 1500 * i)); }
  }
}

// 1) служебная сессия админа
const u = await retryFetch(`${SB}/rest/v1/users?select=id,role&role=eq.admin&limit=1`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
});
const [admin] = await u.json();
if (!admin) { console.error('админ не найден'); process.exit(1); }
const token = crypto.randomBytes(32).toString('hex');
const ins = await retryFetch(`${SB}/rest/v1/sessions`, {
  method: 'POST',
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
  body: JSON.stringify({ user_id: admin.id, token }),
});
if (ins.status !== 201) { console.error('сессия не создана:', ins.status); process.exit(1); }
const COOKIE = `anime_age_confirmed=1; anime_platform_token=${token}`;

try {
  for (const q of [`tags=${TAG}&pid=0`, `tags=all&pid=0`, `tags=${TAG}&pid=420`]) {
    const r = await retryFetch(`${BASE}/api/rule34?${q}`, { headers: { cookie: COOKIE } });
    const ct = r.headers.get('x-data-stale') ? ' (STALE)' : '';
    if (!r.ok) {
      console.log(`?${q} → HTTP ${r.status}${ct}: ${(await r.text()).slice(0, 120)}`);
      continue;
    }
    const d = await r.json();
    const p0 = d.posts?.[0];
    console.log(`?${q} → HTTP ${r.status}${ct}: постов ${d.posts?.length}, total ${d.total}, стр ${d.totalPages}`
      + (p0 ? `; первый: id=${p0.id} score=${p0.score} artist=${p0.artist} thumb=${String(p0.thumbnailUrl).slice(0, 60)}` : ''));
  }
} finally {
  // 2) удалить служебную сессию
  await retryFetch(`${SB}/rest/v1/sessions?token=eq.${token}`, {
    method: 'DELETE',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  console.log('(служебная сессия удалена)');
}
