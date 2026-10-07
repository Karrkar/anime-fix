'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Image from 'next/image';
import { Heart, Play, Film, Clock4, ImageIcon } from 'lucide-react';
import { Anime } from '@/lib/client-types';
import { BLUR_DATA_URL, parseGenres, hedgeLoadImage } from '@/lib/client-utils';

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
  // 2026-10-08, фикс «чёрный экран арта на мобильных» (финальная версия):
  //
  // СИМПТОМ: на телефонах лайтбокс открывался в чёрный фон — картинка не
  // появлялась минутами или никогда, при этом сетка артов работала.
  //
  // КОРЕНЬ (3 слоя, все подтверждены диагностикой в проде):
  //   1) CDN rule34 (Cloudflare) банит egress-IP ~40-70% инстансов Vercel →
  //      /api/r34img отдаёт 502 выборочно по инстансам;
  //   2) прошлый фолбэк на ПРЯМОЙ CDN (wimg.*) в РФ заблокирован провайдерами —
  //      <img> висит до TCP-таймаута (~75с) без onError → «вечный» чёрный экран;
  //   3) деталка /api/rule34-post мертва без Jina (баланс 402) → полного URL нет.
  //
  // ЛЕЧЕНИЕ: вся загрузка через fetch (таймауты управляемы!) волнами
  // hedgeLoadImage — параллельные запросы распределяются по разным инстансам
  // Vercel, первый 200 побеждает (P≈97% на волну из 4), успех оседает в кэшах.
  // Прямой CDN — только последний шанс с коротким таймаутом (VPN/зарубежные),
  // в РФ он отклоняется за секунды, а не висит минутами.
  const proxied = (u: string) => `/api/r34img?url=${encodeURIComponent(u)}`;

  const [previewSrc, setPreviewSrc] = useState('');
  const [mainSrc, setMainSrc] = useState('');
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const blobs: string[] = [];
    const keep = (u: string) => { blobs.push(u); return u; };

    setFailed(false);
    setLoading(true);

    (async () => {
      // 1) Размытая миниатюра-превью — сразу (в HTTP-кэше браузера от грида),
      //    чтобы вместо чёрного экрана моментально было хоть что-то
      if (thumbnailUrl) {
        hedgeLoadImage(proxied(thumbnailUrl), { waves: 1, perWave: 3, timeoutMs: 12_000 })
          .then(u => { if (alive) setPreviewSrc(keep(u)); })
          .catch(() => { /* превью не критично */ });
      }

      // 2) Основная цепочка: полная через прокси → миниатюра через прокси →
      //    прямой CDN с коротким таймаутом
      const chain: Array<[string, number]> = [];
      if (fullImgUrl) chain.push([proxied(fullImgUrl), 15_000]);
      if (thumbnailUrl) chain.push([proxied(thumbnailUrl), 12_000]);
      const directUrl = fullImgUrl || thumbnailUrl;
      if (directUrl) chain.push([directUrl, 6_000]); // для VPN/зарубежных; в РФ быстро откажется

      for (const [u, ms] of chain) {
        try {
          const blobUrl = await hedgeLoadImage(u, { waves: 2, perWave: 4, timeoutMs: ms });
          if (!alive) { URL.revokeObjectURL(blobUrl); return; }
          setMainSrc(keep(blobUrl));
          setLoading(false);
          return;
        } catch { /* следующий этап цепочки */ }
      }
      if (alive) { setFailed(true); setLoading(false); }
    })();

    return () => {
      alive = false;
      blobs.forEach(u => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullImgUrl, thumbnailUrl, retryNonce]);

  return (
    <>
      {/* Размытая миниатюра, пока грузится основная картинка */}
      {previewSrc && !mainSrc && (
        <img
          src={previewSrc}
          alt={title}
          className="absolute max-w-[200px] max-h-[200px] object-contain rounded-lg opacity-40 blur-sm"
        />
      )}
      {loading && !mainSrc && !previewSrc && (
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-pink-500/30 border-t-pink-500 rounded-full animate-spin" />
          <span className="text-xs text-white/50">Загрузка...</span>
        </div>
      )}
      {mainSrc && (
        <img
          src={mainSrc}
          alt={title}
          className="max-w-full max-h-full object-contain select-none relative z-[1]"
        />
      )}
      {failed && (
        <div className="flex flex-col items-center gap-3 px-4 text-center">
          <ImageIcon className="w-10 h-10 text-pink-400/40" />
          <span className="text-xs text-white/50">Не удалось загрузить изображение</span>
          <button
            onClick={() => setRetryNonce(n => n + 1)}
            className="px-4 py-1.5 rounded-full bg-pink-500/20 hover:bg-pink-500/30 border border-pink-500/30 text-pink-200 text-xs font-medium transition-colors"
          >
            Повторить
          </button>
        </div>
      )}
    </>
  );
}
