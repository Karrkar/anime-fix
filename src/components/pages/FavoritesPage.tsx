'use client';

import { useState, useEffect } from 'react';
import { Heart } from 'lucide-react';
import { AnimeCard } from '@/components/cards/AnimeCard';
import { SkeletonGrid } from '@/components/ui';
import { Anime } from '@/lib/client-types';
import { apiFetch } from '@/lib/client-utils';

export function FavoritesPage({ onOpen, favorites, toggleFav }: { onOpen: (id: string) => void; favorites: Set<string>; toggleFav: (id: string) => void }) {
  const [items, setItems] = useState<Anime[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    apiFetch<{ favorites: Anime[] }>('/api/favorites').then(d => setItems(d.favorites)).catch(() => {}).finally(() => setLoaded(true));
  }, [favorites]);

  return (
    <div className="animate-fade-in">
      <h1 className="text-2xl font-bold mb-6 flex items-center gap-2"><Heart className="w-6 h-6 text-red-400" /> Избранное</h1>
      {!loaded ? <SkeletonGrid count={6} /> : items.length === 0 ? (
        <div className="text-center py-20 text-[var(--muted-foreground)]"><Heart className="w-12 h-12 mx-auto mb-4 opacity-30" /><p>Пока ничего нет. Добавьте аниме в избранное!</p></div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {items.map(a => <AnimeCard key={a.id} anime={a} onOpen={onOpen} onFav={toggleFav} isFav={favorites.has(a.id)} />)}
        </div>
      )}
    </div>
  );
}
