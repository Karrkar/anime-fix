'use client';

import Image from 'next/image';
import { Play, Film } from 'lucide-react';
import { BLUR_DATA_URL } from '@/lib/client-utils';
import type { ResumeItem } from '@/lib/client-types';

export function ResumeShelf({ items, onOpen }: { items: ResumeItem[]; onOpen: (id: string, ep?: number) => void }) {
  if (items.length === 0) return null;
  return (
    <section className="mb-6 sm:mb-12">
      <div className="flex items-center justify-between mb-3 sm:mb-4">
        <h2 className="text-lg sm:text-xl font-bold flex items-center gap-2"><Play className="w-4 h-4 sm:w-5 sm:h-5 text-emerald-400" fill="currentColor" /> Продолжить просмотр</h2>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0">
        {items.map(r => {
          const ep = r.episodeNumber || 1;
          const pct = Math.min(100, Math.round((ep / Math.max(1, r.episodes || 1)) * 100));
          return (
            <button key={r.id} onClick={() => onOpen(r.id, ep)} className="group flex-shrink-0 w-40 sm:w-48 text-left">
              <div className="relative aspect-video rounded-lg overflow-hidden bg-[var(--muted)] border border-[var(--border)] group-hover:border-[var(--primary)]/40 transition-all">
                {r.imageUrl ? (
                  <Image src={r.imageUrl} alt={r.title} fill sizes="192px" placeholder="blur" blurDataURL={BLUR_DATA_URL} className="object-cover group-hover:scale-105 transition-transform duration-300" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center"><Film className="w-8 h-8 text-[var(--muted-foreground)]" /></div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                <span className="absolute top-1.5 right-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-black/70 backdrop-blur-sm text-white">Серия {ep}</span>
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="w-10 h-10 rounded-full bg-[var(--primary)]/90 flex items-center justify-center"><Play className="w-5 h-5 text-white ml-0.5" fill="white" /></div>
                </div>
                {/* полоса прогресса */}
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
                  <div className="h-full bg-red-500" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <p className="text-xs font-medium mt-1.5 line-clamp-1 text-[var(--foreground)]">{r.title}</p>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ─── Обновления в избранном: новые серии (клиентский diff по снапшоту) ──
