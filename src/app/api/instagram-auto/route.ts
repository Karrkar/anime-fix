/**
 * АВТОПОСТЕР INSTAGRAM (крон, задача «посты в инстаграм автоматически»).
 *
 * GET /api/instagram-auto[?force=1]
 *
 * Авторизация: Vercel Cron (Bearer CRON_SECRET) / ?secret= / админ-сессия.
 *
 * Что делает при каждом запуске:
 *   1) Берёт токен (env INSTAGRAM_ACCESS_TOKEN, либо свежий продлённый из
 *      rate_limits /ig/token — автопостер сам продлевает токен, см. либу).
 *   2) Пейсинг: не чаще одного поста в 34 часа (крон ежедневный, фактически
 *      пост выходит примерно через день). ?force=1 (админ/секрет) — вне очереди.
 *   3) Выбирает аниме: свежее (обновлённое за 14 дней), не 18+, с обложкой,
 *      ещё не публиковавшееся; при исчерпании — популярное из всего каталога.
 *   4) Подпись: LLM-копирайтер (если настроен) или шаблон; ссылка на страницу
 *      тайтла + хэштеги жанров.
 *   5) Обложка — через оптимизатор нашего домена (/_next/image?w=1080):
 *      гарантированный размер для Instagram и доступность для серверов Meta.
 *   6) Публикует через Instagram Graph API, пишет состояние в rate_limits
 *      (/ig/posted/<vost_id>), шлёт уведомление в Telegram владельцу.
 *
 * Требования к аккаунту (без них вернёт configured:false с инструкцией):
 * Instagram Professional (Business/Creator) + привязка к Facebook-странице +
 * токен с instagram_content_publish (см. download/инструкция-instagram.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDb, authFromRequest } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { logEvent } from '@/lib/logger';
import { notifyTelegram } from '@/lib/notify';
import {
  resolveInstagramIdentity,
  refreshInstagramToken,
  publishInstagramImage,
  isTokenError,
  extractHashtags,
  buildFallbackCaption,
  buildCoverUrl,
  SITE_URL,
  type CatalogRow,
} from '@/lib/instagram';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Пауза между постами, часов (крон ежедневный → пост раз в ~1.5 дня). */
const PACE_HOURS = 34;
/** Свежесть тайтла для приоритетного отбора, дней. */
const FRESH_DAYS = 14;
/** Сколько прошлых постов помним для защиты от повторов. */
const POSTED_MEMORY = 150;

/** Подпись через LLM-копирайтера (провайдер настраивается env LLM_*). */
async function buildLlmCaption(a: CatalogRow, fallback: string): Promise<string> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return fallback;
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  const title = (a.title_russian || a.title || '').trim();
  const desc = (a.description || '').replace(/\s+/g, ' ').trim().slice(0, 600);

  const system =
    'Ты — SMM-копирайтер аниме-платформы Anime Platforma. Пиши по-русски короткий ' +
    'продающий пост про аниме для Instagram: 2-3 живых предложения (о чём тайтл, чем цепляет), ' +
    '1-2 эмодзи. БЕЗ хэштегов, БЕЗ ссылок, БЕЗ markdown — только чистый текст поста.';
  const user =
    `Название: ${title} (${a.year || ''})\nТип: ${a.type || ''}\nЖанры: ${a.genres || ''}\n` +
    `Рейтинг: ${a.score || '—'}/100\nОписание: ${desc || '(нет описания — придумай завязку по названию и жанрам, без выдумки фактов)'}`;

  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: 400,
        temperature: 0.8,
        ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return fallback;
    const d = await r.json();
    const text = d?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) return fallback;

    const tags = extractHashtags(a.genres);
    const caption =
      `🎬 ${title}\n\n${text.trim()}\n\n▶ Смотреть бесплатно: ${SITE_URL}/anime/db-${a.vost_id}\n\n` +
      ['#аниме', '#смотретьаниме', ...tags, '#анимеонлайн'].join(' ');
    return caption.length > 2150 ? caption.slice(0, 2149) + '…' : caption;
  } catch {
    return fallback;
  }
}

/** Свежий продлённый токен из rate_limits (заменяет env-значение после первого refresh). */
async function loadStoredToken(db: ReturnType<typeof getDb>): Promise<string | null> {
  try {
    const { data } = await db
      .from('rate_limits')
      .select('bucket_key, ip, created_at')
      .like('bucket_key', '/ig/token/%')
      .order('created_at', { ascending: false })
      .limit(1);
    const row = data?.[0];
    if (!row) return null;
    const parsed = JSON.parse(row.ip || '{}') as { token?: string };
    return parsed.token || null;
  } catch {
    return null;
  }
}

async function storeToken(db: ReturnType<typeof getDb>, token: string): Promise<void> {
  try {
    await db.from('rate_limits').insert({
      bucket_key: `/ig/token/${Date.now()}`,
      ip: JSON.stringify({ token }).slice(0, 500),
    });
  } catch { /* хранение продлённого токена — best effort */ }
}

async function igTelemetry(db: ReturnType<typeof getDb>, verdict: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await db.from('rate_limits').insert({
      bucket_key: `/ig/${verdict}/${Date.now()}`,
      ip: JSON.stringify(payload).slice(0, 500),
    });
  } catch { /* телеметрия не должна ломать автопостер */ }
}

