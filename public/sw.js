/*
 * Service Worker Anime Platforma (PWA).
 *
 * v5 (ap-v5): sw.js теперь отдаётся с Cache-Control: no-cache (next.config.ts) —
 * браузер получает свежий SW при каждом заходе, без 4-часового лага CDN.
 * Смена версии при деплое → апдейт → activate вычищает ВСЕ
 * старые кэши (в т.ч. застрявшие чанки старых сборок) → clients.claim()
 * переводит открытые вкладки под новый SW. Это лечит «замурованную» вкладку
 * со старым HTML/чанками после серии деплоев.
 *
 * Стратегии:
 *  - /_next/static/*, /icons/*, /logo.svg, /favicon.ico → cache-first (неменные хэшируемые ассеты)
 *  - навигация (HTML) → network-first, офлайн-фолбэк на закэшированную «/»
 *  - /api/* → СЕТЬ ТОЛЬКО (никогда не кэшируем: чат, гейты, каталог меняются)
 *  - постеры и прочие картинки → cache-first c лимитом записей
 */
const CACHE_VERSION = 'ap-v5'; // v5: no-cache заголовок для sw.js (next.config.ts) — браузер теперь всегда получает свежий SW
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const IMG_CACHE = `${CACHE_VERSION}-img`;
const IMG_CACHE_MAX = 120;

self.addEventListener('install', (event) => {
  // allSettled вместо addAll: апдейт SW обязан встать ЛЮБОЙ ценой — иначе
  // старая версия не заменится и лечение не сработает. Частичная неудача
  // префетча оболочки не должна блокировать установку v4.
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((c) => Promise.allSettled([c.add('/'), c.add('/logo.svg'), c.add('/favicon.ico')]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname === '/logo.svg' ||
    url.pathname === '/favicon.ico' ||
    url.pathname.startsWith('/icons/')
  );
}

function isImage(url) {
  return /\.(png|jpe?g|webp|avif|svg|gif)$/i.test(url.pathname) || url.pathname.startsWith('/_next/image');
}

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (const key of keys.slice(0, keys.length - max)) await cache.delete(key);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (isApi(url)) return; // API — только сеть

  // Статика с хэшами в имени — вечный кэш
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // Картинки — cache-first c обрезкой
  if (isImage(url)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(IMG_CACHE).then((c) => {
                c.put(req, copy);
                trimCache(IMG_CACHE, IMG_CACHE_MAX);
              });
            }
            return res;
          }).catch(() => hit)
      )
    );
    return;
  }

  // Навигация (HTML) — сеть, при офлайне отдаём закэшированную оболочку
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/'))
    );
  }
});
