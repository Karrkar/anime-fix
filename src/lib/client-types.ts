

// ─── Types ───────────────────────────────────────────────────────────────
export interface AnimeEpisode {
  id: string;
  title: string;
  episodeNumber: number;
  embedUrl: string;
  thumbnailUrl: string;
  duration: string;
}

export interface Anime {
  id: string;
  title: string;
  titleJapanese?: string | null;
  titleRussian?: string | null;
  description: string;
  imageUrl: string;
  type: string;
  episodes: number;
  genres: string;         // ← строка из БД, будет нормализована в массив
  status: string;
  score: number;
  isAdult: boolean;
  animeEpisodes?: AnimeEpisode[];
  watchedAt?: string;
  episodeNumber?: number;
  // даты из БД (для бейджей «Новое/Обновлено» и полки «Свежее за неделю»)
  createdAt?: string | null;
  updatedAt?: string | null;
  sourceUrl?: string;
}

export interface ArtItem {
  id: string;
  title: string;
  imageUrl: string;
  artist: string;
  tags: string;
  isAdult: boolean;
  likes: number;
}

export interface ParsedPost {
  id: string;
  thumbnailUrl: string;
  tags: string[];
  artist: string;
  characters: string[];
  score: number;
  rating: string;
  title: string;
  postUrl: string;
  isVideo?: boolean;
}

export type Page = 'home' | 'catalog' | 'search' | 'watch' | 'favorites' | 'history' | 'profile' | 'hentai' | 'admin';
export interface FavUpdate { anime: Anime; from: number; to: number }

export interface ResumeItem {
  id: string; title: string; imageUrl: string; type: string;
  episodes: number; episodeNumber?: number | null;
}
