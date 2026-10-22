// Финал: тестируем ВСЕ видео-хосты, включая большие файлы и глубокие Range
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

const seen = new Map(); // host -> url
for (const pid of [0, 42]) {
  const list = await (await fetch(`${BASE}/api/rule34?pid=${pid}`, { headers: { cookie: COOKIE } })).json();
  const posts = list.posts || [];
  for (let i = 0; i < posts.length; i += 8) {
    await Promise.all(posts.slice(i, i + 8).map(async p => {
      const d = await (await fetch(`${BASE}/api/rule34-post?id=${p.id}`, { headers: { cookie: COOKIE } })).json().catch(() => null);
      if (d?.isVideo && d.imageUrl && !seen.has(new URL(d.imageUrl).hostname)) {
        seen.set(new URL(d.imageUrl).hostname, d.imageUrl);
      }
    }));
  }
}

console.log('уникальных видео-хостов:', seen.size);
for (const [host, url] of seen) {
  // Глубокий Range в середину файла — доказывает стриминг больших видео
  const r = await fetch(`${BASE}/api/r34img?url=${encodeURIComponent(url)}`, { headers: { cookie: COOKIE, Range: 'bytes=5000000-5000999' } });
  const cr = r.headers.get('content-range') || '';
  const buf = r.status === 206 ? new Uint8Array(await r.arrayBuffer()) : null;
  console.log(`${host} → ${r.status} ${r.headers.get('content-type')} cr=${cr.slice(0, 45)} bytes=${buf?.length}`);
}
