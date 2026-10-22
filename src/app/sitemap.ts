import type { MetadataRoute } from 'next';
import { getDb } from '@/lib/db';

/**
 * Sitemap: главная + SEO-страницы всех тайтлов из anime_catalog
 * (до 5000 шт., лимит Google на один sitemap — 50 000 URL, запас есть).
 *
 * БД может быть недоступна в момент сборки — тогда отдаём минимум
 * (только главную), sitemap.xml остаётся валидным.
 */
export const revalidate = 86400;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://anime-fix.vercel.app';

  const entries: MetadataRoute.Sitemap = [
    {
      url: base,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1,
    },
  ];

  try {
    const db = getDb();
    const { data, error } = await db
      .from('anime_catalog')
      .select('vost_id, updated_at')
      .order('vost_id', { ascending: false })
      .limit(5000);
    if (!error && data) {
      for (const row of data as Array<{ vost_id: number; updated_at?: string | null }>) {
        entries.push({
          url: `${base}/anime/db-${row.vost_id}`,
          lastModified: row.updated_at ? new Date(row.updated_at) : undefined,
          changeFrequency: 'weekly',
          priority: 0.7,
        });
      }
    }
  } catch {
    // тихо: без БД отдаём главную
  }

  return entries;
}
