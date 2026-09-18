'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, ChevronRight, TrendingUp, Sparkles, List, Clock4, Shuffle } from 'lucide-react';
import { AnimeCard } from '@/components/cards/AnimeCard';
import { FavUpdatesShelf } from '@/components/shelves/FavUpdatesShelf';
import { ResumeShelf } from '@/components/shelves/ResumeShelf';
import { SkeletonGrid, SkeletonLine } from '@/components/ui';
import { Anime, FavUpdate, Page, ResumeItem } from '@/lib/client-types';
import { apiFetch } from '@/lib/client-utils';

export function HomePage({ onNavigate, onOpen, favorites, favUpdates, onMarkAllFavSeen }: { onNavigate: (p: Page) => void; onOpen: (id: string, ep?: number) => void; favorites: Set<string>; favUpdates: FavUpdate[]; onMarkAllFavSeen: () => void }) {
  const [trending, setTrending] = useState<Anime[]>([]);
  const [fresh, setFresh] = useState<Anime[]>([]);
  const [recent, setRecent] = useState<Anime[]>([]);
  const [resume, setResume] = useState<ResumeItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [randomLoading, setRandomLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      apiFetch<{ anime: Anime[] }>('/api/anime?limit=12&offset=0').then(d => d.anime).catch(() => []),
      apiFetch<{ anime: Anime[] }>('/api/catalog?sort=new&fresh=1&limit=12').then(d => d.anime || []).catch(() => []),
      apiFetch<{ anime: Anime[] }>('/api/anime?limit=12&offset=12').then(d => d.anime).catch(() => []),
      apiFetch<{ history: ResumeItem[] }>('/api/history').then(d => (d.history || []).slice(0, 12)).catch(() => []),
    ]).then(([t, f, r, h]) => {
      if (!alive) return;
      setTrending(t); setFresh(f); setRecent(r); setResume(h); setLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  const openRandom = useCallback(async () => {
    setRandomLoading(true);
    try {
      const d = await apiFetch<{ anime: Anime }>('/api/random');
      if (d.anime?.id) onOpen(d.anime.id);
    } catch { /* тихо */ }
    setRandomLoading(false);
  }, [onOpen]);

  return (
    <div className="animate-fade-in">
      {/* Hero */}
      <section className="relative mb-6 sm:mb-12 rounded-2xl overflow-hidden bg-gradient-to-r from-[var(--primary)]/20 via-[var(--card)] to-[var(--accent)]/20 border border-[var(--border)]">
        <div className="px-5 py-8 sm:px-12 sm:py-20">
          <motion.h1 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-2xl sm:text-5xl font-extrabold mb-3 sm:mb-4 text-white leading-tight">
            Смотри любимое аниме <span className="text-[var(--primary)]">онлайн</span>
          </motion.h1>
          <p className="text-gray-300 text-sm sm:text-lg mb-6 sm:mb-8 max-w-xl">Тысячи тайтлов, свежие серии и лучшие арты — всё в одном месте.</p>
          <div className="flex flex-wrap gap-3">
            <button onClick={() => onNavigate('catalog')} className="accent-btn flex items-center gap-2 text-sm sm:text-base"><List className="w-4 h-4" /> Каталог</button>
            <button onClick={() => onNavigate('search')} className="px-4 py-2 rounded-lg border border-white/20 text-white hover:bg-white/10 transition-colors flex items-center gap-2 text-sm sm:text-base"><Search className="w-4 h-4" /> Поиск</button>
            <button onClick={openRandom} disabled={randomLoading} className="px-4 py-2 rounded-lg border border-white/20 text-white hover:bg-white/10 transition-colors flex items-center gap-2 text-sm sm:text-base disabled:opacity-50"><Shuffle className="w-4 h-4" /> {randomLoading ? 'Выбираем…' : 'Случайное аниме'}</button>
          </div>
        </div>
      </section>

      {/* Продолжить просмотр — из истории (лучшая фича удержания) */}
      {!loaded ? <SkeletonLine className="h-8 w-64 mb-4" /> : <ResumeShelf items={resume} onOpen={onOpen} />}

      {/* Обновления в избранном — вышли новые серии у любимых тайтлов */}
      <FavUpdatesShelf updates={favUpdates} onOpen={onOpen} onMarkAll={onMarkAllFavSeen} />

      {/* Свежее за неделю — видно, что сайт живой */}
      <section className="mb-6 sm:mb-12">
        <div className="flex items-center justify-between mb-3 sm:mb-4">
          <h2 className="text-lg sm:text-xl font-bold flex items-center gap-2"><Sparkles className="w-4 h-4 sm:w-5 sm:h-5 text-emerald-400" /> Свежее за неделю</h2>
          <button onClick={() => onNavigate('catalog')} className="text-xs sm:text-sm text-[var(--muted-foreground)] hover:text-[var(--primary)] transition-colors flex items-center gap-1">Весь каталог <ChevronRight className="w-3.5 h-3.5" /></button>
        </div>
        {!loaded ? <SkeletonGrid count={6} /> : fresh.length === 0 ? (
          <p className="text-sm text-[var(--muted-foreground)]">За последнюю неделю не было новинок и обновлений серий.</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5 sm:gap-4">
            {fresh.map(a => <AnimeCard key={a.id} anime={a} onOpen={onOpen} onFav={() => {}} isFav={favorites.has(a.id)} />)}
          </div>
        )}
      </section>

      {/* Trending */}
      <section className="mb-6 sm:mb-12">
        <div className="flex items-center justify-between mb-3 sm:mb-4">
          <h2 className="text-lg sm:text-xl font-bold flex items-center gap-2"><TrendingUp className="w-4 h-4 sm:w-5 sm:h-5 text-[var(--primary)]" /> Популярное</h2>
        </div>
        {!loaded ? <SkeletonGrid count={12} /> : (
          <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5 sm:gap-4">
            {trending.map(a => <AnimeCard key={a.id} anime={a} onOpen={onOpen} onFav={() => {}} isFav={favorites.has(a.id)} />)}
          </div>
        )}
      </section>

      {/* Recent */}
      <section className="mb-6 sm:mb-8">
        <div className="flex items-center justify-between mb-3 sm:mb-4">
          <h2 className="text-lg sm:text-xl font-bold flex items-center gap-2"><Clock4 className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-400" /> Новинки</h2>
        </div>
        {!loaded ? <SkeletonGrid count={12} /> : (
          <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5 sm:gap-4">
            {recent.map(a => <AnimeCard key={a.id} anime={a} onOpen={onOpen} onFav={() => {}} isFav={favorites.has(a.id)} />)}
          </div>
        )}
      </section>
    </div>
  );
}
