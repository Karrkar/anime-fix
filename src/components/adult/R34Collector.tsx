'use client';

/**
 * R34Collector — клиентский сборщик ПОЛНОЙ коллекции rule34 (октябрь 2026,
 * задача «все арты с указанных источников»).
 *
 * ПОЧЕМУ КЛИЕНТ: rule34.xxx за Cloudflare, который челленджит все
 * датацентровые IP (Vercel — 403, песочница — CAPTCHA), а Jina-ключ
 * продакшена исчерпан. Зато браузер ПОЛЬЗОВАТЕЛЯ (резидентный IP) ходит
 * на api.rule34.xxx свободно, а сам dapi отдаёт CORS * — браузер может
 * дёргать официальный API напрямую. 14 художников ~143 000 постов = 143
 * запроса dapi (1000 постов каждый), результат уходит в /api/r34-ingest.
 *
 * Ключ: бесплатный, аккаунт rule34.xxx → Account Options → API key.
 * Хранится только в localStorage браузера пользователя.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Database, Loader2, X, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';
import { apiFetch } from '@/lib/client-utils';

const ARTISTS = ['arzagod', 'balecxi', 'kaistar', 'kinkimya', 'rognezart', 'hypet',
  'backdoorsenpai', 'milfhunter228', 'futarush', 'kiraamane', 'aliusnext',
  'meitabuu', 'maldo', 'duxvector'] as const;

const CREDS_KEY = 'r34_api_credentials';

interface DapiPost {
  id?: number | string;
  preview_url?: string;
  tags?: string;
  score?: number;
  rating?: string;
}

interface ParsedPost {
  id: string;
  thumbnailUrl: string;
  tags: string[];
  artist: string;
  characters: string[];
  score: number;
  rating: string;
  title: string;
  postUrl: string;
}

function dapiToParsed(posts: DapiPost[], artistTag: string): ParsedPost[] {
  const out: ParsedPost[] = [];
  for (const p of posts) {
    const id = p.id != null ? String(p.id) : '';
    const thumb = typeof p.preview_url === 'string' ? p.preview_url : '';
    if (!/^\d{1,12}$/.test(id) || !thumb) continue;
    const rawTags = typeof p.tags === 'string' ? p.tags.split(/\s+/).filter(Boolean) : [];
    const tags: string[] = [];
    const seen = new Set<string>();
    for (const t of rawTags) {
      const normalized = t.replace(/_/g, ' ');
      if (!seen.has(normalized.toLowerCase())) {
        seen.add(normalized.toLowerCase());
        tags.push(normalized);
      }
    }
    const charTags = tags.filter(t => t.includes('('));
    const displayTitle = charTags.length > 0
      ? charTags.slice(0, 2).map(c => c.replace(/ \(.*\)$/, '')).join(', ')
      : tags.slice(0, 3).join(', ');
    const lower = artistTag.toLowerCase().replace(/_/g, ' ');
    const artist = tags.find(t => t.toLowerCase() === lower) ||
      tags.find(t => !t.includes('(') && t !== '1girl' && t !== '1boy' && !t.startsWith('ai ')) || 'Unknown';
    out.push({
      id, thumbnailUrl: thumb, tags, artist,
      characters: charTags.filter(t => !t.includes('fate') && !t.includes('series')).map(c => c.replace(/ \(.*\)$/, '')),
      score: typeof p.score === 'number' ? p.score : 0,
      rating: typeof p.rating === 'string' ? p.rating : 'explicit',
      title: displayTitle,
      postUrl: `https://rule34.xxx/index.php?page=post&s=view&id=${id}`,
    });
  }
  return out;
}

export function R34Collector({ onDone }: { onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ artist: string; artistIdx: number; posts: number } | null>(null);
  const [doneInfo, setDoneInfo] = useState<{ posts: number } | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CREDS_KEY);
      if (raw) {
        const c = JSON.parse(raw) as { user_id?: string; api_key?: string };
        if (c.user_id) setUserId(c.user_id);
        if (c.api_key) setApiKey(c.api_key);
      }
    } catch { /* пусто — ок */ }
  }, []);

  const saveCreds = useCallback((uid: string, key: string) => {
    try { localStorage.setItem(CREDS_KEY, JSON.stringify({ user_id: uid, api_key: key })); } catch { /* приватный режим */ }
  }, []);

  const run = useCallback(async () => {
    abortRef.current = false;
    setRunning(true);
    setError('');
    setDoneInfo(null);
    saveCreds(userId, apiKey);
    let totalPosts = 0;

    try {
      for (let a = 0; a < ARTISTS.length && !abortRef.current; a++) {
        const tag = ARTISTS[a];
        setProgress({ artist: tag, artistIdx: a + 1, posts: totalPosts });

        // ожидаемое число постов (публичный autocomplete)
        let expected = 0;
        try {
          const ac = await fetch(`https://api.rule34.xxx/autocomplete.php?q=${encodeURIComponent(tag)}`);
          if (ac.ok) {
            const list = (await ac.json()) as Array<{ label?: string; value?: string }>;
            const m = list.find(x => x.value === tag)?.label?.match(/\((\d+)\)/);
            if (m) expected = parseInt(m[1], 10);
          }
        } catch { /* счётчик не критичен */ }

        let pid = 0;
        const hardCap = Math.ceil((expected || 1000) / 1000) + 1;
        for (let page = 0; page < hardCap && !abortRef.current; page++) {
          const dapiUrl = `https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1&limit=1000&pid=${pid}` +
            `&tags=${encodeURIComponent(tag)}&user_id=${encodeURIComponent(userId)}&api_key=${encodeURIComponent(apiKey)}`;
          const r = await fetch(dapiUrl);
          if (r.status === 401 || r.status === 403) {
            throw new Error('rule34 не принял user_id/api_key — проверьте ключ в Account Options');
          }
          if (!r.ok) throw new Error(`dapi HTTP ${r.status}`);
          const text = await r.text();
          if (!text.trim().startsWith('[')) break; // пусто/дно
          const raw = JSON.parse(text) as DapiPost[];
          if (!Array.isArray(raw) || raw.length === 0) break;
          const parsed = dapiToParsed(raw, tag);
          if (parsed.length === 0) break;

          // заливаем батч в хранилище платформы
          await apiFetch('/api/r34-ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag, posts: parsed, totalPosts: expected || undefined }),
          });
          totalPosts += parsed.length;
          setProgress({ artist: tag, artistIdx: a + 1, posts: totalPosts });

          if (parsed.length < 1000) break; // дно
          pid += 1000;
        }
      }

      if (abortRef.current) {
        setError('Остановлено. Залитое сохранено.');
      } else {
        setDoneInfo({ posts: totalPosts });
        onDone?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [userId, apiKey, saveCreds, onDone]);

  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg flex-shrink-0 whitespace-nowrap border bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] border-transparent transition-all"
        title="Залить в платформу ВСЕ арты всех художников через ваш ключ rule34"
      >
        <Database className="w-3.5 h-3.5" />
        Полная коллекция
      </button>

      {open && (
        <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold flex items-center gap-2">
                <Database className="w-4 h-4 text-pink-400" />
                Полная коллекция rule34
              </h3>
              <button onClick={() => { abortRef.current = true; setOpen(false); }} className="p-1.5 rounded-lg hover:bg-[var(--muted)]">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-[var(--muted-foreground)] mb-3 leading-relaxed">
              Заливает в платформу <b>все посты 14 художников</b> (~143 000 артов) через официальный
              API rule34 прямо из вашего браузера — за пару минут. Нужен бесплатный ключ:
              аккаунт на{' '}
              <a href="https://rule34.xxx/index.php?page=account&s=options" target="_blank" rel="noopener noreferrer" className="text-pink-400 hover:underline inline-flex items-center gap-0.5">
                rule34.xxx <ExternalLink className="w-3 h-3" />
              </a>{' '}
              → Account Options → «API key».
            </p>

            <div className="space-y-2 mb-3">
              <input
                value={userId}
                onChange={e => setUserId(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="user_id (цифры, из Account Options)"
                disabled={running}
                className="w-full px-3 py-2 rounded-xl bg-[var(--muted)] border border-[var(--border)] text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-pink-500/50"
              />
              <input
                value={apiKey}
                onChange={e => setApiKey(e.target.value.trim().slice(0, 64))}
                placeholder="api_key"
                disabled={running}
                type="password"
                className="w-full px-3 py-2 rounded-xl bg-[var(--muted)] border border-[var(--border)] text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-pink-500/50"
              />
            </div>

            {running && progress && (
              <div className="mb-3 text-xs text-[var(--muted-foreground)] space-y-1">
                <div className="flex items-center gap-2 text-[var(--foreground)]">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-pink-400" />
                  {progress.artistIdx}/{ARTISTS.length} · <b className="capitalize">{progress.artist}</b>
                </div>
                <div>Залито постов: {progress.posts.toLocaleString('ru-RU')}</div>
                <div className="h-1.5 rounded-full bg-[var(--muted)] overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-red-500 to-pink-500 transition-all" style={{ width: `${(progress.artistIdx / ARTISTS.length) * 100}%` }} />
                </div>
              </div>
            )}

            {doneInfo && (
              <div className="mb-3 text-xs flex items-center gap-2 text-emerald-400">
                <CheckCircle2 className="w-4 h-4" />
                Готово: {doneInfo.posts.toLocaleString('ru-RU')} постов в платформе
              </div>
            )}

            {error && (
              <div className="mb-3 text-xs flex items-start gap-2 text-amber-400">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={run}
                disabled={running || !userId || !apiKey}
                className="flex-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-pink-600 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-lg hover:shadow-red-500/20 transition-all flex items-center justify-center gap-2"
              >
                {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
                {running ? 'Собираю…' : 'Собрать все арты'}
              </button>
              {running && (
                <button
                  onClick={() => { abortRef.current = true; }}
                  className="px-4 py-2.5 rounded-xl border border-[var(--border)] text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  Стоп
                </button>
              )}
            </div>

            <p className="text-[10px] text-[var(--muted-foreground)] mt-3">
              Ключ хранится только в этом браузере (localStorage) и уходит исключительно на api.rule34.xxx.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
