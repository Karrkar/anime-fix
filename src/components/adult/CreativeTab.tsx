'use client';

/**
 * Вкладка «Креатив» — арты из Telegram-каналов (v2).
 *
 * Читает /api/creative: страницы по курсору, метаданные каналов со счётчиками.
 *
 * v2:
 *  - masonry-сетка (CSS columns) с точным резервированием пропорций (photoDims),
 *    плитки разной высоты — альбомы и вертикальные арты выглядят как положено;
 *  - бесконечный скролл (IntersectionObserver) + кнопка «Показать ещё»;
 *  - лайтбокс: подпись поста, канал/дата, ссылка на оригинал в Telegram,
 *    миниатюры альбома, счётчик, свайп/драг, предзагрузка соседей;
 *  - чипы каналов со счётчиками постов, общий счётчик ленты.
 * Дедуп постов между страницами — по id (Set).
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft, ChevronRight, Images, Layers, Play, Sparkles, X, ExternalLink,
} from 'lucide-react';

export interface PhotoDims { w: number; h: number }

export interface CreativePost {
  id: string;
  channel: string;
  channelTitle: string;
  msgId: number;
  date: string;
  caption: string;
  photos: string[];
  photoDims?: Array<PhotoDims | null>;
  videoPoster?: string;
  posterDims?: PhotoDims | null;
  postUrl: string;
}

export interface CreativeChannel { id: string; title: string; count?: number }

function legacyAuthHeaders(): Record<string, string> {
  try {
    const t = localStorage.getItem('anime_platform_token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

async function apiJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { ...legacyAuthHeaders() } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function fmtCount(n?: number): string {
  if (!n) return '';
  if (n >= 10000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.', ',')}K`;
  return String(n);
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('ru-RU', opts);
}

/** Картинки поста в порядке отображения (фото либо постер видео). */
function postImages(post: CreativePost): string[] {
  return post.photos.length ? post.photos : post.videoPoster ? [post.videoPoster] : [];
}

function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs sm:text-sm font-medium transition-all border ${active
        ? 'bg-pink-500/25 border-pink-400/50 text-pink-50 shadow-lg shadow-pink-500/20'
        : 'bg-white/5 border-white/10 text-pink-200/60 hover:text-pink-100 hover:border-pink-500/30'}`}
    >
      {label}
    </button>
  );
}

const SKEL_ASPECTS = ['3/4', '3/4', '1/1', '4/5', '9/16', '3/4', '4/5', '1/1', '3/4', '9/16', '1/1', '4/5'];

function SkeletonMasonry({ count = 24 }: { count?: number }) {
  return (
    <div className="columns-2 sm:columns-3 md:columns-4 lg:columns-5 xl:columns-6 gap-2 sm:gap-3">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          style={{ aspectRatio: SKEL_ASPECTS[i % SKEL_ASPECTS.length] }}
          className="mb-2 sm:mb-3 break-inside-avoid rounded-xl bg-[#160a12] border border-pink-500/10 overflow-hidden"
        >
          <div className="w-full h-full art-card-shimmer" />
        </div>
      ))}
    </div>
  );
}

function PostCard({
  post, index, onOpen,
}: { post: CreativePost; index: number; onOpen: () => void }) {
  const isVideo = !post.photos.length && !!post.videoPoster;
  const first = post.photos[0] || post.videoPoster || '';
  const dims = post.photos.length ? post.photoDims?.[0] : (post.posterDims || undefined);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const extra = Math.max(0, post.photos.length - 1);
  if (!first || failed) return null;

  return (
    <motion.figure
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index % 24, 12) * 0.02 }}
      className="group relative mb-2 sm:mb-3 break-inside-avoid cursor-pointer rounded-xl overflow-hidden border border-pink-500/20 hover:border-pink-500/40 transition-colors bg-[#160a12]"
      onClick={onOpen}
    >
      {!loaded && <div className="absolute inset-0 art-card-shimmer" />}
      <img
        src={first}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        style={{ aspectRatio: dims && dims.w > 0 ? `${dims.w}/${dims.h}` : 'auto 3/4' }}
        className={`relative w-full h-auto object-cover transition-all duration-500 group-hover:scale-[1.03] ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
      <div className="absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/50 to-transparent pointer-events-none" />
      <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-black/55 backdrop-blur-sm text-[9px] sm:text-[10px] font-medium text-pink-100 border border-pink-500/20 max-w-[70%] truncate">
        {post.channelTitle}
      </span>
      {extra > 0 && (
        <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/60 backdrop-blur-sm text-[9px] sm:text-[10px] text-white/90 border border-white/10 flex items-center gap-1">
          <Layers className="w-2.5 h-2.5" />{extra + 1}
        </span>
      )}
      {isVideo && (
        <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-black/60 backdrop-blur-sm text-[9px] sm:text-[10px] text-white/90 border border-white/10 flex items-center gap-1">
          <Play className="w-2.5 h-2.5" />Видео
        </span>
      )}
    </motion.figure>
  );
}

