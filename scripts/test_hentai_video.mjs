// Ищем видео-посты через прод-API и тестируем их воспроизведение через r34img
const BASE = 'https://anime-fix.vercel.app';

async function login() {
  const r = await fetch(`${BASE}/api/subscription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', email: (process.env.ADMIN_EMAIL || 'admin@example.com'), password: (process.env.ADMIN_PASSWORD || 'CHANGE-ME') }),
  });
  const m = (r.headers.get('set-cookie') || '').match(/anime_platform_token=([^;]+)/);
  return m ? m[1] : null;
}

const token = await login();
const COOKIE = `anime_age_confirmed=1; anime_platform_token=${token}`;

// Берём список (кэш прод уже прогрет) и сканируем посты на видео
const list = await (await fetch(`${BASE}/api/rule34?limit=42`, { headers: { cookie: COOKIE } })).json();
const posts = list.posts || [];
console.log('сканируем', posts.length, 'постов...');

let found = 0;
for (const p of posts.slice(0, 12)) {
  const pr = await fetch(`${BASE}/api/rule34-post?id=${p.id}`, { headers: { cookie: COOKIE } });
  const d = await pr.json().catch(() => null);
  const isVideo = d?.isVideo || /\.(mp4|webm)(\?|$)/i.test(d?.imageUrl || '');
  if (isVideo) {
    found++;
    const url = d.imageUrl;
    console.log(`\nВИДЕО-ПОСТ id=${p.id}: ${url.slice(0, 100)}`);
    // Тест 1: обычный запрос
    const t0 = Date.now();
    const m1 = await fetch(`${BASE}/api/r34img?url=${encodeURIComponent(url)}`, { headers: { cookie: COOKIE } });
    console.log(`  обычный: ${m1.status} ${m1.headers.get('content-type')} за ${Date.now() - t0}мс`);
    // Тест 2: Range (как делает <video>)
    const r1 = await fetch(`${BASE}/api/r34img?url=${encodeURIComponent(url)}`, { headers: { cookie: COOKIE, Range: 'bytes=0-1023' } });
    console.log(`  Range 0-1023: ${r1.status}, content-range=${r1.headers.get('content-range') || '—'}, accept-ranges=${r1.headers.get('accept-ranges') || '—'}`);
    if (found >= 2) break;
  }
}
if (!found) console.log('\nВидео-постов в первой дюжине не найдено');
