'use client';

/**
 * Вкладка «Креатив» (Task 44) — арты из Telegram-каналов.
 *
 * Читает /api/creative: страницы по курсору, метаданные каналов с сервера,
 * лайтбокс с навигацией стрелками, авто-повтор при недоступности Telegram.
 * Дедуп постов между страницами — по id (Set).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, Images, Sparkles, X } from 'lucide-react';

export interface CreativePost {
  id: string;
  channel: string;
  channelTitle: string;
  msgId: number;
  date: string;
  caption: string;
  photos: string[];
  videoPoster?: string;
  postUrl: string;
}

export interface CreativeChannel { id: string; title: string }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

function TileSkeleton({ aspect = 'aspect-[3/4]' }: { aspect?: string }) {
  return (
    <div className={`rounded-xl overflow-hidden bg-[var(--card)] border border-[var(--border)] ${aspect} animate-pulse`}>
      <div className="w-full h-full bg-[var(--muted)]" />
    </div>
  );
}

function SkeletonGrid({ count = 21, cols = 'grid-cols-3 md:grid-cols-4 lg:grid-cols-6', aspect = 'aspect-[3/4]', gap = 'gap-2.5 sm:gap-4' }: {
  count?: number; cols?: string; aspect?: string; gap?: string;
}) {
  return (
    <div className={`grid ${cols} ${gap}`}>
      {Array.from({ length: count }, (_, i) => <TileSkeleton key={i} aspect={aspect} />)}
    </div>
  );
}

function PostCard({ post, onOpen }: { post: CreativePost; onOpen: () => void }) {
  const first = post.photos[0] || post.videoPoster || '';
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const extra = Math.max(0, post.photos.length - 1);
  if (!first || failed) return null;
  return (
    <motion.div
      whileHover={{ y: -3, scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      className="group relative cursor-pointer rounded-xl overflow-hidden border border-pink-500/20 hover:border-pink-500/40 transition-all bg-[#160a12]"
      onClick={onOpen}
    >
      <div className="relative aspect-[3/4]">
        {!loaded && <div className="absolute inset-0 art-card-shimmer" />}
        <img
          src={first}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`absolute inset-0 w-full h-full object-cover transition-all duration-500 group-hover:scale-105 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
        <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/45 to-transparent pointer-events-none" />
        <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-black/55 backdrop-blur-sm text-[9px] sm:text-[10px] font-medium text-pink-100 border border-pink-500/20 max-w-[70%] truncate">
          {post.channelTitle}
        </span>
        {extra > 0 && (
          <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/60 backdrop-blur-sm text-[9px] sm:text-[10px] text-white/90 border border-white/10">
            +{extra}
          </span>
        )}
        {!post.photos.length && post.videoPoster && (
          <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-black/60 backdrop-blur-sm text-[9px] sm:text-[10px] text-white/90 border border-white/10">
            Видео
          </span>
        )}
      </div>
    </motion.div>
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
  const [lightbox, setLightbox] = useState<{ p: number; f: number } | null>(null);
  const seen = useRef(new Set<string>());

  const load = useCallback(async (cur: string | null, ch: string, reset: boolean) => {
    const q = new URLSearchParams();
    if (ch) q.set('channel', ch);
    if (cur) q.set('cursor', cur);
    const d = await apiJson<{
      posts?: CreativePost[]; channels?: CreativeChannel[];
      hasMore?: boolean; nextCursor?: string | null; unavailable?: boolean;
    }>(`/api/creative?${q}`);
    setChannels(d.channels || []);
    setUnavailable(!!d.unavailable);
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

  const loadMore = async () => {
    if (loadingMore || !cursor) return;
    setLoadingMore(true);
    try { await load(cursor, filter, false); } catch { /* оставляем как есть */ }
    setLoadingMore(false);
  };

  // Плоский список всех картинок для навигации лайтбокса
  const flat: Array<{ p: number; f: number }> = [];
  posts.forEach((post, pi) => {
    (post.photos.length ? post.photos : post.videoPoster ? [post.videoPoster] : []).forEach((_, fi) => {
      flat.push({ p: pi, f: fi });
    });
  });
  const li = lightbox ? flat.findIndex(x => x.p === lightbox.p && x.f === lightbox.f) : -1;
  const lbPost = lightbox ? posts[lightbox.p] : null;
  const lbImg = lbPost && lightbox ? (lbPost.photos.length ? lbPost.photos[lightbox.f] : lbPost.videoPoster) : '';

  const nav = (dir: number) => {
    if (li < 0 || !flat.length) return;
    const next = (li + dir + flat.length) % flat.length;
    setLightbox(flat[next]);
  };

  useEffect(() => {
    if (!lightbox) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
      if (e.key === 'ArrowLeft') nav(-1);
      if (e.key === 'ArrowRight') nav(1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox, li, flat.length]);

  const shown = filter ? posts.filter(p => p.channel === filter) : posts;

  return (
    <div>
      {/* Каналы */}
      <div className="flex gap-2 overflow-x-auto pb-3 mb-1 scrollbar-thin">
        <Chip active={!filter} onClick={() => setFilter('')} label="Все каналы" />
        {channels.map(c => (
          <Chip key={c.id} active={filter === c.id} onClick={() => setFilter(c.id)} label={c.title} />
        ))}
      </div>

      {loading && <SkeletonGrid count={21} cols="grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7" aspect="aspect-[3/4]" />}

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
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 gap-2 sm:gap-3">
            {shown.map((p, i) => (
              <PostCard
                key={p.id}
                post={p}
                onOpen={() => { (p.photos.length ? p.photos[0] : p.videoPoster || '') && setLightbox({ p: i, f: 0 }); }}
              />
            ))}
          </div>
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

      {/* Лайтбокс */}
      <AnimatePresence>
        {lightbox && lbPost && lbImg && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[90] bg-black/95 flex items-center justify-center"
            onClick={() => setLightbox(null)}
          >
            <button
              className="absolute top-3 right-3 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-[2]"
              onClick={() => setLightbox(null)}
              aria-label="Закрыть"
            >
              <X className="w-5 h-5" />
            </button>
            {flat.length > 1 && (
              <>
                <button
                  className="absolute left-2 sm:left-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-[2]"
                  onClick={e => { e.stopPropagation(); nav(-1); }}
                  aria-label="Предыдущее"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button
                  className="absolute right-2 sm:right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-[2]"
                  onClick={e => { e.stopPropagation(); nav(1); }}
                  aria-label="Следующее"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
                <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/60 text-white/90 text-xs z-[2]">
                  {li + 1} / {flat.length}
                </div>
              </>
            )}
            <motion.img
              key={lbImg}
              src={lbImg}
              alt=""
              referrerPolicy="no-referrer"
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.18 }}
              className="max-w-[96vw] max-h-[88vh] object-contain select-none"
              onClick={e => e.stopPropagation()}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
