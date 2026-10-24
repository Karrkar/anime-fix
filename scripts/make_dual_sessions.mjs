/**
 * make_dual_sessions.mjs — создать на проде две служебные сессии:
 *   1) админ (role=admin)
 *   2) активный подписчик (subscriptions.is_active=true, expires_at>now, role!=admin)
 * Обе печатаются в JSON: { adminToken, subToken, adminEmail, subEmail }
 * Сессии удаляются отдельным вызовом: --cleanup <adminToken> <subToken>
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
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function rf(url, opts = {}) {
  for (let i = 1; i <= 5; i++) {
    try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) }); }
    catch (e) { if (i === 5) throw e; await new Promise(r => setTimeout(r, 2000 * i)); }
  }
}

// ── режим очистки ──
if (process.argv[2] === '--cleanup') {
  for (const t of process.argv.slice(3)) {
    if (!t) continue;
    const d = await rf(`${SB}/rest/v1/sessions?token=eq.${t}`, { method: 'DELETE', headers: H });
    console.error(`cleanup ${t.slice(0, 8)}…: ${d.status}`);
  }
  process.exit(0);
}

// ── 1) админ ──
const uA = await rf(`${SB}/rest/v1/users?select=id,email,role&role=eq.admin&limit=1`, { headers: H });
const uAj = await uA.json();
if (!Array.isArray(uAj)) { console.error('users-ответ не массив:', uA.status, JSON.stringify(uAj).slice(0, 300)); process.exit(1); }
const [admin] = uAj;
if (!admin) { console.error('админ не найден'); process.exit(1); }

// ── 2) активный подписчик: join subscriptions ──
const subs = await rf(`${SB}/rest/v1/subscriptions?select=user_id&is_active=eq.true&expires_at=gt.${new Date().toISOString()}&limit=20`, { headers: H });
const subRows = await subs.json();
if (!subRows?.length) { console.error('активных подписок нет'); process.exit(1); }
const ids = subRows.map(s => `"${s.user_id}"`).join(',');
const users = await rf(`${SB}/rest/v1/users?select=id,email,role&id=in.(${ids})&role=neq.admin&limit=5`, { headers: H });
const cand = await users.json();
if (!cand?.length) { console.error('подписчиков-не-админов нет'); process.exit(1); }

// ── 3) сессии ──
const adminToken = crypto.randomBytes(32).toString('hex');
const subToken = crypto.randomBytes(32).toString('hex');
const iA = await rf(`${SB}/rest/v1/sessions`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: admin.id, token: adminToken }) });
if (iA.status !== 201) { console.error('сессия админа не создана:', iA.status, await iA.text()); process.exit(1); }
const iS = await rf(`${SB}/rest/v1/sessions`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: cand[0].id, token: subToken }) });
if (iS.status !== 201) { console.error('сессия подписчика не создана:', iS.status, await iS.text()); process.exit(1); }

console.log(JSON.stringify({ adminToken, subToken, adminEmail: admin.email, subEmail: cand[0].email }, null, 2));
