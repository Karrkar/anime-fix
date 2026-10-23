/**
 * ПОЛНЫЙ БЭКФИЛЛ rule34 ЧЕРЕЗ ОФИЦИАЛЬНЫЙ API (api.rule34.xxx, ключ) → живая БД.
 *
 * Заливает ВСЕ посты 14 указанных художников (~143k) прямо в хранилище
 * вкладки «Арты» (sync_status r34_store_<tag>_c<N> + r34_meta_<tag>) через
 * upsertArtistPosts — тот же формат, что пишут клиентский сборщик
 * R34Collector, крон /api/r34-sync и scripts/r34_upload.mjs.
 *
 * ЗАЧЕМ ЭТОТ СКРИПТ, ЕСЛИ ЕСТЬ СБОРЩИК В БРАУЗЕРЕ: api.rule34.xxx доступен
 * и с датацентровых IP (без CF-челленджа — проверено), поэтому полный проход
 * можно делать отсюда: 143 запроса × 1000 постов ≈ 3-4 минуты вместо ручного
 * сбора во вкладке.
 *
 * КРЕДЫ: https://rule34.xxx/index.php?page=account&s=options → API Key.
 *   node --import tsx scripts/r34_dapi_backfill.ts --probe-only            # проверка ключа
 *   node --import tsx scripts/r34_dapi_backfill.ts --api-key КЛЮЧ --user-id 6958536
 *   node --import tsx scripts/r34_dapi_backfill.ts --resume                # докачка неполных
 *   node --import tsx scripts/r34_dapi_backfill.ts --artists balecxi,maldo
 *
 * Идемпотентно: merge-заливка с дедупом по id (upsertArtistPosts), повторный
 * запуск ничего не портит. Чекпоинт каждые ~5000 постов — обрыв теряет мало.
 * Правила API: один ключ, limit ≤ 1000, пауза --rate (1.2с по умолчанию).
 */
import { readFileSync } from 'fs';
import type { ParsedPost } from '../src/lib/client-types';

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

// ── CLI ──────────────────────────────────────────────────────────────────
function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) || def : def;
}
function strArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1].trim() : undefined;
}

const API_KEY = strArg('api-key');
const USER_ID = strArg('user-id');
if (API_KEY) process.env.R34_API_KEY = API_KEY;
if (USER_ID) process.env.R34_USER_ID = USER_ID;

const PROBE_ONLY = process.argv.includes('--probe-only');
const RESUME = process.argv.includes('--resume');
/** Макс страниц (по 1000) на художника за запуск — потолок-страховка */
const MAX_PAGES = arg('pages', 60);
/** Пауза между страницами, мс */
const RATE_MS = arg('rate', 1200);
/** Чекпоинт-заливка при накоплении ~N постов (обрыв теряет мало) */
const FLUSH_POSTS = 5000;

const artistsIdx = process.argv.indexOf('--artists');
const ARTISTS: string[] = artistsIdx > 0 && process.argv[artistsIdx + 1]
  ? process.argv[artistsIdx + 1].split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
  : [];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const KEY = process.env.R34_API_KEY?.trim() || '';
const UID = process.env.R34_USER_ID?.trim() || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

type KeyPage =
  | { status: 'ok'; posts: unknown[] }
  | { status: 'auth_fail' }
  | { status: 'error' };

/** Запрос страницы dapi ТОЛЬКО по официальному ключу (без фолбэков):
 *  различает честную пустую выдачу, отказ аутентификации и сетевую ошибку. */
async function fetchKeyPage(tag: string, pid: number, limit: number, timeoutMs = 25_000): Promise<KeyPage> {
  const url = `https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1`
    + `&limit=${limit}&pid=${pid}&tags=${encodeURIComponent(tag)}`
    + `&user_id=${encodeURIComponent(UID)}&api_key=${encodeURIComponent(KEY)}`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (r.status === 401 || r.status === 403) return { status: 'auth_fail' };
    if (!r.ok) return { status: 'error' };
    const text = (await r.text()).trim();
    if (!text) return { status: 'ok', posts: [] }; // пустая выдача json-режима
    if (!text.startsWith('[')) return { status: 'auth_fail' }; // «Missing authentication…»
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? { status: 'ok', posts: parsed } : { status: 'error' };
    } catch {
      return { status: 'error' };
    }
  } catch {
    return { status: 'error' };
  }
}

