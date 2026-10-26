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
 *   2) Пейсинг: интервал ≥2ч + суточный лимит POSTS_PER_DAY (по умолчанию 8,
 *      env INSTAGRAM_POSTS_PER_DAY; крон дёргает эндпоинт 10 раз в день
 *      с 6:00 до 24:00 по Москве). ?force=1 (админ/секрет) — вне очереди.
 *   3) Выбирает аниме: свежее (обновлённое за 14 дней), не 18+, с обложкой,
 *      ещё не публиковавшееся; при исчерпании — популярное из всего каталога.
 *   4) Подпись: LLM-копирайтер (если настроен) или шаблон; ссылка на страницу
 *      тайтла + хэштеги жанров.
 *   5) Обложка — через оптимизатор нашего домена (/_next/image?w=1080):
 *      гарантированный размер для Instagram и доступность для серверов Meta.
 *   6) Публикует через Instagram Graph API, затем ДУБЛИРУЕТ тот же пост
 *      на Facebook-страницу (кросспост для охвата; только с классическим
 *      FB-токеном — IG-login токен кросспост не поддерживает).
 *      Пишет состояние в rate_limits (/ig/posted/<vost_id>), шлёт
 *      уведомление в Telegram владельцу.
 *
 * Требования к аккаунту (без них вернёт configured:false с инструкцией):
 * Instagram Professional (Business/Creator) + токен с instagram_content_publish
 * (см. download/инструкция-instagram.md). Для кросспоста в Facebook нужна
 * FB-страница + классический токен с pages_manage_posts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDb, authFromRequest } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { logEvent } from '@/lib/logger';
import { notifyTelegram } from '@/lib/notify';
import {
  resolveInstagramIdentity,
  resolveFacebookPage,
  publishFacebookPhoto,
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

/**
 * Целевое число постов в сутки: env INSTAGRAM_POSTS_PER_DAY, 1..12, по
 * умолчанию 8. Лимит Instagram — 100 API-постов/24ч (мы сильно ниже);
 * собственный лимит защищает от спам-паттернов и выгорания ленты.
 */
const POSTS_PER_DAY = Math.min(12, Math.max(1, parseInt(process.env.INSTAGRAM_POSTS_PER_DAY || '8', 10) || 8));
/** Минимальный интервал между постами, часов (равен шагу крона). */
const PACE_HOURS = 2;
/** Свежесть тайтла для приоритетного отбора, дней. */
const FRESH_DAYS = 14;
/** Сколько прошлых постов помним для защиты от повторов (8/день ≈ 50 дней). */
const POSTED_MEMORY = 400;

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
      posts_per_day: POSTS_PER_DAY,
      note: 'Добавьте INSTAGRAM_ACCESS_TOKEN в Vercel env (инструкция: download/инструкция-instagram.md) и перезапустите деплой',
    });
  }
  const stored = await loadStoredToken(db);
  if (stored && stored !== token) token = stored; // продлённый токен новее env

  try {
    // ── 2. Пейсинг: интервал между постами + суточный лимит ────────────
    if (!force) {
      const { data: recentPosts } = await db
        .from('rate_limits')
        .select('created_at')
        .like('bucket_key', '/ig/posted/%')
        .order('created_at', { ascending: false })
        .limit(50);
      const times = (recentPosts || [])
        .map((r) => new Date(r.created_at).getTime())
        .filter((t) => !Number.isNaN(t));

      // а) не чаще раза в PACE_HOURS (защита от двойного срабатывания)
      if (times.length) {
        const ageH = (Date.now() - Math.max(...times)) / 36e5;
        if (ageH < PACE_HOURS) {
          return NextResponse.json({
            ok: true,
            skipped: 'pacing',
            note: `Последний пост ${ageH.toFixed(1)}ч назад; интервал ${PACE_HOURS}ч (?force=1 — вне очереди)`,
          });
        }
      }

      // б) не больше POSTS_PER_DAY за скользящие 24 часа
      const dayAgo = Date.now() - 24 * 3600 * 1000;
      const last24 = times.filter((t) => t > dayAgo).length;
      if (last24 >= POSTS_PER_DAY) {
        return NextResponse.json({
          ok: true,
          skipped: 'daily_cap',
          posts_today: last24,
          note: `За сутки уже ${last24} постов (лимит ${POSTS_PER_DAY}/день; меняется переменной INSTAGRAM_POSTS_PER_DAY)`,
        });
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
      .limit(200);
    let candidate = ((fresh || []) as CatalogRow[]).find((a) => !posted.has(String(a.vost_id))) || null;

    // Фолбэк: популярное из всего каталога (свежее исчерпано)
    if (!candidate) {
      const { data: popular } = await db
        .from('anime_catalog')
        .select(select)
        .eq('is_adult', false)
        .neq('image_url', '')
        .order('views', { ascending: false })
        .limit(300);
      candidate = ((popular || []) as CatalogRow[]).find((a) => !posted.has(String(a.vost_id))) || null;
    }

    // Второй фолбэк: весь каталог по дате обновления (при 8-10 постах/день
    // свежее+популярное исчерпывается за пару недель)
    if (!candidate) {
      const { data: recentAny } = await db
        .from('anime_catalog')
        .select(select)
        .eq('is_adult', false)
        .neq('image_url', '')
        .order('updated_at', { ascending: false })
        .limit(500);
      candidate = ((recentAny || []) as CatalogRow[]).find((a) => !posted.has(String(a.vost_id))) || null;
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

    // ── 5б. Кросспост в Facebook (тот же пост — больше охват) ────────────
    // Возможен только с классическим FB-токеном (запасной путь инструкции);
    // IG-login токен кросспост не поддерживает — это штатно, пропускаем.
    let fbUrl = '';
    let fbStatus = 'skipped';
    try {
      if (identity.tokenKind === 'facebook') {
        const page = await resolveFacebookPage(token);
        if (page?.pageToken) {
          const fbPostId = await publishFacebookPhoto({
            pageId: page.pageId,
            pageToken: page.pageToken,
            imageUrl: cover,
            caption,
          });
          fbUrl = `https://www.facebook.com/${fbPostId}`;
          fbStatus = 'posted';
        } else {
          fbStatus = 'no_page_token';
        }
      } else {
        fbStatus = 'ig_login_token';
      }
    } catch (e) {
      fbStatus = `error: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`;
    }

    // Состояние: тайтл опубликован
    await db.from('rate_limits').insert({
      bucket_key: `/ig/posted/${candidate.vost_id}`,
      ip: JSON.stringify({ mediaId, permalink, title, fbStatus, fbUrl, at: new Date().toISOString() }).slice(0, 500),
    });
    await igTelemetry(db, 'ok', { vost_id: candidate.vost_id, title, mediaId, permalink, fbStatus });

    logEvent('instagram_auto_posted', { vost_id: candidate.vost_id, title, mediaId, fbStatus }, 'info');
    const tgLines = [
      `📸 Автопост: «${title}»`,
      `IG: ${permalink || '(ссылка появится через пару минут)'}`,
    ];
    if (fbUrl) tgLines.push(`📘 Кросспост в Facebook: ${fbUrl}`);
    tgLines.push(`Аккаунт: @${identity.username}`);
    void notifyTelegram(tgLines.join('\n'));

    // ── 6. Продление токена (кроме facebook-схемы) ────────────────────────
    const fresh2 = await refreshInstagramToken(token);
    if (fresh2) await storeToken(db, fresh2);

    return NextResponse.json({
      ok: true,
      posted: { title, vost_id: candidate.vost_id, mediaId, permalink, account: identity.username },
      facebook: { status: fbStatus, url: fbUrl },
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
