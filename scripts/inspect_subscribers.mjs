// Инспекция подписчиков через Supabase REST (PostgREST), без зависимостей
const URL = 'https://uymeyfnuxfbkwisggzdt.supabase.co/rest/v1';
const KEY = process.env.SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function maskEmail(e) {
  if (!e) return '—';
  const [name, domain] = String(e).split('@');
  const m = name.length <= 2 ? name[0] + '*' : name.slice(0, 2) + '***';
  return `${m}@${domain || ''}`;
}

async function get(table, search = '') {
  const res = await fetch(`${URL}/${table}${search}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  const j = await res.json().catch(() => null);
  const cr = res.headers.get('content-range'); // "0-14/57"
  const total = cr ? Number(cr.split('/')[1]) : null;
  return { status: res.status, total, rows: Array.isArray(j) ? j : j };
}

console.log('=== COUNTS ===');
for (const t of ['users', 'sessions', 'subscriptions', 'payments']) {
  const r = await get(t, `?select=*`);
  console.log(`${t}: ${r.total ?? r.status}`);
}

console.log('\n=== SUBSCRIPTIONS (последние 15) ===');
{
  const r = await get('subscriptions', `?select=*&order=activated_at.desc&limit=15`);
  if (r.rows?.length) console.log('columns:', Object.keys(r.rows[0]).join(', '));
  for (const row of r.rows || []) console.log(JSON.stringify(row));
}

console.log('\n=== PAYMENTS (последние 15) ===');
{
  const r = await get('payments', `?select=*&order=id.desc&limit=15`);
  if (r.rows?.length) console.log('columns:', Object.keys(r.rows[0]).join(', '));
  for (const row of r.rows || []) {
    const c = { ...row };
    if (c.payment_label) c.payment_label = c.payment_label.slice(0, 20) + '…';
    console.log(JSON.stringify(c));
  }
}

console.log('\n=== Пользователи с подписками ===');
{
  const subs = await get('subscriptions', `?select=user_id&limit=1000`);
  const ids = [...new Set((subs.rows || []).map(s => s.user_id))];
  console.log('уникальных пользователей с подписками:', ids.length);
  if (ids.length) {
    const idList = ids.map(i => `"${i}"`).join(',');
    const users = await get('users', `?select=id,email,role,created_at&id=in.(${idList})`);
    for (const u of users.rows || []) console.log(JSON.stringify({ ...u, email: maskEmail(u.email) }));
  }
}

console.log('\n=== ВСЕ пользователи (маскированы, последние 30) ===');
{
  const r = await get('users', `?select=id,email,role,created_at&order=created_at.desc&limit=30`);
  if (r.rows?.length) console.log('columns:', Object.keys(r.rows[0]).join(', '));
  for (const u of r.rows || []) console.log(JSON.stringify({ ...u, email: maskEmail(u.email) }));
}
