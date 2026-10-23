/**
 * rule34.xxx dapi — официальный JSON-API (Gelbooru-совместимый), октябрь 2026.
 *
 * ЗАЧЕМ: HTML-список через Jina стоит ~25K токенов за 42 поста и не содержит
 * полного URL картинки (лайтбокс ждал рендер страницы поста 18-22с). dapi
 * отдаёт JSON (~10-13K токенов за 42 поста — в 2-2.5 раза дешевле) и СРАЗУ
 * несёт file_url (полное изображение/видео), preview_url, score, tags,
 * rating. Экономия двойная: токены Jina-ключа и мгновенное открытие артов.
 *
 *   GET /index.php?page=dapi&s=post&q=index&json=1&limit=42&pid=<offset>&tags=<tag>
 *   GET /index.php?page=dapi&s=post&q=index&json=1&id=<postId>
 *
 * ЦЕПОЧКА ЗАГРУЗКИ: прямой запрос (часть egress-IP Vercel проходит CF —
 * бесплатно) → Jina Reader (X-Return-Format: text, с ключом и анонимно).
 * Ответ — массив объектов Gelbooru; пустой массив = тег исчерпан (pid за
 * концом). HTML-мусор/CF-челлендж детектится и считается отказом, а не
 * «пустым тегом» (урок r34-fetch.ts от 03.10: фейковое «пусто» кэшировалось).
 */
import { JINA_READER, R34_BASE } from '@/lib/sources';
import { jinaHeaders, markJinaKeyRejected } from '@/lib/jina';
import type { ParsedPost } from '@/lib/client-types';
import type { R34PostDetail } from '@/lib/r34-store';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface DapiPost {
  id: number;
  preview_url?: string;
  sample_url?: string;
  file_url?: string;
  image?: string;
  directory?: string | number;
  hash?: string;
  width?: number;
  height?: number;
  rating?: string;
  score?: number;
  tags?: string;
  source?: string;
  status?: string;
  parent_id?: number | null;
}

/** Защитный парсинг: Jina иногда оборачивает JSON в ```-фенсы или markdown. */
export function parseDapiJson(text: string): DapiPost[] | null {
  if (!text) return null;
  let t = text.trim();
  // срезаем markdown-обёртки (```json ... ```), если Jina их добавил
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  // ищем первый '[' и последний ']' — JSON-массив постов
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as DapiPost[]) : null;
  } catch {
    return null;
  }
}

/** Нормализация тегов — 1:1 с parseListPage (rule34/route.ts): подчёркивания
 *  в пробелы, дедуп по нижнему регистру. Иначе поиск/чипы UI разъедутся с
 *  HTML-парсером. */
function normalizeTags(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of raw.split(/\s+/)) {
    if (!p) continue;
    const normalized = p.replace(/_/g, ' ');
    if (!seen.has(normalized.toLowerCase())) {
      seen.add(normalized.toLowerCase());
      out.push(normalized);
    }
  }
  return out;
}

function deriveTitle(tags: string[]): string {
  const charTags = tags.filter(t => t.includes('('));
  if (charTags.length > 0) return charTags.slice(0, 2).map(c => c.replace(/ \(.*\)$/, '')).join(', ');
  return tags.slice(0, 3).join(', ');
}

