'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Image from 'next/image';
import { Heart, Play, Film, Clock4 } from 'lucide-react';
import { Anime } from '@/lib/client-types';
import { BLUR_DATA_URL, parseGenres } from '@/lib/client-utils';

export function HentaiCard({ anime, onOpen, onFav, isFav }: {
  anime: Anime; onOpen: (id: string) => void; onFav: (id: string) => void; isFav: boolean;
}) {
  const epCount = anime.episodes || 0;
  const [imgErr, setImgErr] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  return (
    <motion.div
      whileHover={{ y: -4, scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      className="group cursor-pointer rounded-xl overflow-hidden border border-pink-500/20 hover:border-pink-500/50 transition-all art-card-glow"
      style={{ background: 'linear-gradient(145deg, rgba(236,72,153,0.08), rgba(168,85,247,0.05))' }}
      onClick={() => onOpen(anime.id)}
    >
      <div className="relative aspect-[3/4] overflow-hidden" style={{ background: 'linear-gradient(160deg, #1a0a14 0%, #2d1030 50%, #1a0a14 100%)' }}>
        {/* Shimmer while loading */}
        {!imgLoaded && !imgErr && anime.imageUrl && (
          <div className="absolute inset-0 art-card-shimmer" />
        )}
        {anime.imageUrl && !imgErr ? (
          <Image src={anime.imageUrl} alt={anime.title} fill sizes="(max-width: 768px) 33vw, 16vw" placeholder="blur" blurDataURL={BLUR_DATA_URL} className={`object-cover group-hover:scale-105 transition-all duration-500 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`} onLoad={() => setImgLoaded(true)} onError={() => setImgErr(true)} />
        ) : null}
        <div className="absolute inset-0 flex flex-col items-center justify-center p-3">
          <Film className="w-10 h-10 text-pink-400/50 mb-2" />
          <p className="text-[11px] text-pink-200/60 text-center line-clamp-3 font-medium">{anime.title}</p>
        </div>
        {/* Pink-tinted overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-pink-950/90 via-pink-900/20 to-pink-900/10" />
        <div className="absolute inset-0 bg-gradient-to-r from-pink-900/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        {/* 18+ badge */}
        <div className="absolute top-1.5 left-1.5 sm:top-2 sm:left-2 px-1.5 sm:px-2 py-0.5 bg-gradient-to-r from-pink-600 to-rose-600 rounded-md text-[9px] sm:text-[10px] font-bold text-white uppercase tracking-wider shadow-lg shadow-pink-500/30">18+</div>
        {/* Episode count */}
        <div className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 flex items-center gap-1 px-1.5 sm:px-2 py-0.5 bg-black/50 backdrop-blur-sm rounded-full text-[9px] sm:text-[10px] text-pink-100 border border-pink-500/20">
          {epCount > 0 ? <><Clock4 className="w-2.5 h-2.5 sm:w-3 sm:h-3" />{epCount} эп.</> : <><Clock4 className="w-2.5 h-2.5 sm:w-3 sm:h-3" />1 эп.</>}
        </div>
        {/* Play overlay */}
        <div className="absolute inset-0 flex items-center justify-center md:opacity-0 md:group-hover:opacity-100 transition-all duration-300">
          <div className="w-11 h-11 sm:w-14 sm:h-14 rounded-full bg-gradient-to-br from-pink-500 to-rose-600 flex items-center justify-center shadow-xl shadow-pink-500/40 group-hover:shadow-pink-500/60 group-hover:scale-110 transition-all duration-300">
            <Play className="w-5 h-5 sm:w-7 sm:h-7 text-white ml-0.5" fill="white" />
          </div>
        </div>
        {/* Bottom info */}
        <div className="absolute bottom-1.5 left-1.5 sm:bottom-2 sm:left-2">
          <span className="text-[9px] sm:text-xs px-1.5 sm:px-2 py-0.5 bg-pink-500/20 backdrop-blur-sm rounded-md text-pink-100 border border-pink-500/15">{anime.type}</span>
        </div>
        {/* Fav button */}
        <button
          onClick={(e) => { e.stopPropagation(); onFav(anime.id); }}
          className="absolute bottom-1.5 right-1.5 sm:bottom-2 sm:right-2 p-1.5 rounded-full bg-black/40 backdrop-blur-sm hover:bg-pink-500/40 transition-all border border-pink-500/15"
        >
          <Heart className={`w-3.5 h-3.5 sm:w-4 sm:h-4 transition-colors ${isFav ? 'fill-pink-500 text-pink-400' : 'text-pink-200/60'}`} />
        </button>
      </div>
      <div className="p-2 sm:p-3" style={{ background: 'linear-gradient(to top, rgba(236,72,153,0.06), transparent)' }}>
        <h3 className="text-[11px] sm:text-sm font-semibold text-pink-50 line-clamp-2 leading-tight mb-0.5 sm:mb-1.5 group-hover:text-pink-300 transition-colors">{anime.title}</h3>
        {anime.titleRussian && anime.titleRussian !== anime.title && (
          <p className="text-[10px] sm:text-xs text-pink-300/40 line-clamp-1 mb-1 sm:mb-2">{anime.titleRussian}</p>
        )}
        <div className="flex items-center gap-1 flex-wrap">
          {parseGenres(anime.genres).filter(g => g !== '18+' && g !== 'Хентай').slice(0, 2).map(g => (
            <span key={g} className="text-[9px] sm:text-[10px] px-1.5 py-0.5 bg-pink-500/15 text-pink-400 rounded-md">{g}</span>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

/* ──────────────────── Art Viewer Image ──────────────────── */
export function ArtViewerImage({ fullImgUrl, thumbnailUrl, title }: { fullImgUrl: string; thumbnailUrl: string; title: string }) {
  const [imgError, setImgError] = useState(false);
  // PROXY-FIRST: rule34.xxx заблокирован провайдерами РФ — прямой запрос к CDN
  // у таких пользователей висит до таймаута, прежде чем сработал бы фолбэк.
  // Сразу идём через кэширующий прокси; прямой URL — запасной путь.
  const [useDirect, setUseDirect] = useState(false);
  const [showThumb, setShowThumb] = useState(true);

  let src = '';
  if (fullImgUrl && !imgError) {
    src = useDirect
      ? fullImgUrl
      : `/api/r34img?url=${encodeURIComponent(fullImgUrl)}`;
  } else {
    src = thumbnailUrl;
  }

  return (
    <>
      {/* Show thumbnail immediately while full image loads */}
      {showThumb && fullImgUrl && (
        <img
          src={thumbnailUrl}
          alt={title}
          referrerPolicy="no-referrer"
          className="absolute max-w-[200px] max-h-[200px] object-contain rounded-lg opacity-40 blur-sm"
        />
      )}
      <img
        key={src}
        src={src}
        alt={title}
        referrerPolicy={useDirect ? 'no-referrer' : undefined}
        className="max-w-full max-h-full object-contain select-none relative z-[1]"
        onLoad={() => setShowThumb(false)}
        onError={() => {
          if (fullImgUrl && !useDirect) { setUseDirect(true); }
          else if (fullImgUrl && useDirect) { setImgError(true); }
          setShowThumb(false);
        }}
      />
    </>
  );
}
