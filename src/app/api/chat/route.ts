import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/with-rate-limit';
import { checkAdultAccess } from '@/lib/adult-access';
import { getDb } from '@/lib/db';
import { logEvent } from '@/lib/logger';
import {
  buildSystemPrompt, buildCatalogHint, engineReply, sanitizeProfile, extractProfileDelta,
  type ChatMsg, type RecTitle, type LilithProfile,
} from '@/lib/succubus';
import { preferRussianTitle } from '@/lib/anime-utils';

/**
 * POST /api/chat — чат с Лилит (суккуб-хранительница платформы).
 *
 * Провайдеры ответа (по приоритету):
 *   1. LLM_API_KEY (+ LLM_BASE_URL, LLM_MODEL) — любой OpenAI-совместимый API
 *      (OpenAI / Groq / OpenRouter / Google-совместимость и т.п.).
 *   2. Встроенный движок lib/succubus.ts — интенты + отражение слов + реальные
 *      рекомендации из anime_catalog.
 *
 * Размещение: только вкладка «Лилит» в разделе 18+ → POST закрыт тем же
 * серверным гейтом, что и весь adult-контент (возрастная cookie + подписка/админ).
 * Злоупотребления гасит rate-limit 12 req/мин с IP (RATE_LIMITS['/api/chat']).
 *
 * Память: клиент присылает profile {name, favGenres, favTitles, facts}
 * (строго санитизируется whitelist-ом), сервер дополняет его дельтой
 * extractProfileDelta() из последней реплики и возвращает в profileDelta —
 * клиент накапливает профиль в localStorage между сессиями.
 */

const MAX_HISTORY = 16;
const MAX_MSG_LEN = 1200;
const STATIC_RECS: RecTitle[] = [
  { title: 'Ван-Пис', genres: 'приключения, фэнтези, сёнэн' },
  { title: 'Клинок, рассекающий демонов', genres: 'приключения, фэнтези, сёнэн' },
  { title: 'Магическая битва', genres: 'сёнэн, мистика' },
  { title: 'Атака титанов', genres: 'драма, фэнтези' },
  { title: 'Твоё имя', genres: 'романтика, драма' },
  { title: 'Великий притворщик', genres: 'комедия, повседневность' },
  { title: 'Тетрадь смерти', genres: 'триллер, детектив' },
  { title: 'Стальной алхимик', genres: 'приключения, фэнтези, драма' },
];

let recsCache: { at: number; data: RecTitle[] } | null = null;
const RECS_TTL = 10 * 60 * 1000;

async function loadRecs(): Promise<RecTitle[]> {
  if (recsCache && Date.now() - recsCache.at < RECS_TTL) return recsCache.data;
  try {
    const db = getDb();
    const { data, error } = await db
      .from('anime_catalog')
      .select('vost_id, title_russian, title, genres')
      .eq('is_adult', false)
      .order('views', { ascending: false })
      .limit(60);
    if (error) throw error;
    const rows: RecTitle[] = (data || []).map((r: Record<string, unknown>) => ({
      id: r.vost_id as number,
      title: preferRussianTitle(r as Record<string, unknown>).title,
      genres: r.genres as string,
    })).filter(r => !!r.title);
    const picked = rows.length >= 5 ? rows : STATIC_RECS;
    recsCache = { at: Date.now(), data: picked };
    return picked;
  } catch {
    return STATIC_RECS;
  }
}

function sanitizeIncoming(raw: unknown): ChatMsg[] | null {
  if (!Array.isArray(raw)) return null;
  const msgs: ChatMsg[] = [];
  for (const m of raw.slice(-MAX_HISTORY)) {
    if (!m || typeof m !== 'object') return null;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== 'user' && role !== 'assistant') return null;
    if (typeof content !== 'string' || content.length > MAX_MSG_LEN) return null;
    msgs.push({ role, content: content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, MAX_MSG_LEN) });
  }
  return msgs;
}

async function callLlm(system: string, history: ChatMsg[]): Promise<string | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000); // серверлесс-бюджет
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, ...history],
        max_tokens: 300,
        temperature: 0.95,
        presence_penalty: 0.6, // живее: меньше склонность повторяться
      }),
      signal: controller.signal,
    });
    if (!r.ok) {
      // Тело ошибки в лог: 404=model_not_found, 401=ключ, 403=регион/квота —
      // без тела причина не диагностируется
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch { /* ignore */ }
      logEvent('chat_llm_http_error', { status: r.status, detail }, 'warn');
      return null;
    }
    const d = await r.json();
    const text = d?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim().slice(0, 1500) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function chatHandler(req: NextRequest) {
  // Чат Лилит доступен только внутри раздела 18+: возрастная cookie + подписка
  const access = await checkAdultAccess(req, '/api/chat');
  if (!access.ok) return access.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }
  const rawMessages = (body as { messages?: unknown })?.messages;
  const history = sanitizeIncoming(rawMessages);
  if (!history || !history.length) {
    return NextResponse.json({ error: 'Пустой или некорректный чат' }, { status: 400 });
  }

  const lastUser = [...history].reverse().find(m => m.role === 'user');
  if (!lastUser || !lastUser.content.trim()) {
    return NextResponse.json({ error: 'Нет текста сообщения' }, { status: 400 });
  }

  // Профиль-память от клиента (имя, любимые жанры/тайтлы) — строго санитизируем
  const profile: LilithProfile = sanitizeProfile((body as { profile?: unknown })?.profile);

  const recs = await loadRecs();
  // Что Лилит выносит из реплики — клиент вольёт в профиль и пришлёт обратно
  const profileDelta = extractProfileDelta(lastUser.content, recs);

  // 1) Полноценный LLM, если настроен ключ
  if (process.env.LLM_API_KEY) {
    const llmReply = await callLlm(buildSystemPrompt(buildCatalogHint(recs), profile), history);
    if (llmReply) return NextResponse.json({ reply: llmReply, source: 'llm', profileDelta });
    logEvent('chat_llm_fallback_engine', {}, 'warn');
  }

  // 2) Встроенный живой движок
  const reply = engineReply(lastUser.content, { history: history.slice(-8), recs, profile });
  return NextResponse.json({ reply, source: 'engine', profileDelta });
}

export const GET = () => NextResponse.json({ ok: true, name: 'Лилит', hint: 'POST { messages: [{role, content}] }' });
export const POST = withRateLimit(chatHandler, '/api/chat');