async function instagramAutoHandler(request: NextRequest) {
  const db = getDb();
  const { searchParams } = new URL(request.url);
  const force = searchParams.get('force') === '1';

  // ── Авторизация: крон / секрет / админ ─────────────────────────────────
  const isAdmin = (await authFromRequest(request))?.role === 'admin';
  if (!isCronAuthorized(request) && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // ── 1. Токен ────────────────────────────────────────────────────────────
  let token = process.env.INSTAGRAM_ACCESS_TOKEN || '';
  if (!token) {
    return NextResponse.json({
      configured: false,
      ok: false,
      note: 'Добавьте INSTAGRAM_ACCESS_TOKEN в Vercel env (инструкция: download/инструкция-instagram.md) и перезапустите деплой',
    });
  }
  const stored = await loadStoredToken(db);
  if (stored && stored !== token) token = stored; // продлённый токен новее env

  try {
    // ── 2. Пейсинг ────────────────────────────────────────────────────────
    if (!force) {
      const { data: lastPosts } = await db
        .from('rate_limits')
        .select('created_at')
        .like('bucket_key', '/ig/posted/%')
        .order('created_at', { ascending: false })
        .limit(1);
      const last = lastPosts?.[0]?.created_at;
      if (last) {
        const ageH = (Date.now() - new Date(last).getTime()) / 36e5;
        if (ageH < PACE_HOURS) {
          return NextResponse.json({
            ok: true,
            skipped: 'pacing',
            note: `Последний пост ${ageH.toFixed(1)}ч назад; следующий не раньше чем через ${(PACE_HOURS - ageH).toFixed(1)}ч (?force=1 — вне очереди)`,
          });
        }
      }
    }

    // ── 3. Кандидаты: свежие, не 18+, с обложкой ──────────────────────────
    const { data: postedRows } = await db
      .from('rate_limits')
      .select('bucket_key')
      .like('bucket_key', '/ig/posted/%')
      .order('created_at', { ascending: false })
      .limit(POSTED_MEMORY);
    const posted = new Set(
      (postedRows || []).map((r) => (r.bucket_key || '').replace('/ig/posted/', '')),
    );

    const freshIso = new Date(Date.now() - FRESH_DAYS * 24 * 3600 * 1000).toISOString();
    const select = 'vost_id,title,title_russian,description,image_url,genres,score,year,type,updated_at';
    const { data: fresh } = await db
      .from('anime_catalog')
      .select(select)
      .eq('is_adult', false)
      .neq('image_url', '')
      .gte('updated_at', freshIso)
      .order('score', { ascending: false })
      .limit(60);
    let candidate = ((fresh || []) as CatalogRow[]).find((a) => !posted.has(String(a.vost_id))) || null;

    // Фолбэк: популярное из всего каталога (свежее исчерпано)
    if (!candidate) {
      const { data: popular } = await db
        .from('anime_catalog')
        .select(select)
        .eq('is_adult', false)
        .neq('image_url', '')
        .order('views', { ascending: false })
        .limit(60);
      candidate = ((popular || []) as CatalogRow[]).find((a) => !posted.has(String(a.vost_id))) || null;
    }
    if (!candidate) {
      await igTelemetry(db, 'fail', { reason: 'no_candidates' });
      return NextResponse.json({ ok: false, reason: 'Подходящих тайтлов не найдено' });
    }

    const title = (candidate.title_russian || candidate.title || '').trim();

    // ── 4. Подпись (LLM → шаблон) и обложка ──────────────────────────────
    const fallback = buildFallbackCaption(candidate);
    const caption = await buildLlmCaption(candidate, fallback);
    const cover = buildCoverUrl(candidate.image_url || '');

    // ── 5. Публикация ─────────────────────────────────────────────────────
    const identity = await resolveInstagramIdentity(token);
    const { mediaId, permalink } = await publishInstagramImage({
      token,
      identity,
      imageUrl: cover,
      caption,
    });

    // Состояние: тайтл опубликован
    await db.from('rate_limits').insert({
      bucket_key: `/ig/posted/${candidate.vost_id}`,
      ip: JSON.stringify({ mediaId, permalink, title, at: new Date().toISOString() }).slice(0, 500),
    });
    await igTelemetry(db, 'ok', { vost_id: candidate.vost_id, title, mediaId, permalink });

    logEvent('instagram_auto_posted', { vost_id: candidate.vost_id, title, mediaId }, 'info');
    void notifyTelegram(
      `📸 Автопост в Instagram: «${title}»\n${permalink || '(ссылка появится через пару минут)'}\nАккаунт: @${identity.username}`,
    );

    // ── 6. Продление токена (кроме facebook-схемы) ────────────────────────
    const fresh2 = await refreshInstagramToken(token);
    if (fresh2) await storeToken(db, fresh2);

    return NextResponse.json({
      ok: true,
      posted: { title, vost_id: candidate.vost_id, mediaId, permalink, account: identity.username },
      caption,
      cover,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await igTelemetry(db, 'fail', { reason: 'api', error: msg.slice(0, 300) });
    logEvent('instagram_auto_error', { error: msg.slice(0, 300) }, 'error');
    if (isTokenError(e)) {
      // Токен истёк/отозван — без владельца не починить, кричим в Telegram
      void notifyTelegram(
        `⚠️ Instagram автопостер: проблема с токеном (${msg.slice(0, 150)}).\n` +
        'Нужно обновить INSTAGRAM_ACCESS_TOKEN по инструкции (download/инструкция-instagram.md).',
      );
    }
    return NextResponse.json({ ok: false, error: msg.slice(0, 400) });
  }
}

export const GET = instagramAutoHandler;
