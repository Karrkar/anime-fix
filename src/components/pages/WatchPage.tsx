'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Image from 'next/image';
import { Play, Star, ChevronLeft, ChevronRight, Film, BookmarkPlus, BookmarkCheck, Sparkles, SkipForward } from 'lucide-react';
import { AnimeCard } from '@/components/cards/AnimeCard';
import { SkeletonCard, SkeletonLine } from '@/components/ui';
import { Anime } from '@/lib/client-types';
import { BLUR_DATA_URL, authHeaders, isValidUrl, parseGenres } from '@/lib/client-utils';

export function WatchPage({ animeId, initialEp = 1, onBack, onOpen, favorites, toggleFav }: {
  animeId: string; initialEp?: number; onBack: () => void; onOpen: (id: string, ep?: number) => void;
  favorites: Set<string>; toggleFav: (id: string) => void;
}) {
  const [anime, setAnime] = useState<Anime | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeEp, setActiveEp] = useState(initialEp || 1);
  const [similar, setSimilar] = useState<Anime[]>([]);
  // F-24 fix: был лишний [] в типе (массив массивов) — 14 ошибок tsc,
  // скрытых ignoreBuildErrors; runtime не падал только из-за динамических типов JS
  const [eps, setEps] = useState<Array<{id:string; title:string; episodeNumber:number; embedUrl:string; thumbnailUrl:string; duration:string}>>([]);

  // Загружаем данные при смене animeId
  useEffect(() => {
    if (!animeId) return;
    setLoading(true);
    setError('');
    setActiveEp(initialEp || 1);
    setEps([]);
    setSimilar([]);
    fetch(`/api/anime?id=${animeId}`)
      .then(r => { if (!r.ok) throw new Error('Not found'); return r.json(); })
      .then(d => {
        setAnime(d.anime);
        const a = d.anime as Anime;
        // Серии для db-тайтлов: embed_url — это страница vost.pw, плеер
        // собирается через /api/player-proxy?url=...&episode=N, поэтому
        // список 1..N синтезируется из поля episodes. Раньше db-тайтлы
        // вообще не играли (эндпоинт эпизодов знал только статику).
        if (animeId.startsWith('db-')) {
          const src = a.sourceUrl || '';
          const n = Math.min(a.episodes || 0, 300);
          if (src && n > 0) {
            setEps(Array.from({ length: n }, (_, i) => ({
              id: `ep-${i + 1}`,
              title: `${i + 1} серия`,
              episodeNumber: i + 1,
              embedUrl: src,
              thumbnailUrl: '',
              duration: '',
            })));
          }
          return null; // статический эндпоинт эпизодов не нужен
        }
        // Загружаем эпизоды через отдельный эндпоинт (статические данные)
        return fetch(`/api/anime-episodes?animeId=${animeId}`);
      })
      .then(r => r ? r.json() : null)
      .then(epData => {
        if (epData && epData.episodes && epData.episodes.length > 0) {
          setEps(epData.episodes.map(ep => ({
            id: `ep-${ep.episodeNumber}`,
            title: ep.title || `${ep.episodeNumber} серия`,
            episodeNumber: ep.episodeNumber,
            embedUrl: ep.embedUrl || '',
            thumbnailUrl: ep.thumbnailUrl || '',
            duration: ep.duration || '',
          })));
        }
      })
      .catch(e => console.error('Failed to load episodes:', e))
      .finally(() => setLoading(false));
    // «Похожее» — один SQL-запрос по пересечению жанров
    fetch(`/api/similar?id=${animeId}&limit=6`)
      .then(r => r.ok ? r.json() : { anime: [] })
      .then(d => setSimilar(d.anime || []))
      .catch(() => {});
  }, [animeId, initialEp]);

  // Синхронизация истории: пишем серию при открытии и каждой смене
  // (для неавторизованных сервер вернёт 401 — тихо игнорируем)
  useEffect(() => {
    if (!animeId || loading) return;
    fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ animeId, episodeNumber: activeEp }),
    }).catch(() => {});
  }, [animeId, activeEp, loading]);

  // Show all episodes (don't filter by URL validity — vost.pw URLs are page links, not embed URLs)
  const episodes = useMemo(() => {
    if (eps.length === 0) return [];
    return eps.sort((a, b) => a.episodeNumber - b.episodeNumber);
  }, [eps]);

  const currentEp = useMemo(() => episodes.find(ep => ep.episodeNumber === activeEp) || episodes[0] || null, [episodes, activeEp]);

  // Build player URL using proxy for vost.pw sources
  const playerUrl = useMemo(() => {
    if (!currentEp || !anime) return null;
    const srcUrl = currentEp.embedUrl;
    if (!srcUrl) return null;
    // ФИКС плеера 18+: контент hentaibaza (страницы /watch/N и прямые mp4
    // с cloude.hentaibaza.com) играем через собственный /api/hb-player —
    // CSP frame-src блокирует iframe с чужих доменов, из-за чего плеер
    // хентай показывал чёрный экран. hb-player отдаёт свою HTML5-страницу
    // с прямой ссылкой на видео (см. src/app/api/hb-player/route.ts).
    if (/hentaibaza\.com/i.test(srcUrl)) {
      return `/api/hb-player?url=${encodeURIComponent(srcUrl)}`;
    }
    // If it's a direct embeddable URL (mp4, etc.), use it directly
    if (/\.(mp4|m3u8|webm)(\?|$)/i.test(srcUrl)) return srcUrl;
    // For vost.pw and similar pages, use the server-side proxy
    if (srcUrl.includes('vost.pw')) {
      return `/api/player-proxy?url=${encodeURIComponent(srcUrl)}&episode=${currentEp.episodeNumber}`;
    }
    return srcUrl;
  }, [currentEp, anime]);
  // ИСПРАВЛЕНИЕ БАГА #2: key={animeId} на контейнере гарантирует перемонтирование */

  // ── Автопереход на следующую серию ──
  const [autoNext, setAutoNext] = useState(true);
  const [autoNextLeft, setAutoNextLeft] = useState<number | null>(null);

  useEffect(() => {
    try { const v = localStorage.getItem('anime_auto_next'); if (v !== null) setAutoNext(v === '1'); } catch {}
  }, []);

  const toggleAutoNext = useCallback(() => {
    setAutoNext(v => {
      const nv = !v;
      try { localStorage.setItem('anime_auto_next', nv ? '1' : '0'); } catch {}
      return nv;
    });
  }, []);

  const nextEpisode = useMemo(() => {
    if (!currentEp) return null;
    return episodes.find(ep => ep.episodeNumber === currentEp.episodeNumber + 1) || null;
  }, [currentEp, episodes]);

  useEffect(() => {
    if (!autoNext || !nextEpisode || !currentEp) { setAutoNextLeft(null); return; }
    // Длительность из метаданных серии («24:30») или дефолт 24 минуты
    const m = currentEp.duration ? currentEp.duration.match(/(\d{1,3}):(\d{2})/) : null;
    const durSec = m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 24 * 60;
    setAutoNextLeft(durSec);
    const iv = setInterval(() => {
      setAutoNextLeft(left => {
        if (left === null) return null;
        if (left <= 1) {
          setActiveEp(nextEpisode.episodeNumber);
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return null;
        }
        return left - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [autoNext, nextEpisode, currentEp]);

  const mmss = useCallback((s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, []);

  const goToEpisode = useCallback((epNum: number) => {
    setActiveEp(epNum);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  if (loading) return (
    <div className="animate-fade-in">
      <SkeletonLine className="h-4 w-20 mb-4" />
      <div className="flex flex-col lg:flex-row gap-4 sm:gap-6">
        <div className="flex-1 w-full">
          <div className="w-full aspect-video rounded-xl bg-[var(--card)] border border-[var(--border)] animate-pulse" />
        </div>
        <div className="hidden lg:block w-80 space-y-4">
          <SkeletonCard aspect="aspect-[3/4]" />
        </div>
      </div>
    </div>
  );
  if (error || !anime) return (
    <div className="text-center py-20 animate-fade-in">
      <h2 className="text-2xl font-bold mb-2">Аниме не найдено</h2>
      <p className="text-[var(--muted-foreground)] mb-6">{error || 'Не удалось загрузить данные.'}</p>
      <button onClick={onBack} className="accent-btn">← Вернуться в каталог</button>
    </div>
  );

  // ИСПРАВЛЕНИЕ БАГА #1: parseGenres() превращает строку в массив
  const genres = parseGenres(anime.genres);

  return (
    <div key={animeId} className="animate-fade-in">
      {/* ИСПРАВЛЕНИЕ БАГА #2: key={animeId} на контейнере гарантирует перемонтирование */}
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] mb-4 transition-colors">
        <ChevronLeft className="w-4 h-4" /> Назад
      </button>

      <div className="flex flex-col lg:flex-row gap-4 sm:gap-6">
        {/* Mobile: compact info bar above player */}
        <div className="lg:hidden flex gap-3 items-start">
          <div className="w-16 sm:w-20 flex-shrink-0 rounded-lg overflow-hidden bg-[var(--muted)] border border-[var(--border)]">
            {anime.imageUrl ? (
              <div className="relative w-full aspect-[3/4]">
                <Image src={anime.imageUrl} alt={anime.title} fill sizes="80px" placeholder="blur" blurDataURL={BLUR_DATA_URL} className="object-cover" />
              </div>
            ) : (
              <div className="w-full aspect-[3/4] flex items-center justify-center"><Film className="w-6 h-6 text-[var(--muted-foreground)]" /></div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-base sm:text-lg font-bold leading-tight mb-1 line-clamp-2">{anime.title}</h1>
            {anime.titleRussian && <p className="text-xs text-[var(--muted-foreground)] mb-1.5 line-clamp-1">{anime.titleRussian}</p>}
            <div className="flex flex-wrap gap-1.5 mb-2">
              <span className="text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 bg-[var(--muted)] rounded text-[var(--muted-foreground)]">{anime.type}</span>
              <span className="text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 bg-[var(--muted)] rounded text-[var(--muted-foreground)]">{anime.episodes} серий</span>
              {anime.score > 0 && (
                <span className="text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 bg-[var(--primary)]/20 text-[var(--primary)] rounded font-medium flex items-center gap-0.5"><Star className="w-2.5 h-2.5" /> {anime.score}</span>
              )}
            </div>
            <button onClick={() => toggleFav(anime.id)} className={`text-xs px-3 py-1.5 rounded-lg border flex items-center gap-1.5 transition-colors ${favorites.has(anime.id) ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'border-[var(--border)] text-[var(--muted-foreground)]'}`}>
              {favorites.has(anime.id) ? <BookmarkCheck className="w-3.5 h-3.5" /> : <BookmarkPlus className="w-3.5 h-3.5" />}
              {favorites.has(anime.id) ? 'В избранном' : 'В избранное'}
            </button>
          </div>
        </div>

        {/* Player */}
        <div className="flex-1 w-full">
          {playerUrl ? (
            <div className="video-container">
              <iframe key={playerUrl} src={playerUrl} title={`Episode ${currentEp?.episodeNumber || activeEp}`} allowFullScreen allow="autoplay; encrypted-media" />
            </div>
          ) : (
            <div className="w-full aspect-video bg-[var(--card)] rounded-xl flex items-center justify-center text-[var(--muted-foreground)]">
              <div className="text-center"><Play className="w-12 h-12 sm:w-16 sm:h-16 mx-auto mb-3 sm:mb-4 opacity-30" /><p>Нет доступных серий</p></div>
            </div>
          )}
          {currentEp && (
            <div className="mt-2 sm:mt-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm sm:text-lg font-semibold">Серия {currentEp.episodeNumber}{currentEp.title && currentEp.title !== `${currentEp.episodeNumber} серия` ? `: ${currentEp.title}` : ''}</h2>
              <div className="flex items-center gap-2">
                {autoNextLeft !== null && (
                  <button onClick={toggleAutoNext} className="text-xs px-2.5 py-1 rounded-lg bg-[var(--primary)]/15 text-[var(--primary)] font-medium flex items-center gap-1.5" title="Отменить автопереход">
                    <SkipForward className="w-3.5 h-3.5" /> След. через {mmss(autoNextLeft)}
                  </button>
                )}
                {nextEpisode && (
                  <button onClick={() => goToEpisode(nextEpisode.episodeNumber)} className="text-xs px-3 py-1.5 rounded-lg accent-btn flex items-center gap-1">
                    Следующая серия <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Desktop sidebar info */}
        <div className="hidden lg:block w-full lg:w-80 space-y-4">
          <div className="rounded-xl overflow-hidden bg-[var(--card)] border border-[var(--border)]">
            {anime.imageUrl ? (
              <div className="relative w-full aspect-[3/4]">
                <Image src={anime.imageUrl} alt={anime.title} fill sizes="320px" placeholder="blur" blurDataURL={BLUR_DATA_URL} className="object-cover" />
              </div>
            ) : (
              <div className="w-full aspect-[3/4] bg-[var(--muted)] flex items-center justify-center"><Film className="w-16 h-16 text-[var(--muted-foreground)]" /></div>
            )}
          </div>
          <div>
            <h1 className="text-xl font-bold mb-1">{anime.title}</h1>
            {anime.titleRussian && <p className="text-[var(--muted-foreground)] mb-3">{anime.titleRussian}</p>}
            <div className="flex flex-wrap gap-2 mb-3">
              <span className="text-xs px-2 py-0.5 bg-[var(--muted)] rounded text-[var(--muted-foreground)]">{anime.type}</span>
              <span className="text-xs px-2 py-0.5 bg-[var(--muted)] rounded text-[var(--muted-foreground)]">{anime.episodes} серий</span>
              {anime.score > 0 && (
                <span className="text-xs px-2 py-0.5 bg-[var(--primary)]/20 text-[var(--primary)] rounded font-medium flex items-center gap-1"><Star className="w-3 h-3" /> {anime.score}</span>
              )}
            </div>
            {genres.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-3">
                {genres.map(g => (
                  <button key={g} onClick={() => {}} className="text-xs px-2 py-0.5 bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--primary)] rounded transition-colors">{g}</button>
                ))}
              </div>
            )}
            <p className="text-sm text-[var(--muted-foreground)] leading-relaxed whitespace-pre-line line-clamp-3">{anime.description.replace(/<[^>]*>/g, '')}</p>
            <button onClick={() => toggleFav(anime.id)} className={`mt-4 w-full py-2 rounded-lg border flex items-center justify-center gap-2 transition-colors ${favorites.has(anime.id) ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)]'}`}>
              {favorites.has(anime.id) ? <BookmarkCheck className="w-4 h-4" /> : <BookmarkPlus className="w-4 h-4" />}
              {favorites.has(anime.id) ? 'В избранном' : 'В избранное'}
            </button>
          </div>
        </div>
      </div>

      {/* Episodes list с миниатюрами */}
      {episodes.length > 0 && (
        <section className="mt-4 sm:mt-8">
          <div className="flex items-center justify-between mb-2 sm:mb-3">
            <h3 className="text-base sm:text-lg font-bold">Серии ({episodes.length})</h3>
            {episodes.length > 1 && (
              <button
                onClick={toggleAutoNext}
                className={`text-[11px] sm:text-xs px-2.5 py-1.5 rounded-lg border transition-colors flex items-center gap-1.5 ${autoNext ? 'bg-[var(--primary)]/15 border-[var(--primary)]/30 text-[var(--primary)] font-medium' : 'border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'}`}
                title="Автоматически включать следующую серию по окончании таймера"
              >
                <SkipForward className="w-3.5 h-3.5" /> Автопереход: {autoNext ? 'вкл' : 'выкл'}
              </button>
            )}
          </div>
          {/* Mobile: горизонтальная лента; Desktop: сетка с миниатюрами */}
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 sm:grid sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 sm:overflow-visible">
            {episodes.map(ep => {
              const hasThumb = !!ep.thumbnailUrl && isValidUrl(ep.thumbnailUrl);
              const isActive = activeEp === ep.episodeNumber;
              return (
                <button
                  key={ep.id}
                  onClick={() => goToEpisode(ep.episodeNumber)}
                  className={`group flex-shrink-0 sm:flex-shrink w-36 sm:w-auto rounded-lg overflow-hidden border text-left transition-all ${isActive ? 'border-[var(--primary)] ring-1 ring-[var(--primary)]' : 'border-[var(--border)] hover:border-[var(--primary)]/40'}`}
                >
                  <div className="relative aspect-video bg-[var(--muted)]">
                    {hasThumb ? (
                      <Image src={ep.thumbnailUrl} alt={ep.title} fill sizes="144px" placeholder="blur" blurDataURL={BLUR_DATA_URL} className="object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <span className={`text-lg font-bold ${isActive ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)]/60'}`}>{ep.episodeNumber}</span>
                      </div>
                    )}
                    <span className="absolute bottom-1 right-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-black/60 text-white">{ep.episodeNumber}</span>
                    {isActive && <div className="absolute inset-0 bg-[var(--primary)]/15 pointer-events-none" />}
                    {!isActive && (
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <Play className="w-6 h-6 text-white drop-shadow" fill="white" />
                      </div>
                    )}
                  </div>
                  <p className={`hidden sm:block px-2 py-1.5 text-[11px] line-clamp-1 ${isActive ? 'text-[var(--primary)] font-medium' : 'text-[var(--muted-foreground)]'}`}>{ep.title}</p>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Похожее — по пересечению жанров */}
      {similar.length > 0 && (
        <section className="mt-6 sm:mt-10">
          <h3 className="text-base sm:text-lg font-bold mb-3 flex items-center gap-2"><Sparkles className="w-4 h-4 text-yellow-400" /> Похожее</h3>
          <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-6 gap-2.5 sm:gap-4">
            {similar.map(a => <AnimeCard key={a.id} anime={a} onOpen={onOpen} onFav={() => {}} isFav={favorites.has(a.id)} />)}
          </div>
        </section>
      )}
    </div>
  );
}
