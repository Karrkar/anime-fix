/**
 * r34_refresh_counts.ts — актуализация счётчиков r34_meta_<tag> после полного
 * бэкфилла: тотал берём из ИСТИННОГО счётчика dapi (XML count), а не из
 * устаревшего autocomplete (цифры playwright-скрейпа 23.10 расходились с
 * фактом: kaistar 6774 vs реально 5810).
 *
 * Дополнительно — лёгкая верификация живой БД: мета-строки + число чанков на
 * художника БЕЗ чтения тяжёлых jsonb (check_r34_state.mjs на 143k постов
 * уходит в statement timeout, т.к. тянет details целиком).
 *
 *   node --import tsx scripts/r34_refresh_counts.ts --api-key КЛЮЧ --user-id 6958536
 *   node --import tsx scripts/r34_refresh_counts.ts --check-only   # без записи
 */
import { readFileSync } from 'fs';

// ── env ДО импорта библиотек (db.ts читает переменные при загрузке) ─────
function loadEnv(path: string): void {
  try {
    const raw = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
      }
    }
  } catch (e) {
    console.error(`Не могу прочитать ${path}:`, e);
    process.exit(1);
  }
}
loadEnv('../.env.local');

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Нет Supabase-кредов в .env.local');
  process.exit(1);
}

function strArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1].trim() : undefined;
}

const API_KEY = strArg('api-key');
const USER_ID = strArg('user-id');
const CHECK_ONLY = process.argv.includes('--check-only');

if (!API_KEY || !USER_ID) {
  console.error('Нужны --api-key КЛЮЧ --user-id ID (или --check-only без записи).');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Истинный счётчик постов тега из XML-dapi (корневой атрибут count). */
async function dapiCount(tag: string): Promise<number | null> {
  const url = `https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&limit=1`
    + `&tags=${encodeURIComponent(tag)}`
    + `&user_id=${encodeURIComponent(USER_ID)}&api_key=${encodeURIComponent(API_KEY!)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/xml' },
        signal: AbortSignal.timeout(20_000),
        cache: 'no-store',
      });
      if (!r.ok) continue;
      const m = (await r.text()).match(/count="(\d+)"/);
      if (m) return Number(m[1]);
      return null;
    } catch { /* ретрай */ }
    await sleep(1500);
  }
  return null;
}

async function main() {
  const store = await import('../src/lib/r34-store');
  const { getDb } = await import('../src/lib/db');
  const db = getDb();

  console.log('=== СЧЁТЧИКИ: было (БД) → dapi-истина → стало ===');
  const problems: string[] = [];
  let sumStored = 0, sumTotal = 0;

  for (const tag of store.R34_ARTISTS) {
    const before = await store.getMeta(tag);
    const truth = await dapiCount(tag);
    await sleep(400); // вежливость к API

    if (CHECK_ONLY || truth === null) {
      const mark = truth === null ? '??' : `${before?.stored_posts ?? '?'}/${truth}`;
      const bad = truth !== null && (before?.complete !== true || (before?.stored_posts ?? 0) < truth);
      if (bad) problems.push(tag);
      console.log(`  ${tag}: ${before?.stored_posts ?? '?'}/${before?.total_posts ?? '?'} (complete=${before?.complete}) | dapi=${truth ?? 'отказ'} ${bad ? '← НЕ ПОЛОН' : ''}`);
      sumStored += before?.stored_posts ?? 0;
      sumTotal += truth ?? before?.total_posts ?? 0;
      continue;
    }

    const after = await store.updateMetaCounts(tag, truth);
    const ok = after && after.complete;
    if (!ok) problems.push(tag);
    console.log(`  ${tag}: ${before?.stored_posts ?? '?'}/${before?.total_posts ?? '?'} → ${after?.stored_posts ?? '?'}/${truth} (complete=${after?.complete})${ok ? '' : ' ← НЕ ПОЛОН'}`);
    sumStored += after?.stored_posts ?? 0;
    sumTotal += truth;
  }

  console.log(`\nИТОГО: в базе ${sumStored} из ${sumTotal} постов по 14 художникам.`);

  // ── Лёгкая верификация чанков: только счётчик рядов, без чтения details ──
  console.log('\n=== ЧАНКИ r34_store_<tag>_c<N> (число рядов на художника) ===');
  for (const tag of store.R34_ARTISTS) {
    const { count, error } = await db
      .from('sync_status')
      .select('source', { count: 'exact', head: true })
      .like('source', `r34_store_${tag}_c%`);
    if (error) { console.log(`  ${tag}: ошибка ${error.message}`); continue; }
    const meta = await store.getMeta(tag);
    const expectChunks = Math.ceil((meta?.stored_posts ?? 0) / store.POSTS_PER_CHUNK);
    console.log(`  ${tag}: ${count} рядов (ожидалось ~${expectChunks}), в базе ${meta?.stored_posts ?? '?'} постов`);
  }

  if (problems.length) {
    console.log(`\nНЕ ПОЛНЫЕ (${problems.length}): ${problems.join(', ')}`);
    console.log('Докатка: node --import tsx scripts/r34_dapi_backfill.ts --api-key КЛЮЧ --user-id ID --resume --artists ' + problems.join(','));
    process.exitCode = 2;
  } else {
    console.log('\nВсе 14 художников complete — вкладка «Арты» обеспечена полностью.');
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