async function main() {
  if (!KEY || !UID) {
    console.error('Нет кредов rule34: передайте --api-key КЛЮЧ --user-id ID');
    console.error('(или впишите R34_API_KEY= / R34_USER_ID= в .env.local).');
    console.error('Ключ: https://rule34.xxx/index.php?page=account&s=options');
    process.exit(1);
  }

  const store = await import('../src/lib/r34-store');
  const dapi = await import('../src/lib/r34-dapi');
  const queue = ARTISTS.length ? ARTISTS : [...store.R34_ARTISTS];

  // ── Проверка ключа: один дешёвый запрос ДО долгого цикла ──────────────
  const probe = await fetchKeyPage(queue[0], 0, 1);
  if (probe.status === 'auth_fail') {
    console.error('ОТКАЗ АУТЕНТИФИКАЦИИ: API ответил «Missing authentication»/401/403.');
    console.error('Проверьте ключ в https://rule34.xxx/index.php?page=account&s=options');
    console.error('(user_id и api_key должны быть из ОДНОГО аккаунта).');
    process.exit(1);
  }
  if (probe.status === 'error') {
    console.error('Сетевой отказ при проверке ключа — повторите запуск позже.');
    process.exit(1);
  }
  console.log(`Ключ принят API rule34 (user_id ${UID}).`);

  // ── Состояние художников до прохода ────────────────────────────────────
  const metas: Record<string, Awaited<ReturnType<typeof store.getMeta>>> = {};
  for (const a of queue) metas[a] = await store.getMeta(a);

  console.log(`\nХудожники (${queue.length}): ${queue.join(', ')}`);
  console.log(`Страницы по 1000 постов (потолок ${MAX_PAGES} стр.), пауза ${RATE_MS} мс${RESUME ? ', режим докачки' : ''}\n`);
  console.log('Было до прохода:');
  for (const a of queue) {
    const m = metas[a];
    console.log(`  ${a}: ${m ? `${m.stored_posts}/${m.total_posts} (complete=${m.complete})` : 'нет мета-строки'}`);
  }
  console.log('');

  if (PROBE_ONLY) {
    console.log('--probe-only: заливка не выполнялась.');
    return;
  }

  let grandAdded = 0;
  const t0 = Date.now();

  for (const artist of queue) {
    const meta = metas[artist];
    if (RESUME && meta?.complete) {
      console.log(`  = ${artist}: уже complete (${meta.stored_posts}/${meta.total_posts}) — пропуск`);
      continue;
    }
    const total = meta?.total_posts || 0;
    const ta = Date.now();

    // Определение фактического размера страницы: просим 1000; если сервер
    // отдал меньше — принимаем фактический размер (не все ключи дают 1000).
    // Первая страница имела pid=0 (смещение 0) — продолжение с pid=1 и новым
    // limit даёт непрерывную нумерацию смещений pid*limit без дыр.
    let limit = 1000;
    let collected: ParsedPost[] = [];
    let batchSinceFlush: ParsedPost[] = [];
    let pid = 0;
    let stop = false;
    let authFail = false;

    while (pid < MAX_PAGES && !stop) {
      const r = await fetchKeyPage(artist, pid, limit);
      if (r.status === 'auth_fail') { authFail = true; stop = true; break; }
      if (r.status === 'error') {
        // один повтор страницы — сетевые сбои случаются
        await sleep(3000);
        const r2 = await fetchKeyPage(artist, pid, limit);
        if (r2.status !== 'ok') { stop = true; break; }
        const mapped2 = r2.posts
          .map(p => dapi.mapDapiPost(p as dapi.DapiPost, artist))
          .filter((p): p is ParsedPost => p !== null);
        collected.push(...mapped2);
        batchSinceFlush.push(...mapped2);
        pid++;
        continue;
      }
      if (r.posts.length === 0) { stop = true; break; } // дно

      const mapped = r.posts
        .map(p => dapi.mapDapiPost(p as dapi.DapiPost, artist))
        .filter((p): p is ParsedPost => p !== null);
      collected.push(...mapped);
      batchSinceFlush.push(...mapped);

      // сервер клампит limit ниже запрошенного (первая страница) — дальше
      // работаем с фактическим размером страницы
      if (pid === 0 && r.posts.length < limit) {
        limit = r.posts.length;
        console.log(`  [${artist}] сервер отдаёт ${limit} постов/стр (кламп) — работаем с этим размером`);
      }

      // чекпоинт: накопили батч — льём (merge-заливка безопасна)
      if (batchSinceFlush.length >= FLUSH_POSTS) {
        const res = await store.upsertArtistPosts(artist, batchSinceFlush, total || undefined);
        grandAdded += batchSinceFlush.length;
        batchSinceFlush = [];
        process.stdout.write(`  [${artist}] pid=${pid}: собрано ${collected.length}/${total || '?'}, в базе ${res.stored_posts}\n`);
      }

      if (r.posts.length < limit) { stop = true; break; } // короткая = последняя
      if (total && collected.length >= total) { stop = true; break; }
      pid++;
      await sleep(RATE_MS);
    }

    if (authFail) {
      console.error(`  [${artist}] ОТКАЗ АУТЕНТИФИКАЦИИ на странице ${pid} — стоп всего прогона (ключ отозван?)`);
      process.exit(1);
    }

    // финальная заливка остатка батча
    if (batchSinceFlush.length > 0) {
      const res = await store.upsertArtistPosts(artist, batchSinceFlush, total || undefined);
      grandAdded += batchSinceFlush.length;
      console.log(`  [${artist}] финал: в базе ${res.stored_posts}/${res.total_posts}, complete=${res.complete} (${(Date.now() - ta) / 1000 | 0}с)`);
    } else {
      const fresh = await store.getMeta(artist);
      console.log(`  [${artist}] в базе ${fresh?.stored_posts ?? '?'}/${fresh?.total_posts ?? total}, complete=${fresh?.complete} (${(Date.now() - ta) / 1000 | 0}с)`);
    }
  }

  console.log(`\nИТОГО: обработано +${grandAdded} постов за ${(Date.now() - t0) / 1000 | 0}с`);
  console.log('Вкладка «Арты» читает хранилище напрямую (r34_store_<tag>_c<N>).');
  // сброс серверных кэшей не нужен: r34-store читает БД с 5-минутным кэшем
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
