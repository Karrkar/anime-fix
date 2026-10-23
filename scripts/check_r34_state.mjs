/**
 * Состояние вкладки «Арты» в живой Supabase-БД: r34_store-чанки, мета-строки,
 * danbooru-строки, курсоры цепочек. Запуск из корня репо:
 *   node /home/z/my-project/scripts/check_r34_state.mjs
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const env = {};
for (const line of readFileSync('/home/z/my-project/anime-fix-src/repo/.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: rows, error } = await db
  .from('sync_status')
  .select('source, details, last_run_at, last_status, new_items')
  .or('source.like.r34%,source.like.danbooru%')
  .range(0, 1000);
if (error) { console.error('DB error:', error.message); process.exit(1); }

const chunks = {};   // tag -> {count, posts}
const meta = {};     // tag -> meta
let other = [];
for (const r of rows || []) {
  const d = r.details || {};
  let m;
  if ((m = r.source.match(/^r34_store_(.+)_c(\d+)$/))) {
    const tag = m[1];
    chunks[tag] = chunks[tag] || { count: 0, posts: 0 };
    chunks[tag].count++;
    chunks[tag].posts += Array.isArray(d.posts) ? d.posts.length : 0;
  } else if ((m = r.source.match(/^r34_meta_(.+)$/))) {
    meta[m[1]] = { total: d.total_posts, stored: d.stored_posts, complete: d.complete, pages: d.stored_pages, run: r.last_run_at };
  } else {
    other.push({ source: r.source, posts: Array.isArray(d.posts) ? d.posts.length : (d.next_page !== undefined ? `page=${d.next_page} done=${d.done}` : '—'), run: (r.last_run_at || '').slice(0, 16), status: r.last_status });
  }
}

console.log('=== r34_store ЧАНКИ (залитые посты по художникам) ===');
let totalChunkPosts = 0;
for (const [tag, c] of Object.entries(chunks)) {
  totalChunkPosts += c.posts;
  console.log(`  ${tag}: ${c.count} чанков, ${c.posts} постов`);
}
console.log(`  ИТОГО в чанках: ${totalChunkPosts} постов`);

console.log('\n=== r34_meta (счётчики источников) ===');
for (const [tag, m] of Object.entries(meta)) {
  console.log(`  ${tag}: всего ${m.total ?? '?'}, залито ${m.stored ?? '?'}, complete=${m.complete}, run=${m.run}`);
}

console.log('\n=== прочие r34/danbooru строки ===');
for (const o of other.slice(0, 40)) {
  console.log(`  ${o.source}: ${JSON.stringify(o.posts)} | ${o.run} | ${o.status}`);
}
if (other.length > 40) console.log(`  … и ещё ${other.length - 40}`);

// свежесть: последние строки по времени
const sorted = [...(rows || [])].sort((a, b) => (b.last_run_at || '').localeCompare(a.last_run_at || ''));
console.log('\n=== 5 самых свежих прогонов ===');
for (const r of sorted.slice(0, 5)) console.log(`  ${r.source}: ${r.last_run_at} (${r.last_status})`);
