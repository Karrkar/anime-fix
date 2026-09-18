'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Image from 'next/image';
import { Search, Star, ChevronLeft, ChevronRight, X, ImageIcon, List, Filter, SortAsc, Flame, Tag, ExternalLink, Gamepad2, MessageCircle } from 'lucide-react';
import { LilithChat } from '@/app/chat-widget';
import { ArtViewerImage, HentaiCard } from '@/components/adult/AdultCards';
import { AgeGate } from '@/components/adult/AgeGate';
import { ADULT_VERIFY_KEY, isVerificationValid } from '@/components/adult/adult-verify';
import { Rule34ArtCard } from '@/components/cards/ArtCards';
import { SkeletonGrid } from '@/components/ui';
import { Anime, ArtItem, Page, ParsedPost } from '@/lib/client-types';
import { BLUR_DATA_URL, apiFetch, parseGenres } from '@/lib/client-utils';


export function HentaiPage({ onOpen, favorites, onNavigate, toggleFav, hasSubscription }: {
  onOpen: (id: string) => void; favorites: Set<string>; onNavigate: (p: Page) => void; toggleFav: (id: string) => void; hasSubscription: boolean;
}) {
  const [verified, setVerified] = useState(isVerificationValid);
  const [allAnime, setAllAnime] = useState<Anime[]>([]);
  const [tab, setTab] = useState<'catalog' | 'arts' | 'games' | 'lilith'>('catalog');
  const [games, setGames] = useState<{id:string;title:string;titleRussian:string;description:string;imageUrl:string;sourceUrl:string;source:string}[]>([]);
  const [gamesSearch, setGamesSearch] = useState('');
  const [gamesLoading, setGamesLoading] = useState(false);
  const [arts, setArts] = useState<ArtItem[]>([]);
  const [artsRaw, setArtsRaw] = useState<ParsedPost[]>([]);

  // Viewer state
  const [viewerArt, setViewerArt] = useState<ParsedPost | null>(null);
  const [viewerFullImg, setViewerFullImg] = useState('');
  const [viewerFullTags, setViewerFullTags] = useState<string[]>([]);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerIsVideo, setViewerIsVideo] = useState(false);

  // Search & filter state (catalog)
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGenre, setSelectedGenre] = useState('');
  const [sortOrder, setSortOrder] = useState<'default' | 'az' | 'za' | 'episodes'>('default');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 24;

  // Arts state (rule34)
  const [artsTags, setArtsTags] = useState('');
  const [artsSearch, setArtsSearch] = useState('');
  const [artsPage, setArtsPage] = useState(1);
  const [artsTotalPages, setArtsTotalPages] = useState(1);
  const [artsTotal, setArtsTotal] = useState(0);
  const [artsLoading, setArtsLoading] = useState(false);
  const artsSearchRef = useRef<HTMLInputElement>(null);
  const artsTagsRef = useRef(artsTags);
  const artsPageRef = useRef(artsPage);
  artsTagsRef.current = artsTags;
  artsPageRef.current = artsPage;

  const [artsError, setArtsError] = useState('');

  // F-15 fix: самовосстановление — если localStorage-флаг ещё валиден,
  // а httpOnly-cookie age-гейта нет (например, cookies чистились),
  // тихо выставляем её снова, чтобы серверные 18+-маршруты отвечали 200
  useEffect(() => {
    if (isVerificationValid()) {
      fetch('/api/age-confirm', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    }
  }, []);

  const loadArts = useCallback(async (tags?: string, page?: number) => {
    const t = tags || artsTagsRef.current;
    const p = page || artsPageRef.current;
    const pid = (p - 1) * 42;
    setArtsLoading(true);
    setArtsError('');
    try {
      const d = await apiFetch<{ posts: ParsedPost[]; total: number; page: number; totalPages: number; error?: string }>(
        `/api/rule34?tags=${encodeURIComponent(t)}&pid=${pid}`
      );
      if (d.error || d.posts.length === 0) {
        setArtsError('Не удалось загрузить арты');
        setArts([]);
        setArtsRaw([]);
      } else {
        setArtsRaw(d.posts);
        setArts(d.posts.map(post => ({
          id: post.id, title: post.title, imageUrl: post.thumbnailUrl,
          artist: post.artist,
          tags: post.characters.join(', ') || post.tags.slice(0, 8).join(', '),
          isAdult: true, likes: post.score,
        })));
        setArtsTotal(d.total);
        setArtsTotalPages(d.totalPages);
      }
    } catch { setArtsError('Не удалось загрузить арты'); setArts([]); setArtsRaw([]); }
    setArtsLoading(false);
  }, []);

  // Track which posts are videos (pre-fetched from list thumbnails containing /videos/)
  const videoPostIds = useMemo(() => {
    const ids = new Set<string>();
    artsRaw.forEach(p => {
      if (p.thumbnailUrl?.includes('/videos/') || p.isVideo) ids.add(p.id);
    });
    return ids;
  }, [artsRaw]);

  // Open art viewer
  const openArtViewer = useCallback(async (post: ParsedPost) => {
    setViewerArt(post);
    setViewerFullImg('');
    setViewerFullTags(post.tags);
    setViewerLoading(true);
    setViewerIsVideo(false);
    try {
      const d = await apiFetch<{ imageUrl?: string; isVideo?: boolean; tags?: string[]; error?: string }>(
        `/api/rule34-post?id=${post.id}`
      );
      if (d.imageUrl) {
        setViewerFullImg(d.imageUrl);
        if (d.isVideo) setViewerIsVideo(true);
      }
      if (d.tags && d.tags.length > 0) setViewerFullTags(d.tags);
    } catch {}
    setViewerLoading(false);
  }, []);

  const closeArtViewer = useCallback(() => {
    setViewerArt(null);
    setViewerFullImg('');
    setViewerFullTags([]);
    setViewerIsVideo(false);
  }, []);

  const viewerIndex = viewerArt ? artsRaw.findIndex(a => a.id === viewerArt.id) : -1;
  const viewerPrev = viewerIndex > 0 ? artsRaw[viewerIndex - 1] : null;
  const viewerNext = viewerIndex < artsRaw.length - 1 ? artsRaw[viewerIndex + 1] : null;

  const navigateViewer = useCallback((dir: 'prev' | 'next') => {
    const target = dir === 'prev' ? viewerPrev : viewerNext;
    if (target) openArtViewer(target);
  }, [viewerPrev, viewerNext, openArtViewer]);

  // Load catalog data
  useEffect(() => {
    if (!verified || !hasSubscription || tab !== 'catalog') return;
    apiFetch<{ anime: Anime[]; total: number }>('/api/hentai?limit=200&offset=0').then(d => setAllAnime(d.anime)).catch(() => {});
  }, [verified, hasSubscription, tab]);

  // Load games data
  useEffect(() => {
    if (!verified || !hasSubscription || tab !== 'games') return;
    setGamesLoading(true);
    apiFetch<{ games: {id:string;title:string;titleRussian:string;description:string;imageUrl:string;sourceUrl:string;source:string}[]; total: number }>('/api/games?limit=200')
      .then(d => { setGames(d.games || []); setGamesLoading(false); })
      .catch(() => setGamesLoading(false));
  }, [verified, hasSubscription, tab]);

  // Keyboard nav for viewer
  useEffect(() => {
    if (!viewerArt) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeArtViewer();
      else if (e.key === 'ArrowLeft') navigateViewer('prev');
      else if (e.key === 'ArrowRight') navigateViewer('next');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [viewerArt, closeArtViewer, navigateViewer]);

  const handleArtsSearch = useCallback(() => {
    const query = artsSearch.trim();
    if (!query) return;
    setArtsTags(query);
    setArtsPage(1);
  }, [artsSearch]);

  // Auto-reload when tags or page change (for quick-filter buttons)
  useEffect(() => {
    if (!verified || !hasSubscription || tab !== 'arts') return;
    loadArts(artsTagsRef.current, artsPageRef.current);
  }, [artsTags, artsPage, verified, hasSubscription, tab, loadArts]);

  // Extract unique genres
  const genres = useMemo(() => {
    const s = new Set<string>();
    allAnime.forEach(a => parseGenres(a.genres).forEach(g => s.add(g)));
    return Array.from(s).filter(g => g !== '18+' && g !== 'Хентай').sort();
  }, [allAnime]);

  // Filter, search, sort
  const filteredAnime = useMemo(() => {
    let list = [...allAnime];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(a =>
        a.title.toLowerCase().includes(q) ||
        (a.titleRussian && a.titleRussian.toLowerCase().includes(q)) ||
        a.genres.toLowerCase().includes(q)
      );
    }
    if (selectedGenre) {
      list = list.filter(a => parseGenres(a.genres).includes(selectedGenre));
    }
    switch (sortOrder) {
      case 'az': list.sort((a, b) => a.title.localeCompare(b.title, 'ru')); break;
      case 'za': list.sort((a, b) => b.title.localeCompare(a.title, 'ru')); break;
      case 'episodes': list.sort((a, b) => b.episodes - a.episodes); break;
    }
    return list;
  }, [allAnime, searchQuery, selectedGenre, sortOrder]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredAnime.length / itemsPerPage));
  const paginatedAnime = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredAnime.slice(start, start + itemsPerPage);
  }, [filteredAnime, currentPage]);

  // Reset page when filters change
  useEffect(() => { setCurrentPage(1); }, [searchQuery, selectedGenre, sortOrder]);

  const handleVerify = useCallback(async () => {
    localStorage.setItem(ADULT_VERIFY_KEY, JSON.stringify({ ts: Date.now() }));
    // ФИКС race condition «0 из 0 тайтлов»: раньше setVerified(true) срабатывал
    // мгновенно, а серверная cookie ставилась асинхронным POST — каталог
    // успевал запросить /api/hentai БЕЗ anime_age_confirmed, получал 403
    // и оставался пустым до перезагрузки страницы. Теперь сначала дожидаемся
    // установки cookie, потом открываем контент.
    try {
      await fetch('/api/age-confirm', { method: 'POST', credentials: 'same-origin' });
    } catch { /* серверная половина подтянется самовосстановлением F-15
                 при следующей загрузке (useEffect ниже перешлёт POST) */ }
    setVerified(true);
  }, []);

  const handleDecline = useCallback(() => { onNavigate('home'); }, [onNavigate]);

  // 18+ по подписке: нужен и возрастной гейт, и активная подписка.
  // AgeGate сам покажет нужную ветку: без подписки — пейволл с кнопкой
  // «Оформить подписку», с подпиской — подтверждение возраста.
  if (!verified || !hasSubscription) return <AgeGate onVerify={handleVerify} onDecline={handleDecline} hasSubscription={hasSubscription} onGoToProfile={() => onNavigate('profile')} />;

  return (
    <div className="animate-fade-in">
      {/* Header with gradient accent */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-pink-600 flex items-center justify-center shadow-lg shadow-red-500/20">
            <Flame className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold">Контент для взрослых</h1>
            <p className="text-xs text-[var(--muted-foreground)]">{tab === 'catalog' ? `${filteredAnime.length} из ${allAnime.length} тайтлов` : tab === 'arts' ? `${artsTotal} артов` : tab === 'games' ? `${games.length} игр` : 'твой личный суккуб-хранитель'}</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {([['catalog', 'Каталог', List], ['games', 'Игры', Gamepad2], ['arts', 'Арты', ImageIcon], ['lilith', 'Лилит', MessageCircle]] as const).map(([t, label, Icon]) => (
          <button
            key={t} onClick={() => { setTab(t as 'catalog' | 'arts' | 'games' | 'lilith'); setCurrentPage(1); }}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${tab === t
              ? 'bg-gradient-to-r from-red-600 to-pink-600 text-white shadow-lg shadow-red-500/20'
              : 'bg-[var(--card)] border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)]'}`}
          >
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'lilith' ? (
        /* ── Lilith Tab: чат с суккубом, только внутри 18+ ── */
        <div className="max-w-2xl mx-auto">
          <LilithChat />
        </div>
      ) : tab === 'games' ? (
        /* ── Games Tab ── */
        <>
          <div className="mb-4 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
            <input
              value={gamesSearch}
              onChange={e => setGamesSearch(e.target.value)}
              placeholder="Поиск игр..."
              className="w-full pl-10 pr-10 py-2.5 rounded-xl bg-[var(--card)] border border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-pink-500/50 focus:ring-1 focus:ring-pink-500/20 transition-all"
            />
            {gamesSearch && (
              <button onClick={() => setGamesSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          {gamesLoading ? <SkeletonGrid count={12} cols="grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6" gap="gap-2 sm:gap-3" /> : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2 sm:gap-3">
              {games.filter(g => !gamesSearch || g.title.toLowerCase().includes(gamesSearch.toLowerCase())).map(g => (
                <a key={g.id} href={g.sourceUrl} target="_blank" rel="noopener noreferrer" className="group">
                  <div className="relative aspect-[3/4] rounded-xl overflow-hidden bg-[var(--muted)] border border-[var(--border)] group-hover:border-pink-500/40 transition-all">
                    {g.imageUrl ? (
                      <Image src={g.imageUrl} alt={g.title} fill sizes="(max-width: 768px) 33vw, 16vw" placeholder="blur" blurDataURL={BLUR_DATA_URL} className="object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center"><Gamepad2 className="w-10 h-10 text-[var(--muted-foreground)] opacity-30" /></div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                    <div className="absolute bottom-0 left-0 right-0 p-2">
                      <p className="text-xs font-medium text-white line-clamp-2 leading-tight">{g.title}</p>
                      {g.source && <p className="text-[10px] text-white/50 mt-0.5 capitalize">{g.source}</p>}
                    </div>
                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="w-7 h-7 rounded-lg bg-black/60 flex items-center justify-center backdrop-blur-sm">
                        <ExternalLink className="w-3 h-3 text-white" />
                      </div>
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </>
      ) : tab === 'catalog' ? (
        <>
          {/* Search & Filters Bar */}
          <div className="mb-6 space-y-3">
            {/* Search */}
            <form onSubmit={(e) => e.preventDefault()} className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Поиск по названию или жанру..."
                className="w-full pl-10 pr-10 py-2.5 rounded-xl bg-[var(--card)] border border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-pink-500/50 focus:ring-1 focus:ring-pink-500/20 transition-all"
              />
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                  <X className="w-4 h-4" />
                </button>
              )}
            </form>

            <div className="flex flex-wrap items-center gap-2">
              {/* Genre filter chips — horizontal scroll on mobile */}
              <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
                <Tag className="w-3.5 h-3.5 text-[var(--muted-foreground)] flex-shrink-0" />
                <button
                  onClick={() => setSelectedGenre('')}
                  className={`text-xs px-2.5 py-1 rounded-lg transition-all flex-shrink-0 ${!selectedGenre
                    ? 'bg-pink-500/20 text-pink-400 font-medium'
                    : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'}`}
                >Все</button>
                {genres.slice(0, 12).map(g => (
                  <button
                    key={g} onClick={() => setSelectedGenre(selectedGenre === g ? '' : g)}
                    className={`text-xs px-2.5 py-1 rounded-lg transition-all flex-shrink-0 ${selectedGenre === g
                      ? 'bg-pink-500/20 text-pink-400 font-medium'
                      : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'}`}
                  >{g}</button>
                ))}
              </div>

              {/* Sort dropdown */}
              <div className="relative flex-shrink-0">
                <select
                  value={sortOrder}
                  onChange={e => setSortOrder(e.target.value as typeof sortOrder)}
                  className="appearance-none pl-8 pr-8 py-1.5 rounded-lg bg-[var(--card)] border border-[var(--border)] text-xs text-[var(--foreground)] focus:outline-none focus:border-pink-500/50 cursor-pointer"
                >
                  <option value="default">По умолчанию</option>
                  <option value="az">А → Я</option>
                  <option value="za">Я → А</option>
                  <option value="episodes">По сериям</option>
                </select>
                <SortAsc className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--muted-foreground)] pointer-events-none" />
              </div>
            </div>
          </div>

          {/* Results */}
          {allAnime.length === 0 ? <SkeletonGrid count={12} cols="grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6" gap="gap-2 sm:gap-3" /> : (
            <>
              {filteredAnime.length === 0 ? (
                <div className="text-center py-16 text-[var(--muted-foreground)]">
                  <Search className="w-12 h-12 mx-auto mb-4 opacity-30" />
                  <p>Ничего не найдено</p>
                  <button onClick={() => { setSearchQuery(''); setSelectedGenre(''); }} className="mt-3 text-sm text-pink-400 hover:underline">Сбросить фильтры</button>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2 sm:gap-3 mb-6 grid-stagger">
                    {paginatedAnime.map(a => (
                      <HentaiCard key={a.id} anime={a} onOpen={onOpen} onFav={toggleFav} isFav={favorites.has(a.id)} />
                    ))}
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage <= 1}
                        className="p-2 rounded-lg bg-[var(--card)] border border-[var(--border)] hover:bg-[var(--muted)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      {/* Page numbers with smart truncation */}
                      {Array.from({ length: totalPages }, (_, i) => i + 1)
                        .filter(p => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1)
                        .map((p, i, arr) => (
                          <span key={p} className="flex items-center gap-2">
                            {i > 0 && arr[i - 1] !== p - 1 && <span className="text-[var(--muted-foreground)] text-xs">...</span>}
                            <button
                              onClick={() => setCurrentPage(p)}
                              className={`w-9 h-9 rounded-lg text-sm font-medium transition-all ${currentPage === p
                                ? 'bg-gradient-to-r from-red-600 to-pink-600 text-white shadow-lg shadow-red-500/20'
                                : 'bg-[var(--card)] border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)]'}`}
                            >{p}</button>
                          </span>
                        ))}
                      <button
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage >= totalPages}
                        className="p-2 rounded-lg bg-[var(--card)] border border-[var(--border)] hover:bg-[var(--muted)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </>
      ) : (
        /* ── Arts Tab (Rule34) ── */
        <>
          {/* Search bar */}
          <form onSubmit={e => { e.preventDefault(); handleArtsSearch(); }} className="mb-4 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
            <input
              ref={artsSearchRef}
              value={artsSearch}
              onChange={e => setArtsSearch(e.target.value)}
              placeholder="Поиск по тегам, авторам, персонажам..."
              className="w-full pl-10 pr-10 py-2.5 rounded-xl bg-[var(--card)] border border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-pink-500/50 focus:ring-1 focus:ring-pink-500/20 transition-all"
            />
            {artsSearch && (
              <button type="button" onClick={() => { setArtsSearch(''); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                <X className="w-4 h-4" />
              </button>
            )}
          </form>

          {/* Active tag + quick filters */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
              <Tag className="w-3.5 h-3.5 text-[var(--muted-foreground)] flex-shrink-0" />
              <span className="text-xs text-pink-400 font-medium">{artsTags === 'all' || !artsTags ? 'Все художники' : `Тег: ${artsTags}`}</span>
            </div>
            <span className="text-xs text-[var(--muted-foreground)] flex-shrink-0">{artsTotal} результатов, {artsTotalPages} стр.</span>
          </div>
          {/* Quick filter tags - scrollable on mobile */}
          <div className="flex gap-1.5 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible">
            {[{ tag: 'arzagod', label: 'Arzagod' }, { tag: 'balecxi', label: 'Balecxi' }, { tag: 'kaistar', label: 'Kaistar' }, { tag: 'kinkimya', label: 'Kinkimya' }, { tag: 'rognezart', label: 'Rognezart' }, { tag: 'hypet', label: 'Hypet' }, { tag: 'backdoorsenpai', label: 'Backdoorsenpai' }, { tag: 'milfhunter228', label: 'Milfhunter228' }, { tag: 'all', label: 'Все художники' }].map(t => (
              <button
                key={t.tag}
                onClick={() => { setArtsTags(t.tag); setArtsSearch(t.tag === 'all' ? '' : t.tag); setArtsPage(1); }}
                className={`text-[11px] px-2.5 py-1.5 rounded-lg transition-all flex-shrink-0 whitespace-nowrap border ${artsTags === t.tag
                  ? 'bg-pink-500/20 text-pink-400 font-medium border-pink-500/30'
                  : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] border-transparent'}`}
              >{t.label}</button>
            ))}
          </div>

          {/* Gallery grid */}
          {artsLoading ? <SkeletonGrid count={14} cols="grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7" aspect="aspect-square" gap="gap-2 sm:gap-3" /> : arts.length === 0 ? (
            <div className="text-center py-16 text-[var(--muted-foreground)]">
              <Search className="w-12 h-12 mx-auto mb-4 opacity-30" />
              <p>{artsError ? `Ошибка: ${artsError}` : 'Ничего не найдено'}</p>
              <p className="text-sm mt-1">Попробуйте другие теги на английском</p>
              {artsError && (
                <a
                  href={`https://rule34.xxx/index.php?page=post&s=list&tags=${encodeURIComponent(artsTags)}`}
                  target="_blank" rel="noopener noreferrer"
                  className="inline-block mt-3 text-sm text-pink-400 hover:underline"
                >
                  Открыть на rule34.xxx <ExternalLink className="w-3 h-3 inline" />
                </a>
              )}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 gap-2 sm:gap-3 mb-6 grid-stagger">
                {arts.map((a, i) => (
                  <Rule34ArtCard key={a.id} art={a} isVideo={videoPostIds.has(a.id)} onClick={() => artsRaw[i] && openArtViewer(artsRaw[i])} />
                ))}
              </div>

              {/* Pagination */}
              {artsTotalPages > 1 && (
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={() => { const np = Math.max(1, artsPage - 1); setArtsPage(np); }}
                    disabled={artsPage <= 1}
                    className="p-2 rounded-lg bg-[var(--card)] border border-[var(--border)] hover:bg-[var(--muted)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  {Array.from({ length: Math.min(artsTotalPages, 9) }, (_, i) => {
                    let p: number;
                    if (artsTotalPages <= 9) { p = i + 1; }
                    else if (artsPage <= 5) { p = i + 1; }
                    else if (artsPage >= artsTotalPages - 4) { p = artsTotalPages - 8 + i; }
                    else { p = artsPage - 4 + i; }
                    return (
                      <span key={p} className="flex items-center gap-1">
                        {i > 0 && p !== (i === 1 ? 1 : 0) + 1 && <span className="text-[var(--muted-foreground)] text-xs">...</span>}
                        <button
                          onClick={() => { setArtsPage(p); }}
                          className={`w-9 h-9 rounded-lg text-sm font-medium transition-all ${artsPage === p
                            ? 'bg-gradient-to-r from-red-600 to-pink-600 text-white shadow-lg shadow-red-500/20'
                            : 'bg-[var(--card)] border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)]'}`}
                        >{p}</button>
                      </span>
                    );
                  })}
                  <button
                    onClick={() => { const np = Math.min(artsTotalPages, artsPage + 1); setArtsPage(np); }}
                    disabled={artsPage >= artsTotalPages}
                    className="p-2 rounded-lg bg-[var(--card)] border border-[var(--border)] hover:bg-[var(--muted)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              )}
            </>
          )}

        </>
      )}

      {/* Art Viewer Lightbox */}
      <AnimatePresence>
        {viewerArt && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex flex-col"
            onClick={(e) => { if (e.target === e.currentTarget) closeArtViewer(); }}
          >
            {/* Top bar */}
            <div className="flex items-center justify-between px-3 py-2 sm:px-4 sm:py-3 shrink-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="text-pink-400 text-xs sm:text-sm font-medium truncate">
                  {viewerArt.artist}{viewerArt.characters.length > 0 ? ` \u2014 ${viewerArt.characters.join(', ')}` : ''}
                </span>
                {viewerArt.score > 0 && (
                  <span className="flex items-center gap-0.5 text-[10px] sm:text-xs text-yellow-400 shrink-0">
                    <Star className="w-3 h-3" />{viewerArt.score}
                  </span>
                )}
                <span className="text-[10px] text-white/40 shrink-0">
                  {viewerIndex + 1}/{artsRaw.length}
                </span>
              </div>
              <a
                href={viewerArt.postUrl}
                target="_blank" rel="noopener noreferrer"
                className="text-[10px] sm:text-xs text-white/40 hover:text-pink-400 transition-colors flex items-center gap-1 shrink-0 mr-2"
                onClick={e => e.stopPropagation()}
              >
                rule34.xxx <ExternalLink className="w-3 h-3" />
              </a>
              <button
                onClick={closeArtViewer}
                className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors shrink-0"
              >
                <X className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>
            </div>

            {/* Image area */}
            <div className="flex-1 flex items-center justify-center relative min-h-0 px-2 sm:px-4">
              {viewerPrev && (
                <button
                  onClick={(e) => { e.stopPropagation(); navigateViewer('prev'); }}
                  className="absolute left-1 sm:left-3 top-1/2 -translate-y-1/2 z-10 p-2 sm:p-3 rounded-full bg-black/40 hover:bg-black/60 text-white/70 hover:text-white transition-all"
                >
                  <ChevronLeft className="w-5 h-5 sm:w-6 sm:h-6" />
                </button>
              )}
              {viewerNext && (
                <button
                  onClick={(e) => { e.stopPropagation(); navigateViewer('next'); }}
                  className="absolute right-1 sm:right-3 top-1/2 -translate-y-1/2 z-10 p-2 sm:p-3 rounded-full bg-black/40 hover:bg-black/60 text-white/70 hover:text-white transition-all"
                >
                  <ChevronRight className="w-5 h-5 sm:w-6 sm:h-6" />
                </button>
              )}
              {viewerLoading ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-8 h-8 border-3 border-pink-500/30 border-t-pink-500 rounded-full animate-spin" />
                  <span className="text-xs text-white/50">\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430...</span>
                </div>
              ) : viewerIsVideo && viewerFullImg ? (
                <video
                  key={viewerFullImg}
                  src={`/api/r34img?url=${encodeURIComponent(viewerFullImg)}`}
                  className="max-w-full max-h-full object-contain select-none rounded-lg"
                  autoPlay loop muted playsInline
                  controls
                  preload="auto"
                >
                  <source src={`/api/r34img?url=${encodeURIComponent(viewerFullImg)}`} />
                  Ваш браузер не поддерживает видео.
                </video>
              ) : (
                <ArtViewerImage
                  fullImgUrl={viewerFullImg}
                  thumbnailUrl={viewerArt.thumbnailUrl}
                  title={viewerArt.title}
                />
              )}
            </div>

            {/* Tags bar — scrollable on mobile */}
            {viewerFullTags.length > 0 && (
              <div className="shrink-0 border-t border-white/10">
                <div className="flex flex-wrap gap-1 max-h-20 sm:max-h-24 overflow-y-auto px-3 py-2 sm:px-4 sm:py-3">
                  {viewerFullTags.slice(0, 50).map((tag, i) => (
                    <button
                      key={`${tag}-${i}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        const tagStr = tag.replace(/ /g, '_');
                        setArtsTags(tagStr);
                        setArtsSearch(tagStr);
                        setArtsPage(1);
                        closeArtViewer();
                      }}
                      className="text-[10px] sm:text-xs px-2 py-0.5 rounded-full bg-white/10 hover:bg-pink-500/30 text-white/70 hover:text-white transition-colors truncate max-w-[120px] sm:max-w-none"
                    >
                      {tag}
                    </button>
                  ))}
                  {viewerFullTags.length > 50 && (
                    <span className="text-[10px] text-white/40 px-2 py-0.5">
                      +{viewerFullTags.length - 50}
                    </span>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
