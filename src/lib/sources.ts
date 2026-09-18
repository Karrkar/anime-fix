/**
 * F-27 fix: единый реестр внешних источников.
 *
 * Раньше домены (v13.vost.pw, hentaibaza.com, feelex.fun, rule34.xxx,
 * r.jina.ai) были захардкожены строками в 8 модулях и в CSP next.config.ts.
 * Смена домена источника требовала правок в нескольких местах.
 *
 * Теперь все источники описаны здесь; маршруты и CSP берут значения из
 * этого модуля. Модуль чистый (без node-API и process.env) — его можно
 * импортировать и из next.config.ts, и из edge-роутов.
 */

export interface SourceDef {
  /** Базовый URL источника (origin, без завершающего слэша кроме jina-ридера) */
  base: string;
  /** Хосты, разрешённые для прокси/проверок */
  hosts: string[];
  note?: string;
}

export const SOURCES = {
  /** Парсер аниме-каталога (sync-anime) */
  vost: {
    base: 'https://v13.vost.pw',
    hosts: ['v13.vost.pw'],
  },
  /** Плеерные страницы/CDN vost.pw — белые списки player-proxy */
  vostCdn: {
    base: 'https://vost.pw',
    hosts: ['vost.pw', 'www.vost.pw', '13.vost.pw'],
    note: 'исторические хосты плеера; v13 добавлен в sources.vost',
  },
  /** Парсер хентай-каталога (sync-hentai) */
  hentaibaza: {
    base: 'https://hentaibaza.com',
    hosts: ['hentaibaza.com', 'cdn.hentaibaza.com', 'videos.hentaibaza.com', 'cloude.hentaibaza.com'],
  },
  /** Парсер 18+ игр (sync-games, основной источник) */
  feelex: {
    base: 'https://feelex.fun',
    // ФИКС 18.09.2026: обложки игр feelex раздаются с cdn.feelex.fun (271 из
    // 316 записей в БД). Без этого хоста в IMAGE_HOSTS next/image-оптимизатор
    // отвечал 400 INVALID_IMAGE_OPTIMIZE_REQUEST, и карточки игр в разделе 18+
    // показывались без обложек (иконка-заглушка). Хост добавлен в белый список
    // remotePatterns — как это уже сделано для cdn.hentaibaza.com.
    hosts: ['feelex.fun', 'cdn.feelex.fun'],
  },
  /** Парсер 18+ игр (sync-games, вторичный источник) */
  xxxIgra: {
    base: 'https://xxx-igra.com',
    hosts: ['xxx-igra.com'],
  },
  /** Rule34: сайт + CDN картинок/видео (rule34, rule34-post, r34img) */
  rule34: {
    base: 'https://rule34.xxx',
    // ФИКС: видео переехало с video.rule34.xxx на новые поддомены CDN
    // (nymp4/ahrimp4/aws-mp4.rule34.xxx) — жёсткий список ломал плеер 403.
    // Проверка хоста теперь wildcard-овая: isAllowedR34Host() ниже.
    hosts: ['rule34.xxx', 'wimg.rule34.xxx', 'img.rule34.xxx', 'us.rule34.xxx', 'video.rule34.xxx'],
  },
  /** Reader-proxy для обхода Cloudflare при парсинге */
  jinaReader: {
    base: 'https://r.jina.ai/',
    hosts: ['r.jina.ai'],
  },
} as const satisfies Record<string, SourceDef>;

/* ── Короткие алиасы для маршрутов (сохраняют прежние имена констант) ── */

export const VOST_BASE = SOURCES.vost.base;
export const HB_BASE = SOURCES.hentaibaza.base;
export const FEELEX_BASE = SOURCES.feelex.base;
export const XXX_IGRA_BASE = SOURCES.xxxIgra.base;
export const R34_BASE = SOURCES.rule34.base;
export const JINA_READER = SOURCES.jinaReader.base;

/**
 * Белый список хостов для /api/player-proxy.
 * v13.vost.pw добавлен: embed_url свежесинхронизированных тайтлов — это
 * страницы v13.vost.pw, и плеер-прокси должен уметь их загружать.
 */
export const PLAYER_PROXY_ALLOWED_HOSTS: readonly string[] = [
  ...SOURCES.vost.hosts,
  ...SOURCES.vostCdn.hosts,
];

/**
 * ФИКС плеера 18+: rule34.xxx раздаёт видео с ротируемых поддоменов CDN
 * (nymp4.rule34.xxx, ahrimp4.rule34.xxx, aws-mp4.rule34.xxx — и новые
 * могут появиться в любой момент). Жёсткий список ломал воспроизведение
 * 403'ем, поэтому хост проверяется wildcard'ом: сам домен или любой
 * его поддомен. SSRF-безопасно: suffix-проверка не пропускает чужие
 * домены вида rule34.xxx.evil.com (endsWith учитывает точку-границу).
 */
export function isAllowedR34Host(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'rule34.xxx' || h.endsWith('.rule34.xxx');
}

/** Хосты постеров/картинок для next/image (remotePatterns в next.config.ts) */
export const IMAGE_HOSTS: readonly string[] = [
  ...new Set([
    ...SOURCES.vost.hosts,
    ...SOURCES.hentaibaza.hosts,
    ...SOURCES.rule34.hosts,
    ...SOURCES.feelex.hosts,
    ...SOURCES.xxxIgra.hosts,
    'cdn.myanimelist.net',
  ]),
];

/** Белый список хостов для /api/r34img */
export const R34IMG_ALLOWED_HOSTS: readonly string[] = SOURCES.rule34.hosts;

/* ── Производные значения для CSP (next.config.ts) ── */

/** Хосты, встраиваемые в iframe плеера → frame-src (полные origin'ы) */
export const CSP_FRAME_HOSTS: string[] = SOURCES.vost.hosts.map(h => `https://${h}`);

/** Домены, к которым ходит бэкенд/парсеры → connect-src (кроме Supabase — он из env) */
export const CSP_CONNECT_HOSTS: string[] = [
  'https://yoomoney.ru',
  'https://r.jina.ai',
];
