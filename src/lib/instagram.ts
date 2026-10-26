/**
 * instagram.ts — клиент Instagram Graph API для автопостинга платформы.
 *
 * Требования Meta (без них API-постинг невозможен — только ручная публикация):
 *   • аккаунт Instagram → Professional (Business/Creator);
 *   • аккаунт привязан к Facebook-странице;
 *   • создано приложение на developers.facebook.com;
 *   • получен long-lived токен (60 дней) с правом instagram_content_publish
 *     (Instagram Login: instagram_business_content_publish).
 *
 * Токен живёт 60 дней и ПРОДЛЕВАЕТСЯ вызовом refresh_access_token — автопостер
 * делает это сам при каждом запуске (запись /ig/token в rate_limits заменяет
 * токен из env, пока крон ходит хотя бы раз в 60 дней — не истечёт никогда).
 *
 * ДВА типа токена (обе схемы Meta):
 *   • Instagram User token (graph.instagram.com) — «/me» сразу даёт IG-аккаунт,
 *     поддерживает refresh. Рекомендован в инструкции владельцу.
 *   • Facebook User token (graph.facebook.com) — IG-аккаунт ищется через
 *     /me/accounts?fields=instagram_business_account; refresh не реализован
 *     (нужен app secret) — протухнет за 60 дней, пришлём алерт в Telegram.
 */

/** Куда ходить за данным токеном (подбирается автоматически при идентификации). */
interface IgBase {
  host: string; // 'graph.instagram.com' | 'graph.facebook.com'
  version: string; // 'v21.0' для FB; у IG-хоста версий нет
}

export interface IgIdentity {
  igUserId: string;
  username: string;
  tokenKind: 'instagram' | 'facebook';
  base: IgBase;
}

export interface IgPublishResult {
  mediaId: string;
  permalink: string;
}

const IG_HOST = 'graph.instagram.com';
const FB_HOST = 'graph.facebook.com';

/** Строка каталога, нужная для сборки поста (подмножество anime_catalog). */
export interface CatalogRow {
  vost_id: number;
  title: string;
  title_russian: string | null;
  description: string | null;
  image_url: string | null;
  genres: string | null;
  score: number | null;
  year: number | null;
  type: string | null;
  updated_at: string | null;
}

/** Домен платформы для ссылок в постах. */
export const SITE_URL = 'https://animeplatforma-new.online';

