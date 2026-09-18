// Финальная сверка: картинки, видео 0-999 и видео 206/перемотка на проде
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

// 1. Картинка
const img = await fetch(`${BASE}/api/r34img?url=${encodeURIComponent('https://wimg.rule34.xxx/images/5392/ce13564273ad175af5234e8834142342.png?1851186')}`, { headers: { cookie: COOKIE } });
console.log('картинка wimg:', img.status, img.headers.get('content-type'));

// 2. Видео nymp4: стартовый кусок + перемотка
const u = 'https://nymp4.rule34.xxx//images/3279/609f7bd8197209b9b69f2e051ad404b2.mp4';
const v0 = await fetch(`${BASE}/api/r34img?url=${encodeURIComponent(u)}`, { headers: { cookie: COOKIE } });
console.log('видео старт:', v0.status, v0.headers.get('content-type'), 'cr=' + (v0.headers.get('content-range')||'').slice(0,40));
const vSeek = await fetch(`${BASE}/api/r34img?url=${encodeURIComponent(u)}`, { headers: { cookie: COOKIE, Range: 'bytes=1000000-1000999' } });
console.log('видео seek 1МБ:', vSeek.status, 'cr=' + (vSeek.headers.get('content-range')||'').slice(0,40));
const vOver = await fetch(`${BASE}/api/r34img?url=${encodeURIComponent(u)}`, { headers: { cookie: COOKIE, Range: 'bytes=99000000-99000999' } });
console.log('видео Range за EOF:', vOver.status, '(ожидаем 416)');