export function CreativeTab() {
  const [posts, setPosts] = useState<CreativePost[]>([]);
  const [channels, setChannels] = useState<CreativeChannel[]>([]);
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [lightbox, setLightbox] = useState<{ postId: string; f: number } | null>(null);
  const [totalPosts, setTotalPosts] = useState(0);
  const seen = useRef(new Set<string>());
  const cursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const filterRef = useRef('');
  const sentinelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (cur: string | null, ch: string, reset: boolean) => {
    const q = new URLSearchParams();
    if (ch) q.set('channel', ch);
    if (cur) q.set('cursor', cur);
    const d = await apiJson<{
      posts?: CreativePost[]; channels?: CreativeChannel[];
      hasMore?: boolean; nextCursor?: string | null; unavailable?: boolean;
      totalPosts?: number;
    }>(`/api/creative?${q}`);
    setChannels(prev => {
      if (!d.channels) return prev;
      const prevById = new Map(prev.map(c => [c.id, c]));
      return d.channels!.map(c => ({ ...c, count: c.count ?? prevById.get(c.id)?.count }));
    });
    if (d.totalPosts) setTotalPosts(d.totalPosts);
    setUnavailable(!!d.unavailable);
    cursorRef.current = d.nextCursor || null;
    setCursor(d.nextCursor || null);
    setPosts(prev => {
      const fresh = (d.posts || []).filter(p => !seen.current.has(p.id));
      fresh.forEach(p => seen.current.add(p.id));
      return reset ? fresh : [...prev, ...fresh];
    });
  }, []);

  // Первичная загрузка / смена канала / авто-повтор
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setUnavailable(false);
    seen.current = new Set();
    cursorRef.current = null;
    load(null, filter, true)
      .catch(e => { if (alive) setError(e?.message || 'Ошибка загрузки'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [filter, load, retryTick]);

  // Telegram не отвечает — тихо пробуем ещё раз через 3.5с
  useEffect(() => {
    if (!unavailable || error) return;
    const t = setTimeout(() => setRetryTick(v => v + 1), 3500);
    return () => clearTimeout(t);
  }, [unavailable, error]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !cursorRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try { await load(cursorRef.current, filterRef.current, false); }
    catch { /* оставляем как есть */ }
    finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [load]);

  // Смена фильтра — запоминаем для loadMore
  useEffect(() => { filterRef.current = filter; }, [filter]);

  // Бесконечный скролл
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || loading || error) return;
    const obs = new IntersectionObserver(es => {
      if (es[0]?.isIntersecting) void loadMore();
    }, { rootMargin: '700px 0px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore, loading, error, posts.length, filter]);

  const shown = useMemo(
    () => (filter ? posts.filter(p => p.channel === filter) : posts),
    [posts, filter],
  );

  // Плоский список картинок для навигации лайтбокса
  const flat = useMemo(() => {
    const out: Array<{ post: CreativePost; f: number }> = [];
    shown.forEach(post => {
      postImages(post).forEach((_, f) => out.push({ post, f }));
    });
    return out;
  }, [shown]);
  const li = lightbox ? flat.findIndex(x => x.post.id === lightbox.postId && x.f === lightbox.f) : -1;
  const lb = li >= 0 ? flat[li] : null;
  const lbImg = lb ? postImages(lb.post)[lb.f] : '';
  const lbAlbum = lb ? postImages(lb.post) : [];

  const nav = useCallback((dir: number) => {
    if (li < 0 || !flat.length) return;
    const next = (li + dir + flat.length) % flat.length;
    setLightbox({ postId: flat[next].post.id, f: flat[next].f });
  }, [li, flat]);

  // Клавиатура + блокировка скролла фона + предзагрузка соседей
  useEffect(() => {
    if (!lightbox) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
      if (e.key === 'ArrowLeft') nav(-1);
      if (e.key === 'ArrowRight') nav(1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [lightbox, nav]);

  useEffect(() => {
    document.body.style.overflow = lightbox ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [lightbox]);

  useEffect(() => {
    if (li < 0 || flat.length < 2) return;
    for (const d of [1, -1]) {
      const t = flat[(li + d + flat.length) % flat.length];
      const url = t ? postImages(t.post)[t.f] : '';
      if (url) {
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.src = url;
      }
    }
  }, [li, flat]);

  const totalLabel = totalPosts || channels.reduce((a, c) => a + (c.count || 0), 0);

  return (
    <div>
      {/* Каналы + общий счётчик */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex gap-2 overflow-x-auto pb-3 scrollbar-thin flex-1 min-w-0">
          <Chip active={!filter} onClick={() => setFilter('')}
            label={`Все каналы${totalLabel ? ` · ${fmtCount(totalLabel)}` : ''}`} />
          {channels.map(c => (
            <Chip key={c.id} active={filter === c.id} onClick={() => setFilter(c.id)}
              label={`${c.title}${c.count ? ` · ${fmtCount(c.count)}` : ''}`} />
          ))}
        </div>
      </div>

      {loading && <SkeletonMasonry count={24} />}

      {!loading && error && (
        <div className="py-16 text-center text-pink-200/70">
          <Sparkles className="w-10 h-10 mx-auto mb-3 text-pink-400/50" />
          <p className="mb-1 font-medium">Не удалось загрузить арты</p>
          <p className="text-xs opacity-70">{error}</p>
        </div>
      )}

      {!loading && !error && unavailable && shown.length === 0 && (
        <div className="py-16 text-center text-pink-200/70">
          <Images className="w-10 h-10 mx-auto mb-3 text-pink-400/50" />
          <p className="mb-1 font-medium">Каналы Telegram временно не отвечают</p>
          <p className="text-xs opacity-70 mb-4">Пробую ещё раз автоматически…</p>
        </div>
      )}

      {!loading && !error && !unavailable && shown.length === 0 && (
        <div className="py-16 text-center text-pink-200/70">
          <Images className="w-10 h-10 mx-auto mb-3 text-pink-400/50" />
          <p className="font-medium">Пока пусто</p>
        </div>
      )}

      {!loading && !error && shown.length > 0 && (
        <>
          <div className="columns-2 sm:columns-3 md:columns-4 lg:columns-5 xl:columns-6 gap-2 sm:gap-3">
            {shown.map((p, i) => (
              <PostCard
                key={p.id}
                post={p}
                index={i}
                onOpen={() => { postImages(p)[0] && setLightbox({ postId: p.id, f: 0 }); }}
              />
            ))}
          </div>
          <div ref={sentinelRef} className="h-4" />
          {cursor && (
            <div className="flex justify-center mt-6">
              <button
                onClick={loadMore}
                disabled={loadingMore || !cursor}
                className="px-6 py-2.5 rounded-xl bg-pink-500/15 hover:bg-pink-500/25 border border-pink-500/30 text-pink-100 text-sm font-medium transition-all disabled:opacity-40"
              >
                {loadingMore ? 'Загружаю…' : 'Показать ещё'}
              </button>
            </div>
          )}
        </>
      )}

      {/* Лайтбокс v2 */}
      <AnimatePresence>
        {lightbox && lb && lbImg && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[90] bg-black/95 backdrop-blur-sm flex flex-col"
            onClick={() => setLightbox(null)}
          >
            {/* Верхняя панель: канал, дата, ссылка, закрыть */}
            <div className="shrink-0 z-[2] flex items-center justify-between gap-2 px-3 sm:px-4 pt-3 pb-2 bg-gradient-to-b from-black/80 to-transparent pointer-events-none">
              <div className="pointer-events-auto flex items-center gap-2 min-w-0">
                <span className="px-2 py-0.5 rounded-full bg-pink-500/20 border border-pink-400/30 text-pink-100 text-[11px] font-medium truncate max-w-[45vw]">
                  {lb.post.channelTitle}
                </span>
                {fmtDate(lb.post.date) && (
                  <span className="text-white/50 text-xs hidden sm:inline">{fmtDate(lb.post.date)}</span>
                )}
              </div>
              <div className="pointer-events-auto flex items-center gap-1.5 shrink-0">
                <a
                  href={lb.post.postUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                  aria-label="Открыть в Telegram"
                  title="Открыть в Telegram"
                >
                  <ExternalLink className="w-4.5 h-4.5" />
                </a>
                <button
                  className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                  onClick={() => setLightbox(null)}
                  aria-label="Закрыть"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Счётчик */}
            {flat.length > 1 && (
              <div className="shrink-0 z-[2] flex justify-center pb-1 pointer-events-none">
                <div className="px-3 py-0.5 rounded-full bg-black/60 text-white/80 text-[11px]">
                  {li + 1} / {flat.length}
                </div>
              </div>
            )}

            {/* Картинка */}
            <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden px-2">
              <motion.img
                key={lbImg}
                src={lbImg}
                alt=""
                referrerPolicy="no-referrer"
                initial={{ scale: 0.97, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.16 }}
                drag="x"
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.22}
                onDragEnd={(_, info) => {
                  if (info.offset.x < -80) nav(1);
                  else if (info.offset.x > 80) nav(-1);
                }}
                onClick={e => e.stopPropagation()}
                className="max-w-full max-h-full object-contain select-none touch-none"
              />
            </div>

            {/* Стрелки */}
            {flat.length > 1 && (
              <>
                <button
                  className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-[2]"
                  onClick={e => { e.stopPropagation(); nav(-1); }}
                  aria-label="Предыдущее"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button
                  className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-[2]"
                  onClick={e => { e.stopPropagation(); nav(1); }}
                  aria-label="Следующее"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              </>
            )}

            {/* Нижняя панель: альбом, подпись */}
            <div
              className="shrink-0 z-[2] px-3 sm:px-4 pt-2 pb-3 sm:pb-4 bg-gradient-to-t from-black/90 via-black/70 to-transparent"
              onClick={e => e.stopPropagation()}
            >
              {lbAlbum.length > 1 && (
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin max-w-full">
                    {lbAlbum.map((u, fi) => (
                      <button
                        key={u}
                        onClick={() => setLightbox({ postId: lb.post.id, f: fi })}
                        className={`shrink-0 w-11 h-11 sm:w-12 sm:h-12 rounded-md overflow-hidden border transition ${fi === lb.f
                          ? 'border-pink-400 opacity-100 scale-105'
                          : 'border-white/15 opacity-50 hover:opacity-90'}`}
                        aria-label={`Фото ${fi + 1}`}
                      >
                        <img src={u} alt="" referrerPolicy="no-referrer" loading="lazy"
                          className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                  <span className="shrink-0 text-[11px] text-white/60">{lb.f + 1}/{lbAlbum.length}</span>
                </div>
              )}
              {lb.post.caption && (
                <p className="text-white/85 text-[13px] sm:text-sm leading-relaxed line-clamp-4 max-w-3xl mx-auto text-center">
                  {lb.post.caption}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
