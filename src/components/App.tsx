'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Clock, User } from 'lucide-react';
import { HentaiPage } from '@/components/adult/HentaiPage';
import { Footer } from '@/components/layout/Footer';
import { MobileBottomNav, Navbar } from '@/components/layout/Navbar';
import { AdminPage } from '@/components/pages/AdminPage';
import { CatalogPage } from '@/components/pages/CatalogPage';
import { FavoritesPage } from '@/components/pages/FavoritesPage';
import { HistoryPage } from '@/components/pages/HistoryPage';
import { HomePage } from '@/components/pages/HomePage';
import { ProfilePage } from '@/components/pages/ProfilePage';
import { SearchPage } from '@/components/pages/SearchPage';
import { WatchPage } from '@/components/pages/WatchPage';
import { Anime, FavUpdate, Page } from '@/lib/client-types';
import { apiFetch, authHeaders, computeFavUpdates, readFavSnapshot, writeFavSnapshot } from '@/lib/client-utils';

// Hash-роутинг разделов: /#catalog, /#search, /#favorites, /#history, /#profile, /#hentai —
// прямые ссылки (шаринг/закладки/F5 остаются в разделе) + рабочая кнопка «Назад» браузера.
// Плеер остаётся на deep-link /?open={id} (кнопки SEO-страниц), URL в плеере не меняем.
const HASH_PAGES: Partial<Record<string, Page>> = {
  '': 'home',
  '#home': 'home',
  '#catalog': 'catalog',
  '#search': 'search',
  '#favorites': 'favorites',
  '#history': 'history',
  '#profile': 'profile',
  '#hentai': 'hentai',
  '#admin': 'admin',
};

function pageFromHash(): Page | null {
  try {
    const h = decodeURIComponent(window.location.hash).trim().toLowerCase();
    return HASH_PAGES[h] ?? null;
  } catch { return null; }
}

function urlForPage(p: Page): string {
  return p === 'home' ? '/' : `/#${p}`;
}

