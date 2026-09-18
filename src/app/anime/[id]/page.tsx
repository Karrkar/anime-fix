import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { preferRussianTitle } from '@/lib/anime-utils';

/**
 * Публичная SEO-страница тайтла /anime/[id].
 *
 * Раньше весь сайт был одной SPA — поисковики видели пустоту. Теперь каждый
 * тайтл имеет серверно отрендеренную страницу с метаданными и JSON-LD,
 * а кнопка «Смотреть онлайн» ведёт в приложение через deep-link /?open={id}.
 *
 * Только SFW-контент: anime_catalog не содержит 18+ (там своя таблица),
 * статические данные берём из SFW_ANIME. Взрослого контента здесь нет и
 * не будет — страница публично индексируется.
 *
 * id: `db-{vost_id}` или просто `{vost_id}` для тайтлов из БД,
 * `a-{...}` — для статических. revalidate 3600: страница обновляется
 * из БД не чаще раза в час (ISR).
 */
export const revalidate = 3600;

interface PageAnime {
  id: string;
  title: string;
  titleJapanese: string | null;
  titleRussian: string | null;
  description: string;
  imageUrl: string;
  type: string;
  episodes: number;
  genres: string;
  score: number;
  status: string;
}

const ID_RE = /^[a-zA-Z0-9-]{1,64}$/;

function rowToPageAnime(id: string, r: Record<string, unknown>): PageAnime {
  return {
    id,
    title: String(r.title || ''),
    titleJapanese: null,
    titleRussian: (r.title_russian as string) || null,
    description: String(r.description || ''),
    imageUrl: String(r.image_url || ''),
    type: String(r.type || 'ТВ'),
    episodes: Number(r.episodes || 0),
    genres: String(r.genres || ''),
    score: Number(r.score || 0),
    status: '',
  };
}

async function getAnime(id: string): Promise<PageAnime | null> {
  if (!ID_RE.test(id)) return null;

  // 1) БД: db-{vost_id} или числовой id
  const vostId = id.startsWith('db-') ? parseInt(id.slice(3), 10) : parseInt(id, 10);
  if (vostId && Number.isFinite(vostId)) {
    try {
      const db = getDb();
      const { data } = await db
        .from('anime_catalog')
        .select('vost_id, title, title_russian, description, image_url, type, episodes, genres, score')
        .eq('vost_id', vostId)
        .maybeSingle();
      if (data) return rowToPageAnime(`db-${(data as Record<string, unknown>).vost_id}`, data as Record<string, unknown>);
    } catch { /* БД недоступна — пробуем статику */ }
  }

  // 2) Статические данные (ленивый импорт: data.ts весит несколько МБ)
  try {
    const { SFW_ANIME } = await import('@/lib/data');
    const item = (SFW_ANIME as unknown as Array<Record<string, unknown>>).find(a => a.id === id);
    if (item) {
      return {
        id: String(item.id),
        title: String(item.title || ''),
        titleJapanese: (item.title_japanese as string) || null,
        titleRussian: (item.title_russian as string) || null,
        description: String(item.description || ''),
        imageUrl: String(item.image_url || ''),
        type: String(item.type || 'ТВ'),
        episodes: Number(item.episodes || 0),
        genres: String(item.genres || ''),
        score: Number(item.score || 0),
        status: String(item.status || ''),
      };
    }
  } catch { /* ignore */ }

  return null;
}

/** Чистое описание для meta/JSON-LD: без служебных строк «Год выхода: …» */
function cleanDescription(a: PageAnime): string {
  const lines = a.description.split('\n').filter(l => !/^(Год выхода|Жанр|Тип|Количество серий):/i.test(l.trim()));
  const text = (lines.join(' ') || a.description).replace(/\s+/g, ' ').trim();
  return text.length > 220 ? `${text.slice(0, 217)}…` : text;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const a = await getAnime(id);
  if (!a) return { title: 'Аниме не найдено', robots: { index: false, follow: false } };

  const displayMeta = preferRussianTitle({ title: a.title, title_russian: a.titleRussian });
  const display = displayMeta.title;
  const title = `${display}${displayMeta.title_russian ? ` / ${displayMeta.title_russian}` : ''} — смотреть онлайн бесплатно`;
  const description = `${display}${a.type ? `, ${a.type}` : ''}${a.episodes > 0 ? `, ${a.episodes} эп.` : ''} — смотреть онлайн бесплатно в хорошем качестве. ${cleanDescription(a)}`.slice(0, 300);

  return {
    title,
    description,
    alternates: { canonical: `/anime/${a.id}` },
    openGraph: {
      type: 'website',
      title,
      description,
      url: `/anime/${a.id}`,
      images: a.imageUrl ? [{ url: a.imageUrl, alt: display }] : undefined,
    },
    twitter: {
      card: a.imageUrl ? 'summary_large_image' : 'summary',
      title,
      description,
    },
  };
}

