/**
 * ЗАЛИВЩИК rule34-постов из NDJSON скрейпа в Supabase (sync_status).
 *
 * Использование (из репо, ключи берутся из .env.local):
 *   node scripts/r34_upload.mjs            # все художники из ../r34-data
 *   node scripts/r34_upload.mjs arzagod    # один художник
 *
 * Идемпотентно: пересобирает чанки целиком (r34_store_<tag>_c<N>) и
 * обновляет мету (r34_meta_<tag>) с точным счётчиком из autocomplete.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const DATA_DIR = process.env.R34_DATA_DIR || '/home/z/my-project/r34-data';
const TAGS = ['arzagod', 'balecxi', 'kaistar', 'kinkimya', 'rognezart', 'hypet',
  'backdoorsenpai', 'milfhunter228', 'futarush', 'kiraamane', 'aliusnext',
  'meitabuu', 'maldo', 'duxvector'];
const PER_PAGE = 42;
const PAGES_PER_CHUNK = 10;
const POSTS_PER_CHUNK = PER_PAGE * PAGES_PER_CHUNK;

// Ключи из .env.local репозитория
const env = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const SB_URL = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.*)/)[1].trim();
const SB_KEY = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)[1].trim();

async function sbUpsert(row) {
  const r = await fetch(`${SB_URL}/rest/v1/sync_status?on_conflict=source`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`upsert ${row.source}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
}

async function fetchCount(tag) {
  try {
    const r = await fetch(`https://api.rule34.xxx/autocomplete.php?q=${encodeURIComponent(tag)}`, {
      headers: { 'User-Agent': 'AnimePlatformaSyncChain/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return 0;
    const list = await r.json();
    const m = (list.find(x => x.value === tag) || {}).label?.match(/\((\d+)\)/);
    return m ? parseInt(m[1], 10) : 0;
  } catch { return 0; }
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : TAGS;

for (const tag of wanted) {
  const ndjson = path.join(DATA_DIR, `${tag}.ndjson`);
  if (!fs.existsSync(ndjson)) { console.log(`${tag}: нет ${ndjson} — пропуск`); continue; }
  const lines = fs.readFileSync(ndjson, 'utf8').split('\n').filter(Boolean);
  const seen = new Set();
  const posts = [];
  for (const line of lines) {
    try {
      const p = JSON.parse(line);
      if (p.id && !seen.has(p.id) && typeof p.thumbnailUrl === 'string') {
        seen.add(p.id);
        posts.push(p);
      }
    } catch { /* битая строка — мимо */ }
  }
  const count = await fetchCount(tag);
  const now = new Date().toISOString();

  const chunkCount = Math.ceil(posts.length / POSTS_PER_CHUNK) || 1;
  for (let c = 0; c < chunkCount; c++) {
    const chunkPosts = posts.slice(c * POSTS_PER_CHUNK, (c + 1) * POSTS_PER_CHUNK);
    await sbUpsert({
      source: `r34_store_${tag}_c${c}`,
      last_run_at: now,
      last_status: 'ok',
      new_items: chunkPosts.length,
      updated_items: 0,
      details: { tag, chunk: c, posts: chunkPosts, saved_at: now },
      error: null,
    });
  }

  const meta = {
    tag,
    total_posts: count > 0 ? count : posts.length,
    total_pages: Math.max(1, Math.ceil((count > 0 ? count : posts.length) / PER_PAGE)),
    stored_posts: posts.length,
    stored_pages: Math.ceil(posts.length / PER_PAGE),
    complete: count > 0 ? posts.length >= count : false,
    updated_at: now,
  };
  await sbUpsert({
    source: `r34_meta_${tag}`,
    last_run_at: now,
    last_status: 'ok',
    new_items: posts.length,
    updated_items: 0,
    details: meta,
    error: null,
  });
  console.log(`${tag}: залито ${posts.length}/${count || '?'} постов (${chunkCount} чанков)${meta.complete ? ' — ПОЛНОСТЬЮ' : ''}`);
}
console.log('Готово.');
