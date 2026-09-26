/*
 * Service Worker AnimePlatform (PWA).
 *
 * Стратегии:
 *  - /_next/static/*, /icons/*, /logo.svg, /favicon.ico → cache-first (неменные хэшируемые ассеты)
 *  - навигация (HTML) → network-first, офлайн-фолбэк на закэшированную «/»
 *  - /api/* → СЕТЬ ТОЛЬКО (никогда не кэшируем: чат, гейты, каталог меняются)
 *  - постеры и прочие картинки → cache-first c лимитом записей
 *
 * Версия CACHE_VERSION: при деплое нового кода Next меняет хэши статики,
 * но старые записи всё равно чистим активацией (cleanup old caches).
 */
const CACHE_VERSION = 'ap-v3';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const IMG_CACHE = `${CACHE_VERSION}-img`;
const IMG_CACHE_MAX = 120;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((c) => c.addAll(['/', '/logo.svg', '/favicon.ico'])).then(() => self.skipWaiting())
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
