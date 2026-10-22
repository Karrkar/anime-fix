'use client';

import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Image from 'next/image';
import { Heart, Play, Film } from 'lucide-react';
import { Anime } from '@/lib/client-types';
import { BLUR_DATA_URL, freshness, parseGenres, stripHtml } from '@/lib/client-utils';

export function AnimeCard({ anime, onOpen, onFav, isFav }: { 
  anime: Anime; onOpen: (id: string) => void; onFav: (id: string) => void; isFav: boolean;
}) {
  const fresh = freshness(anime);
  const desc = useMemo(() => stripHtml(anime.description).slice(0, 140), [anime.description]);
  return (
    <motion.div
      whileHover={{ y: -4 }}
      className="group cursor-pointer rounded-xl overflow-hidden bg-[var(--card)] border border-[var(--border)] hover:border-[var(--primary)]/40 transition-all"
      onClick={() => onOpen(anime.id)}
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-[var(--muted)]">
        {anime.imageUrl ? (
          <Image
            src={anime.imageUrl}
            alt={anime.title}
            fill
            sizes="(max-width: 768px) 33vw, (max-width: 1280px) 25vw, 16vw"
            placeholder="blur"
            blurDataURL={BLUR_DATA_URL}
            className="object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[var(--muted-foreground)]"><Film className="w-12 h-12" /></div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
        {/* Бейджи «Новое» / «Обновлено» */}
        {fresh && (
          <span className={`absolute top-1.5 left-1.5 flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-md text-white shadow ${fresh === 'new' ? 'bg-emerald-500/90' : 'bg-sky-500/90'}`}>
            {fresh === 'new' ? 'НОВОЕ' : 'UPD'}
          </span>
        )}
        {/* Hover-превью: краткое описание (только десктоп) */}
        <div className="hidden md:flex absolute inset-0 flex-col justify-end p-2.5 bg-gradient-to-t from-black/95 via-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none">
          <p className="text-[11px] leading-snug text-white/85 line-clamp-5 mb-1.5">{desc || anime.title}</p>
          <div className="flex flex-wrap gap-1">
            {parseGenres(anime.genres).slice(0, 3).map(g => (
              <span key={g} className="text-[9px] px-1 py-0.5 bg-white/15 backdrop-blur-sm rounded text-white/90">{g}</span>
            ))}
          </div>
        </div>
        <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
          <span className="text-xs px-2 py-0.5 bg-white/20 backdrop-blur-sm rounded text-white">{anime.type}</span>
          <span className="text-xs px-2 py-0.5 bg-white/20 backdrop-blur-sm rounded text-white">{anime.episodes} эп.</span>
        </div>
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-14 h-14 rounded-full bg-[var(--primary)]/90 flex items-center justify-center">
            <Play className="w-7 h-7 text-white ml-1" fill="white" />
          </div>
        </div>
      </div>
      <div className="p-3">
        <h3 className="text-sm font-semibold text-[var(--foreground)] line-clamp-2 leading-tight mb-1">{anime.title}</h3>
        {anime.titleRussian && (
          <p className="text-xs text-[var(--muted-foreground)] line-clamp-1 mb-2">{anime.titleRussian}</p>
        )}
        <div className="flex items-center justify-between">
          <div className="flex flex-wrap gap-1">
            {parseGenres(anime.genres).slice(0, 2).map(g => (
              <span key={g} className="text-[10px] px-1.5 py-0.5 bg-[var(--primary)]/15 text-[var(--primary)] rounded">{g}</span>
            ))}
          </div>
          <button 
            onClick={(e) => { e.stopPropagation(); onFav(anime.id); }}
            className="p-1 hover:bg-[var(--muted)] rounded transition-colors"
          >
            <Heart className={`w-4 h-4 ${isFav ? 'fill-red-500 text-red-500' : 'text-[var(--muted-foreground)]'}`} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