export default async function AnimePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await getAnime(id);
  if (!a) notFound();

  const display = preferRussianTitle({ title: a.title, title_russian: a.titleRussian }).title;
  const meta = [a.type, a.episodes > 0 ? `${a.episodes} эп.` : null, a.status || null].filter(Boolean);
  const genres = a.genres.split(',').map(g => g.trim()).filter(Boolean);
  const isMovie = /фильм|movie|ova|спешл/i.test(a.type);
  const rating = a.score > 0 && a.score <= 10 ? a.score : null;

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': isMovie ? 'Movie' : 'TVSeries',
    name: display,
    alternateName: [a.title !== display ? a.title : null, a.titleJapanese].filter(Boolean),
    description: cleanDescription(a),
    ...(a.imageUrl ? { image: [a.imageUrl] } : {}),
    ...(genres.length ? { genre: genres } : {}),
    ...(isMovie ? {} : a.episodes > 0 ? { numberOfEpisodes: a.episodes } : {}),
    ...(rating ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: rating, bestRating: 10, ratingCount: 1 } } : {}),
  };

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div className="max-w-4xl mx-auto px-4 py-8 sm:py-12">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-[var(--muted-foreground)] hover:text-[var(--primary)] transition-colors mb-6">
          ← На главную
        </Link>

        <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
          {/* Постер */}
          <div className="w-full max-w-[240px] sm:w-56 shrink-0 self-center sm:self-start">
            {a.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={a.imageUrl} alt={`${display} — постер`} width={448} height={620} className="w-full rounded-xl border border-[var(--border)] shadow-lg" />
            ) : (
              <div className="aspect-[3/4] rounded-xl bg-[var(--muted)] border border-[var(--border)] flex items-center justify-center text-4xl">🎬</div>
            )}
          </div>

          {/* Инфо */}
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-extrabold leading-tight text-white">
              {display}
            </h1>
            {(a.titleJapanese || (a.title && a.title !== display)) && (
              <p className="text-sm text-[var(--muted-foreground)] mt-1.5">
                {a.titleJapanese ? `${a.titleJapanese}${a.title && a.title !== display ? ` · ${a.title}` : ''}` : a.title}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 mt-4 text-xs">
              {meta.map(m => (
                <span key={m} className="px-2.5 py-1 rounded-full bg-[var(--card)] border border-[var(--border)] text-[var(--muted-foreground)]">{m}</span>
              ))}
              {rating && (
                <span className="px-2.5 py-1 rounded-full bg-yellow-500/15 text-yellow-400 font-semibold">★ {rating.toFixed(1)}</span>
              )}
            </div>

            <div className="mt-6">
              <Link
                href={`/?open=${a.id}`}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-[var(--primary)] hover:bg-[var(--accent)] text-white font-semibold transition-colors shadow-lg shadow-purple-500/20"
              >
                ▶ Смотреть онлайн
              </Link>
              <Link
                href="/"
                className="ml-3 inline-flex items-center gap-2 px-5 py-3 rounded-xl border border-white/15 text-[var(--foreground)] hover:bg-white/5 transition-colors text-sm"
              >
                Больше аниме
              </Link>
            </div>

            {genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-6">
                {genres.map(g => (
                  <span key={g} className="text-xs px-2 py-0.5 rounded bg-purple-500/10 text-purple-300">{g}</span>
                ))}
              </div>
            )}

            {a.description && (
              <div className="mt-6">
                <h2 className="text-base font-bold mb-2 text-white">Описание</h2>
                <p className="text-sm leading-relaxed text-[var(--muted-foreground)] whitespace-pre-line">{a.description}</p>
              </div>
            )}
          </div>
        </div>

        <div className="mt-10 pt-6 border-t border-[var(--border)] text-center text-xs text-[var(--muted-foreground)]">
          <p>AnimePlatform — смотреть аниме онлайн бесплатно. © 2026</p>
        </div>
      </div>
    </div>
  );
}
