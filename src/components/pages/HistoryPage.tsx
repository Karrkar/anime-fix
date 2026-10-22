'use client';

import { useState, useEffect } from 'react';
import { Clock, Eye } from 'lucide-react';
import { AnimeCard } from '@/components/cards/AnimeCard';
import { SkeletonGrid } from '@/components/ui';
import { Anime } from '@/lib/client-types';
import { apiFetch } from '@/lib/client-utils';

export function HistoryPage({ onOpen }: { onOpen: (id: string, ep?: number) => void }) {
  const [items, setItems] = useState<Anime[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    apiFetch<{ history: Anime[] }>('/api/history').then(d => setItems(d.history)).catch(() => {}).finally(() => setLoaded(true));
  }, []);

  return (
    <div className="animate-fade-in">
      <h1 className="text-2xl font-bold mb-6 flex items-center gap-2"><Clock className="w-6 h-6 text-blue-400" /> История просмотров</h1>
      {!loaded ? <SkeletonGrid count={12} /> : items.length === 0 ? (
        <div className="text-center py-20 text-[var(--muted-foreground)]"><Eye className="w-12 h-12 mx-auto mb-4 opacity-30" /><p>История пуста. Начните смотреть аниме!</p></div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {items.map(a => {
            const ep = a.episodeNumber || 1;
            const pct = Math.min(100, Math.round((ep / Math.max(1, a.episodes || 1)) * 100));
            return (
              <div key={`${a.id}-${a.watchedAt}`} className="relative">
                <AnimeCard anime={a} onOpen={(id) => onOpen(id, ep)} onFav={() => {}} isFav={false} />
                <div className="absolute bottom-1 left-1.5 right-1.5 h-1 rounded-full bg-black/40 overflow-hidden">
                  <div className="h-full bg-red-500" style={{ width: `${pct}%` }} />
                </div>
                <span className="absolute top-1.5 right-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-black/70 text-white">Сер. {ep}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