export default function App() {
  const [page, setPage] = useState<Page>('home');
  const [watchId, setWatchId] = useState<string | null>(null);
  const [watchEp, setWatchEp] = useState(1); // с какой серии стартовать (resume)
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [favUpdates, setFavUpdates] = useState<FavUpdate[]>([]);
  const [prevPage, setPrevPage] = useState<Page>('home');
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [hasSubscription, setHasSubscription] = useState(false);
  // Инициализацию роута (чтение URL) выполняем один раз: в dev StrictMode эффект
  // запускается дважды, а replaceState('/') после /?open= вычищает параметр —
  // без флага второй прогон счёл бы hash пустым и сбросил плеер на главную.
  const routeInitDone = useRef(false);

  // Load favorites on mount (+ считаем «обновления в избранном»)
  useEffect(() => {
    apiFetch<{ favorites: Anime[] }>('/api/favorites').then(d => {
      setFavorites(new Set(d.favorites.map(a => a.id))); // auth: cookie или legacy Bearer
      try { setFavUpdates(computeFavUpdates(d.favorites || [])); } catch { /* ignore */ }
    }).catch(() => {});
    // Check subscription on mount (F-07: cookie читает сервер; savedToken — legacy-миграция)
    const savedToken = localStorage.getItem('anime_platform_token');
    fetch('/api/subscription', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check', ...(savedToken ? { token: savedToken } : {}) }),
    }).then(r => r.json()).then(d => {
      // Admin (role from DB) always has access
      const isAdmin = d.user?.role === 'admin';
      if (isAdmin || (d.ok && d.user?.subscription?.isActive)) {
        setHasSubscription(true);
      }
    }).catch(() => {});
  }, []);

  const handleSubscriptionChange = useCallback((active: boolean) => {
    if (active) setHasSubscription(true);
    else {
      // Admin never loses access (F-07: сервер сам читает cookie; savedToken — legacy)
      const savedToken = localStorage.getItem('anime_platform_token');
      fetch('/api/subscription', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'check', ...(savedToken ? { token: savedToken } : {}) }),
      }).then(r => r.json()).then(d => {
        if (d.user?.role === 'admin') setHasSubscription(true);
        else setHasSubscription(false);
      }).catch(() => setHasSubscription(false));
    }
  }, []);

  // Открываем тайтл; ep — с какой серии (для «Продолжить просмотр»).
  // Сама запись истории делает WatchPage (при открытии и каждой смене серии) —
  // здесь дубль не нужен, иначе resume-серия затиралась бы единицей.
  const openAnime = useCallback((id: string, ep?: number) => {
    setPrevPage(page);
    setWatchId(id);
    setWatchEp(ep && ep > 0 ? ep : 1);
    setPage('watch');
    setMoreMenuOpen(false);
    // Открыл тайтл — новые серии в нём считаем просмотренными
    setFavUpdates(prev => {
      if (!prev.some(u => u.anime.id === id)) return prev;
      const snap = readFavSnapshot();
      snap[id] = prev.find(u => u.anime.id === id)!.to;
      writeFavSnapshot(snap);
      return prev.filter(u => u.anime.id !== id);
    });
  }, [page]);

  const markAllFavSeen = useCallback(() => {
    setFavUpdates(prev => {
      if (prev.length) {
        const snap = readFavSnapshot();
        for (const u of prev) snap[u.anime.id] = u.to;
        writeFavSnapshot(snap);
      }
      return [];
    });
  }, []);

  // Deep-link из SEO-страниц: /?open={id} открывает плеер (URL чистим,
  // чтобы F5 не возвращал в плеер — back из плеера ведёт на главную).
  // Плюс стартовый раздел из hash: /#catalog и т.п. открываются сразу.
  useEffect(() => {
    if (!routeInitDone.current) {
      routeInitDone.current = true;
      let deepLinked = false;
      try {
        const o = new URLSearchParams(window.location.search).get('open');
        if (o && /^[a-zA-Z0-9-]{1,40}$/.test(o)) {
          setWatchId(o);
          setWatchEp(1);
          setPage('watch');
          window.history.replaceState(null, '', '/');
          deepLinked = true;
        }
      } catch { /* ignore */ }
      if (!deepLinked) {
        const p = pageFromHash();
        if (p) setPage(p);
      }
    }
    // «Назад/Вперёд» браузера — тоже переключают раздел (hashchange)
    const onHashChange = () => {
      const p = pageFromHash();
      if (p) {
        setPage(p);
        setWatchId(null);
        setMoreMenuOpen(false);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((p: Page) => {
    setPage(p);
    setWatchId(null);
    setMoreMenuOpen(false);
    // Синхронизируем URL: у раздела появляется прямая ссылка (F5 остаётся в разделе).
    // pushState не триггерит hashchange — состояние не переключается дважды.
    try {
      if (window.location.pathname + window.location.hash !== urlForPage(p)) {
        window.history.pushState(null, '', urlForPage(p));
      }
    } catch { /* ignore */ }
  }, []);

  const toggleFav = useCallback(async (id: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); fetch('/api/favorites', { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ animeId: id }) }).catch(() => {}); }
      else { next.add(id); fetch('/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ animeId: id }) }).catch(() => {}); }
      return next;
    });
  }, []);

  const goBack = useCallback(() => { navigate(prevPage); }, [navigate, prevPage]);

  const isWatchPage = page === 'watch' && !!watchId;

  const moreLinks: { page: Page; label: string; icon: React.ReactNode }[] = [
    { page: 'history', label: 'История', icon: <Clock className="w-5 h-5" /> },
    { page: 'profile', label: 'Профиль', icon: <User className="w-5 h-5" /> },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <Navbar page={page} onNavigate={navigate} onSearch={() => navigate('search')} favCount={favorites.size} favUpd={favUpdates.length} onMoreOpen={() => setMoreMenuOpen(v => !v)} />

      <main className={`flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6 ${!isWatchPage ? 'pb-20 md:pb-6' : 'pb-6'}`}>
        <AnimatePresence mode="wait">
          <motion.div key={page + (watchId || '')} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }}>
            {page === 'home' && <HomePage onNavigate={navigate} onOpen={openAnime} favorites={favorites} favUpdates={favUpdates} onMarkAllFavSeen={markAllFavSeen} />}
            {page === 'catalog' && <CatalogPage onOpen={openAnime} favorites={favorites} />}
            {page === 'search' && <SearchPage onOpen={openAnime} favorites={favorites} />}
            {page === 'watch' && watchId && <WatchPage key={watchId} animeId={watchId} initialEp={watchEp} onBack={goBack} onOpen={openAnime} favorites={favorites} toggleFav={toggleFav} />}
            {page === 'favorites' && <FavoritesPage onOpen={openAnime} favorites={favorites} toggleFav={toggleFav} />}
            {page === 'history' && <HistoryPage onOpen={openAnime} />}
            {page === 'profile' && <ProfilePage onSubscriptionChange={handleSubscriptionChange} onNavigate={navigate} />}
            {page === 'hentai' && <HentaiPage onOpen={openAnime} favorites={favorites} onNavigate={navigate} toggleFav={toggleFav} hasSubscription={hasSubscription} />}
            {page === 'admin' && <AdminPage onBack={() => navigate('profile')} onNavigate={navigate} />}
          </motion.div>
        </AnimatePresence>
      </main>
      <Footer />

      {/* Лилит-чат теперь — вкладка «Лилит» внутри раздела 18+ (HentaiPage) */}

      {/* Mobile bottom nav (hidden on desktop and watch page) */}
      {!isWatchPage && <MobileBottomNav page={page} onNavigate={navigate} onSearch={() => navigate('search')} favCount={favorites.size} favUpd={favUpdates.length} onMoreOpen={() => setMoreMenuOpen(v => !v)} />}

      {/* More menu overlay */}
      <AnimatePresence>
        {moreMenuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm md:hidden"
              onClick={() => setMoreMenuOpen(false)}
            />
            <motion.div
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="fixed bottom-0 left-0 right-0 z-[61] md:hidden rounded-t-2xl bg-[var(--card)] border-t border-[var(--border)] p-4"
              style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
            >
              <div className="w-10 h-1 rounded-full bg-[var(--border)] mx-auto mb-4" />
              <div className="space-y-1">
                {moreLinks.map(l => {
                  const isActive = page === l.page;
                  return (
                    <button
                      key={l.page}
                      onClick={() => navigate(l.page)}
                      className={`flex items-center gap-3 w-full px-4 py-3 rounded-xl text-base transition-colors ${isActive ? 'bg-[var(--primary)]/15 text-[var(--primary)]' : 'text-[var(--foreground)] active:bg-[var(--muted)]'}`}
                    >
                      {l.icon} {l.label}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
