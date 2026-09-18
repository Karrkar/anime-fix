'use client';

import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { Search, Clock, AlertTriangle } from 'lucide-react';
import { AnimeCard } from '@/components/cards/AnimeCard';
import { SkeletonGrid } from '@/components/ui';
import { Anime } from '@/lib/client-types';
import { RECENT_SEARCHES_KEY, apiFetch } from '@/lib/client-utils';


export function SearchPage({ onOpen, favorites }: { onOpen: (id: string) => void; favorites: Set<string> }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Anime[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);

  // Недавние запросы (localStorage, максимум 8)
  useEffect(() => {
    try { setRecent(JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || '[]')); } catch {}
  }, []);

  const saveRecent = useCallback((q: string) => {
    setRecent(prev => {
      const next = [q, ...prev.filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
      try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // Мгновенный поиск с debounce 400 мс
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); setSearched(false); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      apiFetch<{ anime: Anime[] }>(`/api/search?q=${encodeURIComponent(q)}`)
        .then(d => { setResults(d.anime); setSearched(true); saveRecent(q); })
        .catch(() => {})
        .finally(() => setSearching(false));
    }, 400);
    return () => clearTimeout(t);
  }, [query, saveRecent]);

  const doSearch = (e?: FormEvent) => {
    if (e) e.preventDefault();
    // Мгновенный поиск уже сработал через debounce; форма нужна для Enter/мобилок
  };

  return (
    <div className="animate-fade-in">
      <h1 className="text-2xl font-bold mb-6">Поиск аниме</h1>
      <form onSubmit={doSearch} className="flex gap-2 mb-8">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Название, жанр..." className="flex-1 px-4 py-2.5 rounded-lg bg-[var(--card)] border border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-[var(--primary)] transition-colors" />
        <button type="submit" className="accent-btn flex items-center gap-2"><Search className="w-4 h-4" /> Найти</button>
      </form>
      {!searched ? (
        <>
          {recent.length > 0 && (
            <div className="mb-8">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-[var(--muted-foreground)] flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" /> Недавние запросы</p>
                <button onClick={() => { setRecent([]); try { localStorage.removeItem(RECENT_SEARCHES_KEY); } catch {} }} className="text-xs text-[var(--muted-foreground)] hover:text-red-400 transition-colors">Очистить</button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {recent.map(q => (
                  <button key={q} onClick={() => setQuery(q)} className="text-xs px-2.5 py-1.5 rounded-lg bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--card)] transition-colors">{q}</button>
                ))}
              </div>
            </div>
          )}
          <div className="text-center py-16 text-[var(--muted-foreground)]"><Search className="w-12 h-12 mx-auto mb-4 opacity-40" /><p>Введите запрос для поиска</p></div>
        </>
      ) : searching ? (
        <SkeletonGrid count={12} />
      ) : results.length === 0 ? (
        <div className="text-center py-16 text-[var(--muted-foreground)]"><AlertTriangle className="w-12 h-12 mx-auto mb-4 opacity-40" /><p>Ничего не найдено</p></div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {results.map(a => <AnimeCard key={a.id} anime={a} onOpen={onOpen} onFav={() => {}} isFav={favorites.has(a.id)} />)}
        </div>
      )}
    </div>
  );
}

/**
 * ИСПРАВЛЕНИЕ БАГА #2: используем key={animeId} чтобы заставить React
 * полностью перемонтировать компонент при смене аниме.
 * Это сбрасывает все стейты (вкл. iframe) и гарантирует,
 * что показывается именно новый контент.
 */