/** Хэштеги из жанров строки «Комедия, Драма, Школа» → #комедия #драма … */
export function extractHashtags(genres: string | null | undefined): string[] {
  if (!genres) return [];
  return genres
    .split(/[,;/]+/)
    .map((g) => g.trim().replace(/[#\s]+/g, '').replace(/[^0-9a-zA-Zа-яА-ЯёЁ_-]/g, '').toLowerCase())
    .filter((g) => g.length >= 3 && g.length <= 24)
    .slice(0, 4)
    .map((g) => `#${g}`);
}

/** Шаблонная подпись (когда LLM не настроен или не ответил). */
export function buildFallbackCaption(a: CatalogRow): string {
  const title = (a.title_russian || a.title || '').trim();
  const desc = (a.description || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const meta = [a.year, a.type].filter(Boolean).join(' • ');
  const rating = a.score && a.score >= 70 ? `Рейтинг ${Math.round(a.score)}/100` : '';
  const tags = extractHashtags(a.genres);
  const base = [
    `🎬 ${title}`,
    meta || rating ? `\n${[meta, rating].filter(Boolean).join(' • ')}` : '',
    desc ? `\n\n${desc}${a.description && a.description.length > 300 ? '…' : ''}` : '',
    `\n\n▶ Смотреть бесплатно: ${SITE_URL}/anime/db-${a.vost_id}`,
    `\n\n${['#аниме', '#смотретьаниме', ...tags, '#анимеонлайн', '#чтопосмотреть'].join(' ')}`,
  ].join('');
  return base.length > 2150 ? base.slice(0, 2149) + '…' : base;
}

/** Обложка через наш домен: правильный размер для IG + доступность для Meta. */
export function buildCoverUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return rawUrl; // _next/image требует https
    return `${SITE_URL}/_next/image?url=${encodeURIComponent(rawUrl)}&w=1080&q=75`;
  } catch {
    return rawUrl;
  }
}

async function graphGet(base: IgBase, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const url = base.version
    ? `https://${base.host}/${base.version}/${path}?${qs}`
    : `https://${base.host}/${path}?${qs}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    const err = d?.error as { message?: string; code?: number } | undefined;
    throw new Error(`IG API ${r.status}: ${err?.message || JSON.stringify(d).slice(0, 200)}`);
  }
  return d;
}

async function graphPost(base: IgBase, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = base.version
    ? `https://${base.host}/${base.version}/${path}`
    : `https://${base.host}/${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    const err = d?.error as { message?: string; code?: number } | undefined;
    throw new Error(`IG API ${r.status}: ${err?.message || JSON.stringify(d).slice(0, 200)}`);
  }
  return d;
}

/**
 * Кто мы по этому токену: IG-аккаунт напрямую (Instagram Login) или через
 * Facebook-страницу. Кэшируется на время жизни инстанса (крон холодный —
 * фактически один вызов на запуск).
 */
let identityCache: IgIdentity | null = null;

export async function resolveInstagramIdentity(token: string): Promise<IgIdentity> {
  if (identityCache) return identityCache;

  // 1) Instagram User token: /me — сам IG-аккаунт
  try {
    const me = await graphGet({ host: IG_HOST, version: '' }, 'me', {
      fields: 'id,username',
      access_token: token,
    });
    if (me.id) {
      identityCache = {
        igUserId: String(me.id),
        username: String(me.username || ''),
        tokenKind: 'instagram',
        base: { host: IG_HOST, version: '' },
      };
      return identityCache;
    }
  } catch { /* попробуем facebook-схему */ }

  // 2) Facebook User token: IG-аккаунт через привязанную страницу
  const pages = await graphGet({ host: FB_HOST, version: 'v21.0' }, 'me/accounts', {
    fields: 'name,instagram_business_account{id,username}',
    access_token: token,
  });
  const list = (pages?.data as Array<Record<string, unknown>>) || [];
  const withIg = list.find((p) => p.instagram_business_account);
  const ig = withIg?.instagram_business_account as { id?: string; username?: string } | undefined;
  if (!ig?.id) {
    throw new Error(
      'Токен не даёт доступ к Instagram Business-аккаунту: нужен аккаунт Professional, ' +
      'привязанный к Facebook-странице, и разрешение instagram_content_publish',
    );
  }
  identityCache = {
    igUserId: String(ig.id),
    username: String(ig.username || ''),
    tokenKind: 'facebook',
    base: { host: FB_HOST, version: 'v21.0' },
  };
  return identityCache;
}

/** Тест токена без постинга — для диагностики владельцу. */
export async function checkInstagramToken(token: string): Promise<IgIdentity> {
  identityCache = null;
  return resolveInstagramIdentity(token);
}

/**
 * Продление long-lived токена — две схемы:
 *   • Instagram-токен: graph.instagram.com/refresh_access_token (без app secret);
 *   • Facebook-токен: обмен fb_exchange_token — нужны env INSTAGRAM_APP_ID +
 *     INSTAGRAM_APP_SECRET (App Dashboard → Settings → Basic).
 * Разрешено не чаще раза в 24ч — при более частом вызове API вернёт ошибку,
 * это штатно и молча игнорируется. Возвращает НОВЫЙ токен или null.
 */
export async function refreshInstagramToken(token: string): Promise<string | null> {
  // 1) Instagram-токен — самый простой путь
  try {
    const d = await graphGet({ host: IG_HOST, version: '' }, 'refresh_access_token', {
      grant_type: 'ig_refresh_token',
      access_token: token,
    });
    const fresh = d?.access_token;
    if (typeof fresh === 'string' && fresh.length > 20) return fresh;
  } catch { /* попробуем facebook-схему */ }

  // 2) Facebook-токен: обмен на новый 60-дневный (нужны id+secret приложения)
  const appId = process.env.INSTAGRAM_APP_ID || '';
  const appSecret = process.env.INSTAGRAM_APP_SECRET || '';
  if (!appId || !appSecret) return null;
  try {
    const d = await graphGet({ host: FB_HOST, version: 'v21.0' }, 'oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: token,
    });
    const fresh = d?.access_token;
    return typeof fresh === 'string' && fresh.length > 20 ? fresh : null;
  } catch {
    return null; // рано (<24ч) или протух — не критично, алерт будет при публикации
  }
}

/**
 * Публикация изображения в ленту Instagram (двухфазный Graph API):
 *   1) POST /{ig-user-id}/media {image_url, caption} → creation_id
 *   2) POST /{ig-user-id}/media_publish {creation_id} → media_id
 * image_url обязан быть публичным https-адресом, который загрузят серверы Meta.
 */
export async function publishInstagramImage(args: {
  token: string;
  identity: IgIdentity;
  imageUrl: string;
  caption: string;
}): Promise<IgPublishResult> {
  const { token, identity, imageUrl, caption } = args;
  const { igUserId, base } = identity;

  // Лимиты IG: подпись ≤ 2200 символов — режем с запасом на юникод-эмодзи
  const safeCaption = caption.length > 2150 ? caption.slice(0, 2149) + '…' : caption;

  const container = await graphPost(base, `${igUserId}/media`, {
    image_url: imageUrl,
    caption: safeCaption,
    access_token: token,
  });
  const creationId = container?.id as string | undefined;
  if (!creationId) throw new Error('IG API: контейнер не создан (нет creation_id)');

  const published = await graphPost(base, `${igUserId}/media_publish`, {
    creation_id: creationId,
    access_token: token,
  });
  const mediaId = published?.id as string | undefined;
  if (!mediaId) throw new Error('IG API: публикация не прошла (нет media_id)');

  // Ссылка на пост — не критично, если не вернётся
  let permalink = '';
  try {
    const d = await graphGet(base, mediaId, { fields: 'permalink', access_token: token });
    permalink = String(d?.permalink || '');
  } catch { /* permalink опционален */ }

  return { mediaId, permalink };
}

/** Ошибка токена (истёк/отозван)? По таким включаем алерт владельцу. */
export function isTokenError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /(access token|token.*(expired|invalid|revoked)|ошибка.*токен|190)/i.test(msg);
}
