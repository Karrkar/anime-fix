'use client';

import Image from 'next/image';
import { Film, CheckCircle2, BellRing } from 'lucide-react';
import { FavUpdate } from '@/lib/client-types';
import { BLUR_DATA_URL, pluralEpisodes } from '@/lib/client-utils';

export function FavUpdatesShelf({ updates, onOpen, onMarkAll }: { updates: FavUpdate[]; onOpen: (id: string, ep?: number) => void; onMarkAll: () => void }) {
  if (updates.length === 0) return null;
  return (
    <section className="mb-6 sm:mb-12">
      <div className="flex items-center justify-between mb-3 sm:mb-4">
        <h2 className="text-lg sm:text-xl font-bold flex items-center gap-2"><BellRing className="w-4 h-4 sm:w-5 sm:h-5 text-orange-400" /> Обновления в избранном</h2>
        <button onClick={onMarkAll} className="text-xs sm:text-sm text-[var(--muted-foreground)] hover:text-[var(--primary)] transition-colors flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Отметить прочитанным</button>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0">
        {updates.map(u => {
          const n = u.to - u.from;
          return (
            <button key={u.anime.id} onClick={() => onOpen(u.anime.id, Math.min(u.to, u.from + 1))} className="group flex-shrink-0 w-40 sm:w-48 text-left">
              <div className="relative aspect-video rounded-lg overflow-hidden bg-[var(--muted)] border border-orange-500/30 group-hover:border-orange-400/60 transition-all">
                {u.anime.imageUrl ? (
                  <Image src={u.anime.imageUrl} alt={u.anime.title} fill sizes="192px" placeholder="blur" blurDataURL={BLUR_DATA_URL} className="object-cover group-hover:scale-105 transition-transform duration-300" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center"><Film className="w-8 h-8 text-[var(--muted-foreground)]" /></div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                <span className="absolute top-1.5 right-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-orange-500/90 backdrop-blur-sm text-white">+{n} {pluralEpisodes(n)}</span>
                <div className="absolute bottom-1.5 left-1.5 text-[10px] text-white/80">было {u.from} → стало {u.to}</div>
              </div>
              <p className="text-xs font-medium mt-1.5 line-clamp-1 text-[var(--foreground)]">{u.anime.title}</p>
            </button>
          );
        })}
      </div>
    </section>
  );
}
