// Типы в anime_catalog: сколько креатива, игр, хентая — и их флаги is_adult
const SB_URL = 'https://uymeyfnuxfbkwisggzdt.supabase.co/rest/v1';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function rpcCount(groupBy) {
  // Постгрестовский group-by через head-запросы дорог; проще вытащить уникальные type через distinct
  const res = await fetch(`${SB_URL}/anime_catalog?select=type,is_adult&limit=2000&order=created_at.desc`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  const rows = await res.json();
  const stats = new Map();
  for (const r of rows) {
    const k = `${r.type} | adult=${r.is_adult} `;
    stats.set(k, (stats.get(k) || 0) + 1);
  }
  for (const [k, c] of [...stats.entries()].sort((a, b) => b[1] - a[1])) console.log(`${c}\t${k}`);
  console.log('...(выборка 2000 последних)');
}

// Полные счётчики по type через content-range head-запросы
async function headCount(filters) {
  const res = await fetch(`${SB_URL}/anime_catalog?select=*&${filters}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' },
  });
  const cr = res.headers.get('content-range');
  return cr ? cr.split('/')[1] : `?${res.status}`;
}

console.log('=== Распределение (последние 2000) ===');
await rpcCount();

console.log('\n=== Точные счётчики ===');
console.log('всего:', await headCount(''));
console.log("type=Креатив:", await headCount('type=eq.Креатив'));
console.log("type=Игра:", await headCount('type=eq.Игра'));
console.log("is_adult=true:", await headCount('is_adult=eq.true'));
console.log("is_adult=true&type=neq.Игра (запрос /api/hentai):", await headCount('is_adult=eq.true&type=neq.Игра'));
console.log("is_adult=true&type=neq.Игра&type=neq.Креатив:", await headCount('is_adult=eq.true&type=neq.Игра&type=neq.Креатив'));

// Поля creative-строк
console.log('\n=== Пример креатив-строки ===');
const res = await fetch(`${SB_URL}/anime_catalog?select=*&type=eq.Креатив&limit=1`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
});
const rows = await res.json();
if (rows[0]) {
  const r = rows[0];
  console.log(JSON.stringify({ vost_id: r.vost_id, title: r.title, type: r.type, is_adult: r.is_adult, source: r.source, embed_url: (r.embed_url || '').slice(0, 60), episodes: r.episodes }, null, 1));
} else console.log('(строк type=Креатив не найдено)');
