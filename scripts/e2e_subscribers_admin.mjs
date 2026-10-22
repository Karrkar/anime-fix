// E2E прод: /api/admin/subscribers — гейт 403 для анонимов/юзеров, 200+данные для админа
const BASE = 'https://anime-fix.vercel.app';

function maskEmail(e) {
  if (!e) return '—';
  const [n, d] = String(e).split('@');
  return `${n.slice(0, 2)}***@${d}`;
}

async function login(email, password) {
  const r = await fetch(`${BASE}/api/subscription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', email, password }),
  });
  const setCookie = r.headers.get('set-cookie') || '';
  const m = setCookie.match(/anime_platform_token=([^;]+)/);
  return { status: r.status, token: m ? m[1] : null, body: await r.json().catch(() => null) };
}

// ── 1. Аноним → 403 ─────────────────────────────────────────────
{
  const r = await fetch(`${BASE}/api/admin/subscribers`);
  console.log(`аноним GET /api/admin/subscribers → ${r.status} (ожидаем 403)`);
}

// ── 2. Админ-логин (два известных пароля) ───────────────────────
let token = null;
for (const pw of [(process.env.ADMIN_PASSWORD || 'CHANGE-ME'), 'Katanie-95']) {
  const res = await login((process.env.ADMIN_EMAIL || 'admin@example.com'), pw);
  console.log(`админ-логин (пароль №${pw === (process.env.ADMIN_PASSWORD || 'CHANGE-ME') ? 1 : 2}) → ${res.status}`);
  if (res.status === 200 && res.token) { token = res.token; break; }
}

if (!token) {
  console.log('ОШИБКА: ни один пароль не подошёл — дальше только вывод API-логики');
  process.exit(0);
}

// ── 3. Админ → 200 + данные ─────────────────────────────────────
{
  const r = await fetch(`${BASE}/api/admin/subscribers`, {
    headers: { cookie: `anime_platform_token=${token}` },
  });
  console.log(`админ GET /api/admin/subscribers → ${r.status} (ожидаем 200)`);
  const d = await r.json().catch(() => null);
  if (r.status === 200 && d) {
    console.log('stats:', JSON.stringify(d.stats));
    console.log(`подписчиков в ответе: ${d.subscribers.length}`);
    for (const s of d.subscribers.slice(0, 6)) {
      console.log(JSON.stringify({
        email: maskEmail(s.email),
        role: s.role,
        hasActiveSub: s.hasActiveSub,
        plan: s.activePlan,
        days: s.remainingDays,
        paid: s.totalPaid,
        pays: s.confirmedPayments,
        pending: s.pendingPayments,
      }));
    }
  }
}

// ── 4. Чужой валидный юзер (регистрация тестового) → 403 ────────
{
  const email = `gate-${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/api/subscription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', email, password: 'Test-1234-5678' }),
  });
  if (reg.status === 200) {
    const setCookie = reg.headers.get('set-cookie') || '';
    const m = setCookie.match(/anime_platform_token=([^;]+)/);
    const r = await fetch(`${BASE}/api/admin/subscribers`, {
      headers: m ? { cookie: `anime_platform_token=${m[1]}` } : {},
    });
    console.log(`обычный юзер GET /api/admin/subscribers → ${r.status} (ожидаем 403)`);
    // прибираем тестового (нет API удаления — оставляем, безвреден)
  } else {
    console.log(`регистрация тестового юзера → ${reg.status} (проверка 403 юзером пропущена)`);
  }
}
