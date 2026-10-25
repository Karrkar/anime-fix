/*
 * Service Worker Anime Platforma (PWA).
 *
 * v7 (ap-v7): версионированная регистрация /sw.js?b=<BUILD_ID> (pwa-register.tsx) —
 * уникальный URL для каждого деплоя обходит кэш Cloudflare (до 4 часов) НАВСЕГДА:
 * именно из-за него файл автопочинки не мог добраться до браузеров и «замурованные»
 * вкладки не лечились, хотя прямой адрес *.vercel.app работал (там нет SW).
 * Смена версии при деплое → апдейт → activate вычищает ВСЕ
 * старые кэши (в т.ч. застрявшие чанки старых сборок) → clients.claim()
 * переводит открытые вкладки под новый SW. Это лечит «замурованную» вкладку
 * со старым HTML/чанками после серии деплоев.
 *
 * v8 (ap-v8): skipWaiting вынесен из цепочки префетча — в v7 если caches.open()
 * бросал исключение (приватный режим, квота), skipWaiting НЕ вызывался и новый
 * SW зависал в waiting навсегда, старый продолжал кормить вкладку мёртвыми
 * чанками (чёрный экран). Теперь смена активного SW не зависит от кэша вовсе.
 *
 * Стратегии:
 *  - /_next/static/*, /icons/*, /logo.svg, /favicon.ico → cache-first (неменные хэшируемые ассеты)
 *  - навигация (HTML) → network-first, офлайн-фолбэк на закэшированную «/»
 *  - /api/* → СЕТЬ ТОЛЬКО (никогда не кэшируем: чат, гейты, каталог меняются)
 *  - постеры и прочие картинки → cache-first c лимитом записей
 */
const CACHE_VERSION = 'ap-v8'; // v8: skipWaiting не зависит от успеха префетша кэша
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const IMG_CACHE = `${CACHE_VERSION}-img`;
const IMG_CACHE_MAX = 120;

self.addEventListener('install', (event) => {
  // v8: skipWaiting НЕЗАВИСИМО от префетча — смена SW обязана произойти
  // любой ценой (раньше сбой caches.open замораживал обновление навсегда).
  event.waitUntil(
    (async () => {
      self.skipWaiting();
      try {
        const c = await caches.open(STATIC_CACHE);
        await Promise.allSettled([c.add('/'), c.add('/logo.svg'), c.add('/favicon.ico')]);
      } catch (e) { /* кэш недоступен — не блокируем активацию */ }
    })()
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

// Подталкивание из страницы (pwa-register.tsx): если SW в waiting,
// но skipWaiting в install по какой-то причине не сработал.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
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
