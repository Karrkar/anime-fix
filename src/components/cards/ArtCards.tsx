'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Image from 'next/image';
import { Heart, Star, ImageIcon, Video } from 'lucide-react';
import { ArtItem } from '@/lib/client-types';
import { BLUR_DATA_URL } from '@/lib/client-utils';

export function Rule34ArtCard({ art, isVideo, onClick }: { art: ArtItem; isVideo?: boolean; onClick: () => void }) {
  const [imgError, setImgError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const proxyUrl = art.imageUrl ? `/api/r34img?url=${encodeURIComponent(art.imageUrl)}` : '';
  // PROXY-FIRST: домен rule34.xxx (вкл. CDN wimg.*) заблокирован провайдерами РФ —
  // прямой <img src=wimg...> у значительной части аудитории гарантированно падает
  // (таймаут до ~75с), и только потом срабатывал фолбэк на прокси. Грузим сразу
  // через прокси (кэш 30 мин на сервере), прямой URL оставляем как запасной путь.
  const [useDirect, setUseDirect] = useState(false);
  const imgSrc = useDirect ? (art.imageUrl || '') : proxyUrl;
  return (
    <motion.div
      whileHover={{ y: -3, scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className="group cursor-pointer rounded-xl overflow-hidden border border-pink-500/20 hover:border-pink-500/50 transition-all art-card-glow"
      style={{ background: 'linear-gradient(145deg, rgba(236,72,153,0.08), rgba(168,85,247,0.05))' }}
    >
      <div className="relative aspect-square overflow-hidden" style={{ background: 'linear-gradient(160deg, #1a0a14 0%, #2d1030 50%, #1a0a14 100%)' }}>
        {/* Shimmer placeholder while loading */}
        {!imgLoaded && !imgError && imgSrc && (
          <div className="absolute inset-0 art-card-shimmer" />
        )}
        {!imgError && imgSrc ? (
          <img
            src={imgSrc}
            alt={art.title}
            referrerPolicy={useDirect ? 'no-referrer' : undefined}
            className={`w-full h-full object-cover group-hover:scale-105 transition-all duration-500 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => {
              if (!useDirect) { setUseDirect(true); setImgLoaded(false); }
              else { setImgError(true); }
            }}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-3 text-center" style={{ background: 'linear-gradient(160deg, #1a0a14 0%, #2d1030 50%, #1a0a14 100%)' }}>
            {isVideo ? <Video className="w-8 h-8 text-pink-400/40" /> : <ImageIcon className="w-8 h-8 text-pink-400/40" />}
            <p className="text-[10px] text-pink-200/50 line-clamp-3 leading-tight">{art.title || art.tags}</p>
          </div>
        )}
        {/* Pink gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-pink-950/80 via-pink-900/10 to-pink-900/5" />
        <div className="absolute inset-0 bg-gradient-to-t from-pink-900/40 via-transparent to-purple-900/20 opacity-0 group-hover:opacity-100 transition-all duration-300" />
        {/* Score badge */}
        {art.likes > 0 && (
          <span className="absolute top-1.5 right-1.5 flex items-center gap-0.5 text-[10px] text-white bg-gradient-to-r from-pink-600/80 to-rose-600/80 backdrop-blur-sm rounded-full px-1.5 py-0.5 font-medium shadow-lg shadow-pink-500/20">
            <Star className="w-3 h-3" fill="white" />{art.likes}
          </span>
        )}
        {/* Video badge with pulse */}
        {isVideo && (
          <span className="absolute top-1.5 left-1.5 flex items-center gap-0.5 text-[10px] text-white bg-gradient-to-r from-pink-600 to-rose-600 backdrop-blur-sm rounded-full px-2 py-0.5 font-bold video-badge-pulse shadow-lg shadow-pink-500/30">
            <Video className="w-3 h-3" />GIF
          </span>
        )}
        {/* Hover overlay */}
        <div className="absolute bottom-2 left-2 right-2 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-1 group-hover:translate-y-0">
          <div className="flex items-center justify-center">
            <span className="text-[10px] text-pink-100 bg-pink-950/80 backdrop-blur-sm rounded-full px-3 py-1.5 font-medium shadow-lg border border-pink-500/20">
              {isVideo ? '\u25b6 Воспроизвести' : '\U0001f50d Открыть'}
            </span>
          </div>
        </div>
      </div>
      <div className="p-2" style={{ background: 'linear-gradient(to top, rgba(236,72,153,0.06), transparent)' }}>
        <p className="text-[11px] font-medium text-pink-50 line-clamp-1 group-hover:text-pink-300 transition-colors">{art.title}</p>
        <p className="text-[10px] text-pink-300/40">{art.artist}</p>
      </div>
    </motion.div>
  );
}

export function ArtCard({ art }: { art: ArtItem }) {
  const [liked, setLiked] = useState(false);
  const [likes, setLikes] = useState(art.likes);
  return (
    <motion.div whileHover={{ y: -4 }} className="group rounded-xl overflow-hidden bg-[var(--card)] border border-[var(--border)] hover:border-[var(--primary)]/40 transition-all">
      <div className="relative aspect-square overflow-hidden bg-[var(--muted)]">
        {art.imageUrl ? (
          <Image src={art.imageUrl} alt={art.title} fill sizes="(max-width: 768px) 33vw, 16vw" placeholder="blur" blurDataURL={BLUR_DATA_URL} className="object-cover group-hover:scale-105 transition-transform duration-300" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[var(--muted-foreground)]"><ImageIcon className="w-12 h-12" /></div>
        )}
      </div>
      <div className="p-3">
        <h3 className="text-sm font-semibold text-[var(--foreground)] line-clamp-1 mb-1">{art.title}</h3>
        <p className="text-xs text-[var(--muted-foreground)] mb-2">{art.artist}</p>
        <div className="flex items-center justify-between">
          <div className="flex gap-1 flex-wrap">
            {art.tags.split(',').slice(0, 2).map(t => (
              <span key={t} className="text-[10px] px-1.5 py-0.5 bg-[var(--muted)] text-[var(--muted-foreground)] rounded">{t.trim()}</span>
            ))}
          </div>
          <button onClick={() => { setLiked(!liked); setLikes(l => liked ? l - 1 : l + 1); }} className="flex items-center gap-1 text-xs text-[var(--muted-foreground)] hover:text-red-400 transition-colors">
            <Heart className={`w-3.5 h-3.5 ${liked ? 'fill-red-500 text-red-500' : ''}`} />
            <span>{likes}</span>
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Mobile Bottom Navigation ──────────────────────────────────────
