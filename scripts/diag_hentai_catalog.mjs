// Диагностика хентай-каталога: список → /api/anime?id= → эпизоды → плеер
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
console.log('логин:', token ? 'OK' : 'FAIL');

// 1. Список хентая
const h = await (await fetch(`${BASE}/api/hentai?limit=5`, { headers: { cookie: COOKIE } })).json();
const items = h.anime || [];
console.log('\nхентай-тайтлов:', items.length);
for (const a of items.slice(0, 5)) {
  console.log(`  id=${a.id} | ep=${a.episodes} | src=${(a.sourceUrl || a.embed_url || '').slice(0, 75)}`);
}

if (items.length) {
  const id = items[0].id;
  // 2. /api/anime?id=<hentai id> — это читает WatchPage
  const ar = await fetch(`${BASE}/api/anime?id=${encodeURIComponent(id)}`, { headers: { cookie: COOKIE } });
  const aj = await ar.json().catch(() => null);
  console.log(`\nGET /api/anime?id=${id} → ${ar.status}`);
  if (aj?.anime) {
    console.log('  title:', (aj.anime.title || '').slice(0, 50));
    console.log('  sourceUrl:', (aj.anime.sourceUrl || '').slice(0, 90));
    console.log('  episodes:', aj.anime.episodes);
  } else console.log('  body:', JSON.stringify(aj).slice(0, 200));

  // 3. Эпизоды (для не-db id WatchPage зовёт /api/anime-episodes)
  const er = await fetch(`${BASE}/api/anime-episodes?animeId=${encodeURIComponent(id)}`, { headers: { cookie: COOKIE } });
  const ej = await er.json().catch(() => null);
  console.log(`GET /api/anime-episodes?animeId=${id} → ${er.status}, эпизодов: ${ej?.episodes?.length ?? 0}`);
  if (ej?.episodes?.length) {
    const e1 = ej.episodes[0];
    console.log('  эп.1 embedUrl:', (e1.embedUrl || '').slice(0, 90));
    // 4. Если embedUrl на vost — прокси; иначе прямой iframe. Проверим прокси для любых vost-ссылок
    const src = e1.embedUrl || '';
    if (src.includes('vost.pw')) {
      const pr = await fetch(`${BASE}/api/player-proxy?url=${encodeURIComponent(src)}&episode=1`, { headers: { cookie: COOKIE } });
      const txt = await pr.text();
      console.log(`GET player-proxy → ${pr.status}, содержит iframe: ${txt.includes('<iframe')}, содержит ошибку: ${txt.includes('Не удалось') || txt.includes('Ошибка')}`);
    }
  }
}
