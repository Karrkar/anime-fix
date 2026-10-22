// Собираем все хосты медиа rule34 из постов, чтобы обновить белый список
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

const hosts = new Map(); // host -> count
let videos = 0;

for (const pid of [0, 42, 84]) {
  const list = await (await fetch(`${BASE}/api/rule34?pid=${pid}`, { headers: { cookie: COOKIE } })).json();
  const posts = list.posts || [];
  // Параллельно по 6
  for (let i = 0; i < posts.length; i += 6) {
    await Promise.all(posts.slice(i, i + 6).map(async p => {
      const pr = await fetch(`${BASE}/api/rule34-post?id=${p.id}`, { headers: { cookie: COOKIE } });
      const d = await pr.json().catch(() => null);
      const u = d?.imageUrl;
      if (!u) return;
      try {
        const h = new URL(u).hostname;
        hosts.set(h, (hosts.get(h) || 0) + 1);
        if (/\.(mp4|webm)(\?|$)/i.test(u)) videos++;
      } catch {}
    }));
  }
  console.log(`страница pid=${pid}: постов ${posts.length}, видео найдено ${videos}`);
}

console.log('\n=== ВСЕ ХОСТЫ МЕДИА ===');
for (const [h, c] of [...hosts.entries()].sort((a, b) => b[1] - a[1])) console.log(`${h}: ${c}`);