/** Маппинг dapi-поста в формат грида (совместим с HTML-парсером списков). */
export function mapDapiPost(p: DapiPost, searchTag: string): ParsedPost | null {
  if (!p || !Number.isFinite(Number(p.id))) return null;
  const tags = normalizeTags(p.tags || '');
  const searchTagLower = searchTag.toLowerCase().replace(/_/g, ' ');
  const artistTag = tags.find(t => t.toLowerCase() === searchTagLower) ||
    tags.find(t => !t.includes('(') && t !== '1girl' && t !== '1boy' && !t.startsWith('ai ')) || '';
  const fileUrl = (p.file_url || '').replace(/&amp;/g, '&');
  const previewUrl = (p.preview_url || p.sample_url || '').replace(/&amp;/g, '&');
  // Видео-пост: прямое расширение файла ИЛИ тег animated (посты .gif/.mp4
  // rule34 помечает им; миниатюра видео лежит в /videos/)
  const isVideo =
    /\.(mp4|webm)(?:\?|$)/i.test(fileUrl) ||
    /\.(mp4|webm)(?:\?|$)/i.test(p.image || '') ||
    previewUrl.includes('/videos/') ||
    tags.some(t => t.toLowerCase() === 'animated');
  return {
    id: String(p.id),
    thumbnailUrl: previewUrl,
    tags,
    artist: artistTag || 'Unknown',
    characters: tags.filter(t => t.includes('(') && !t.includes('fate') && !t.includes('series')).map(c => c.replace(/ \(.*\)$/, '')),
    score: Number(p.score) || 0,
    rating: p.rating || 'explicit',
    title: deriveTitle(tags),
    postUrl: `${R34_BASE}/index.php?page=post&s=view&id=${p.id}`,
    isVideo: isVideo || undefined,
    fullUrl: fileUrl || undefined,
  };
}

function dapiListUrl(tag: string, pid: number, limit: number): string {
  return `${R34_BASE}/index.php?page=dapi&s=post&q=index&json=1&limit=${limit}&pid=${pid}&tags=${encodeURIComponent(tag)}`;
}

