// E2E прод: вкладка Хентай (rule34) — список → пост → видео через /api/r34img
const BASE = 'https://anime-fix.vercel.app';
const AGE_COOKIE = 'anime_age_confirmed=1';

async function login() {
  const r = await fetch(`${BASE}/api/subscription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', email: (process.env.ADMIN_EMAIL || 'admin@example.com'), password: (process.env.ADMIN_PASSWORD || 'CHANGE-ME') }),
  });
  const setCookie = r.headers.get('set-cookie') || '';
  const m = setCookie.match(/anime_platform_token=([^;]+)/);
  return m ? m[1] : null;
}

const token = await login();
console.log('админ-логин:', token ? 'OK' : 'FAIL');
if (!token) process.exit(1);
const COOKIE = `${AGE_COOKIE}; anime_platform_token=${token}`;

// 1. Список артов
const listRes = await fetch(`${BASE}/api/rule34?tags=&limit=20`, { headers: { cookie: COOKIE } });
console.log('GET /api/rule34 →', listRes.status);
const list = await listRes.json().catch(() => null);
const posts = list?.posts || list?.arts || [];
console.log('постов получено:', Array.isArray(posts) ? posts.length : typeof list);

if (!Array.isArray(posts) || posts.length === 0) {
  console.log('LIST BODY:', JSON.stringify(list).slice(0, 400));
  process.exit(0);
}

// 2. Ищем видео-пост (thumbnailUrl содержит /videos/) и обычный
const videos = posts.filter(p => (p.thumbnailUrl || '').includes('/videos/') || p.isVideo);
const images = posts.filter(p => !(p.thumbnailUrl || '').includes('/videos/'));
console.log(`видео-постов: ${videos.length}, картинок: ${images.length}`);

async function testPost(p, kind) {
  const id = p.id;
  const postRes = await fetch(`${BASE}/api/rule34-post?id=${encodeURIComponent(id)}`, { headers: { cookie: COOKIE } });
  const post = await postRes.json().catch(() => null);
  const fullUrl = post?.imageUrl || post?.url || post?.fileUrl || '';
  console.log(`\n[${kind}] id=${id} → POST ${postRes.status}, imageUrl=${fullUrl ? fullUrl.slice(0, 80) : '(нет)'}`);
  if (postRes.status !== 200 || !fullUrl) {
    console.log('  POST BODY:', JSON.stringify(post).slice(0, 300));
    return;
  }
  // 3. Проксируем медиа
  const mediaRes = await fetch(`${BASE}/api/r34img?url=${encodeURIComponent(fullUrl)}`, { headers: { cookie: COOKIE } });
  const ct = mediaRes.headers.get('content-type') || '';
  const size = Number(mediaRes.headers.get('content-length') || 0);
  const body = kind === 'video' && mediaRes.status !== 200 ? Buffer.from(await mediaRes.arrayBuffer()).toString().slice(0, 200) : '';
  console.log(`  → /api/r34img ${mediaRes.status}, type=${ct}, size=${size || '?'}`);
  if (body) console.log('  BODY:', body);
  // Range-запрос как делает <video>
  const rangeRes = await fetch(`${BASE}/api/r34img?url=${encodeURIComponent(fullUrl)}`, { headers: { cookie: COOKIE, Range: 'bytes=0-1023' } });
  console.log(`  → Range-запрос: ${rangeRes.status} (206 нужен для стриминга), cr=${rangeRes.headers.get('content-range') || '—'}`);
}

if (videos[0]) await testPost(videos[0], 'video');
if (images[0]) await testPost(images[0], 'image');
if (!videos[0] && !images[0]) {
  console.log('Первые посты:', JSON.stringify(posts.slice(0, 3)).slice(0, 500));
}
