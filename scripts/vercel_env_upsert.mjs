/**
 * vercel_env_upsert.mjs — ВРЕМЕННЫЙ ops-скрипт (запускается из GitHub Actions,
 * см. .github/workflows/r34-env.yml). Идемпотентно создаёт/пересоздаёт env-переменные
 * R34_API_KEY и R34_USER_ID в Vercel-проекте anime-fix (target=production).
 *
 * Значения НЕ печатаются — только длина. Токен/значения приходят через env:
 *   VERCEL_TOKEN  — секрет репозитория GitHub Actions
 *   R34_KEY       — значение R34_API_KEY (из dispatch-инпута)
 *   R34_USER_ID   — значение R34_USER_ID (из dispatch-инпута)
 *   VERCEL_PROJECT_ID / VERCEL_TEAM_ID — константы проекта
 */
const TOKEN = process.env.VERCEL_TOKEN || '';
const TEAM = process.env.VERCEL_TEAM_ID || '';
const PROJECT = process.env.VERCEL_PROJECT_ID || '';
const KEY = process.env.R34_KEY || '';
const UID = process.env.R34_USER_ID || '';

if (!TOKEN || !KEY || !UID || !PROJECT || !TEAM) {
  console.error('MISSING ENV:', JSON.stringify({
    token: !!TOKEN, key: !!KEY, uid: !!UID, project: !!PROJECT, team: !!TEAM,
  }));
  process.exit(2);
}

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const base = `https://api.vercel.com`;
const qs = `teamId=${encodeURIComponent(TEAM)}`;

async function call(method, path, body) {
  const r = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}${qs}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { status: r.status, json, text };
}

// 1) список существующих → удалить старые R34_* (идемпотентный upsert через recreate)
const list = await call('GET', `/v9/projects/${PROJECT}/env`);
if (list.status !== 200) {
  console.error('LIST FAIL', list.status, list.text.slice(0, 300));
  process.exit(1);
}
const envs = list.json?.envs || [];
console.log(`существующих env: ${envs.length} (ключей R34_*: ${envs.filter(e => e.key.startsWith('R34_')).length})`);

for (const name of ['R34_API_KEY', 'R34_USER_ID']) {
  const old = envs.find(e => e.key === name);
  if (old) {
    const del = await call('DELETE', `/v9/projects/${PROJECT}/env/${old.id}`);
    console.log(`DELETE ${name}: ${del.status}`);
    if (del.status !== 200) { console.error('DELETE FAIL', del.text.slice(0, 300)); process.exit(1); }
  }
}

// 2) создать заново (encrypted, production)
for (const [name, value] of [['R34_API_KEY', KEY], ['R34_USER_ID', UID]]) {
  const create = await call('POST', `/v10/projects/${PROJECT}/env`, {
    key: name,
    value,
    type: 'encrypted',
    target: ['production'],
  });
  if (create.status !== 201) {
    console.error(`CREATE ${name} FAIL`, create.status, create.text.slice(0, 300));
    process.exit(1);
  }
  const v = create.json || {};
  console.log(`CREATE ${name}: 201 | target=${(v.target || []).join(',')} | type=${v.type} | valueLen=${String(value).length} | updatedAt=${v.updatedAt || 'n/a'}`);
}

// 3) контрольный список
const after = await call('GET', `/v9/projects/${PROJECT}/env`);
const afterEnvs = (after.json?.envs || []).filter(e => e.key === 'R34_API_KEY' || e.key === 'R34_USER_ID');
console.log('Контроль: R34_* в проекте →', afterEnvs.map(e => `${e.key}(target=${(e.target || []).join(',') || e.target || '?'})`).join(' | '));
if (afterEnvs.length !== 2) {
  console.error('ОЖИДАЛОСЬ 2 ПЕРЕМЕННЫЕ, ЕСТЬ', afterEnvs.length);
  process.exit(1);
}
console.log('OK: R34_API_KEY + R34_USER_ID установлены в Vercel (production).');