async function jinaFetchJson(targetUrl: string, timeoutMs: number): Promise<DapiPost[] | null> {
  // X-Return-Format: text — JSON без markdown-обёртки (html-режим оборачивает)
  const headers = jinaHeaders({ Accept: 'application/json', 'X-Return-Format': 'text' });
  const withKey = 'Authorization' in headers;
  const r = await fetch(JINA_READER + encodeURIComponent(targetUrl), {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (r.status === 401 || r.status === 402) {
    // ключ отвергнут (баланс/аутентификация) — немедленный анонимный ретрай
    if (withKey) {
      markJinaKeyRejected(r.status);
      const anon = jinaHeaders({ Accept: 'application/json', 'X-Return-Format': 'text' });
      const r2 = await fetch(JINA_READER + encodeURIComponent(targetUrl), {
        headers: anon,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r2.ok) return parseDapiJson(await r2.text());
      return null;
    }
    return null;
  }
  if (!r.ok) return null;
  return parseDapiJson(await r.text());
}

async function directFetchJson(targetUrl: string, timeoutMs: number): Promise<DapiPost[] | null> {
  const r = await fetch(targetUrl, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) return null;
  return parseDapiJson(await r.text());
}

export interface DapiFetchOpts {
  /** Попыток Jina (сначала всегда 1 прямой запрос). */
  jinaAttempts?: number;
  timeoutMs?: number;
  /** Пропустить прямой запрос (уже знаем, что egress под баном). */
  skipDirect?: boolean;
  /** Постов за запрос (42 = страница грида; с ключом API до 1000). */
  limit?: number;
}

export interface DapiResult {
  posts: ParsedPost[];
  /** Честная пустота (тег исчерпан / нет постов) — не ошибка. */
  empty: boolean;
  /** Какой транспорт сработал: 'key-api' | 'direct' | 'jina' | null. */
  via: 'key-api' | 'direct' | 'jina' | null;
}

/** Страница списка тега через dapi. Приоритет: официальный api.rule34.xxx
 *  с env-ключом (без CF, limit до 1000, бесплатно) → прямой запрос к
 *  главному хосту (часть egress-IP проходит CF) → Jina Reader.
 *  null-результат невозможен: отказ всех транспортов = { posts: [], empty:
 *  false, via: null }. */
export async function fetchDapiPage(tag: string, pid: number, opts: DapiFetchOpts = {}): Promise<DapiResult> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const jinaAttempts = Math.max(0, Math.min(opts.jinaAttempts ?? 1, 3));
  const limit = Math.max(1, Math.min(opts.limit ?? 42, 1000));
  const url = dapiListUrl(tag, pid, limit);

  // 0) Официальный путь: api.rule34.xxx с ключом пользователя (бесплатный
  //    ключ rule34: аккаунт → account options → API key; env R34_USER_ID +
  //    R34_API_KEY). Отдельный хост без CF-челленджа — единственный путь,
  //    который тянет ПОЛНУЮ историю (1000 постов/запрос) с сервера.
  const apiKey = process.env.R34_API_KEY?.trim();
  const userId = process.env.R34_USER_ID?.trim();
  if (apiKey && userId) {
    try {
      const keyUrl = `https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1&limit=${limit}&pid=${pid}&tags=${encodeURIComponent(tag)}&user_id=${encodeURIComponent(userId)}&api_key=${encodeURIComponent(apiKey)}`;
      const r = await fetch(keyUrl, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) {
        const text = await r.text();
        const posts = parseDapiJson(text);
        if (posts) {
          return { posts: posts.map(p => mapDapiPost(p, tag)).filter((p): p is ParsedPost => p !== null), empty: posts.length === 0, via: 'key-api' };
        }
      }
      // 401/403 = ключ неверный/отозван — тихо падаем на обычную цепочку
    } catch { /* сеть — на обычную цепочку */ }
  }

  if (!opts.skipDirect) {
    try {
      const direct = await directFetchJson(url, Math.min(timeoutMs, 8_000));
      if (direct) return { posts: direct.map(p => mapDapiPost(p, tag)).filter((p): p is ParsedPost => p !== null), empty: direct.length === 0, via: 'direct' };
    } catch { /* egress под CF-челленджем — идём в Jina */ }
  }

  for (let i = 0; i < jinaAttempts; i++) {
    try {
      const posts = await jinaFetchJson(url, timeoutMs);
      if (posts) {
        return { posts: posts.map(p => mapDapiPost(p, tag)).filter((p): p is ParsedPost => p !== null), empty: posts.length === 0, via: 'jina' };
      }
    } catch { /* ретрай */ }
    if (i < jinaAttempts - 1) await new Promise(r => setTimeout(r, 1_200));
  }
  return { posts: [], empty: false, via: null };
}

/** Деталка одного поста через dapi (id=...) — полный URL без рендера страницы. */
export async function fetchDapiPostById(postId: string, opts: DapiFetchOpts = {}): Promise<R34PostDetail | null> {
  const timeoutMs = opts.timeoutMs ?? 12_000;

  const fromDapi = (posts: DapiPost[]): R34PostDetail | null => {
    const p = posts.find(x => String(x.id) === String(postId));
    if (!p) return null;
    const fileUrl = (p.file_url || '').replace(/&amp;/g, '&');
    const isVideo = /\.(mp4|webm)(?:\?|$)/i.test(fileUrl);
    return {
      id: String(p.id),
      imageUrl: fileUrl,
      isVideo,
      postUrl: `${R34_BASE}/index.php?page=post&s=view&id=${p.id}`,
      tags: normalizeTags(p.tags || ''),
      score: Number(p.score) || 0,
    };
  };

  // Официальный api.rule34.xxx с ключом — самый быстрый путь
  const apiKey = process.env.R34_API_KEY?.trim();
  const userId = process.env.R34_USER_ID?.trim();
  if (apiKey && userId) {
    try {
      const r = await fetch(`https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1&id=${encodeURIComponent(postId)}&user_id=${encodeURIComponent(userId)}&api_key=${encodeURIComponent(apiKey)}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) {
        const posts = parseDapiJson(await r.text());
        if (posts) return fromDapi(posts);
      }
    } catch { /* на обычную цепочку */ }
  }

  const url = `${R34_BASE}/index.php?page=dapi&s=post&q=index&json=1&id=${encodeURIComponent(postId)}`;

  if (!opts.skipDirect) {
    try {
      const direct = await directFetchJson(url, Math.min(timeoutMs, 8_000));
      if (direct) return fromDapi(direct);
    } catch { /* в Jina */ }
  }
  try {
    const posts = await jinaFetchJson(url, timeoutMs);
    if (posts) return fromDapi(posts);
  } catch { /* отказ */ }
  return null;
}
