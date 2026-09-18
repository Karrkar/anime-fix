'use client';

import { useState, useEffect, useCallback } from 'react';
import { Search, ChevronLeft, ChevronRight, X, SortAsc, Tag } from 'lucide-react';
import { AnimeCard } from '@/components/cards/AnimeCard';
import { SkeletonGrid } from '@/components/ui';
import { Anime } from '@/lib/client-types';
import { apiFetch } from '@/lib/client-utils';

export interface CatalogFacets {
  genres: { name: string; count: number }[];
  types: { name: string; count: number }[];
  fresh: number;
}

export function CatalogPage({ onOpen, favorites }: { onOpen: (id: string) => void; favorites: Set<string> }) {
  const [anime, setAnime] = useState<Anime[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // Фильтры: жанр + тип + сортировка (значения берём из /api/facets)
  const [facets, setFacets] = useState<CatalogFacets>({ genres: [], types: [], fresh: 0 });
  const [genre, setGenre] = useState('');
  const [type, setType] = useState('');
  const [sort, setSort] = useState('new');

  useEffect(() => {
    apiFetch<CatalogFacets>('/api/facets').then(d => setFacets({ genres: d.genres || [], types: d.types || [], fresh: d.fresh || 0 })).catch(() => {});
  }, []);

  const load = useCallback((p: number, g: string, t: string, s: string) => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(p), limit: '24' });
    if (g) params.set('genre', g);
    if (t) params.set('type', t);
    if (s) params.set('sort', s);
    apiFetch<{ anime: Anime[]; totalPages: number; total: number }>(`/api/catalog?${params.toString()}`)
      .then(d => { setAnime(d.anime); setTotalPages(d.totalPages); setTotal(d.total); setPage(p); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(page, genre, type, sort); }, [page, genre, type, sort, load]);
  // Сброс страницы при смене фильтров
  useEffect(() => { setPage(1); }, [genre, type, sort]);

  return (
    <div className="animate-fade-in">
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-2xl font-bold">Каталог аниме</h1>
        {total > 0 && <span className="text-xs text-[var(--muted-foreground)]">{total} тайтлов</span>}
      </div>

      {/* ── Фильтры: тип + жанр + сортировка ── */}
      <div className="mb-6 space-y-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setType('')}
            className={`text-xs px-2.5 py-1 rounded-lg transition-all ${!type ? 'bg-[var(--primary)]/20 text-[var(--primary)] font-medium' : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'}`}
          >Все типы</button>
          {facets.types.slice(0, 7).map(t => (
            <button
              key={t.name} onClick={() => setType(type === t.name ? '' : t.name)}
              className={`text-xs px-2.5 py-1 rounded-lg transition-all ${type === t.name ? 'bg-[var(--primary)]/20 text-[var(--primary)] font-medium' : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'}`}
            >{t.name}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <select
              value={genre}
              onChange={e => setGenre(e.target.value)}
              className="appearance-none pl-8 pr-8 py-1.5 rounded-lg bg-[var(--card)] border border-[var(--border)] text-xs text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]/50 cursor-pointer"
            >
              <option value="">Все жанры</option>
              {facets.genres.map(g => (
                <option key={g.name} value={g.name}>{g.name} ({g.count})</option>
              ))}
            </select>
            <Tag className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--muted-foreground)] pointer-events-none" />
          </div>
          <div className="relative">
            <select
              value={sort}
              onChange={e => setSort(e.target.value)}
              className="appearance-none pl-8 pr-8 py-1.5 rounded-lg bg-[var(--card)] border border-[var(--border)] text-xs text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]/50 cursor-pointer"
            >
              <option value="new">Сначала новые</option>
              <option value="popular">Популярные</option>
              <option value="score">По рейтингу</option>
              <option value="title">По алфавиту</option>
              <option value="episodes">По числу серий</option>
            </select>
            <SortAsc className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--muted-foreground)] pointer-events-none" />
          </div>
          {(genre || type || sort !== 'new') && (
            <button onClick={() => { setGenre(''); setType(''); setSort('new'); }} className="text-xs text-[var(--muted-foreground)] hover:text-[var(--primary)] transition-colors flex items-center gap-1">
              <X className="w-3 h-3" /> Сбросить
            </button>
          )}
        </div>
      </div>

      {loading ? <SkeletonGrid count={18} /> : anime.length === 0 ? (
        <div className="text-center py-16 text-[var(--muted-foreground)]">
          <Search className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p>Ничего не найдено</p>
          <button onClick={() => { setGenre(''); setType(''); }} className="mt-3 text-sm text-[var(--primary)] hover:underline">Сбросить фильтры</button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-8">
            {anime.map(a => <AnimeCard key={a.id} anime={a} onOpen={onOpen} onFav={() => {}} isFav={favorites.has(a.id)} />)}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3">
              <button onClick={() => load(page - 1, genre, type, sort)} disabled={page <= 1 || loading} className="p-2 rounded-lg bg-[var(--card)] border border-[var(--border)] hover:bg-[var(--muted)] disabled:opacity-30 disabled:cursor-not-allowed"><ChevronLeft className="w-4 h-4" /></button>
              <span className="text-sm text-[var(--muted-foreground)]">{page} / {totalPages}</span>
              <button onClick={() => load(page + 1, genre, type, sort)} disabled={page >= totalPages || loading} className="p-2 rounded-lg bg-[var(--card)] border border-[var(--border)] hover:bg-[var(--muted)] disabled:opacity-30 disabled:cursor-not-allowed"><ChevronRight className="w-4 h-4" /></button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
