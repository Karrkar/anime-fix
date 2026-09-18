import type { MetadataRoute } from 'next';

/**
 * F-26 fix: robots.txt собирается метадата-маршрутом Next.js.
 * /api/* закрыт от индексации, добавлена ссылка на sitemap.
 * Базовый URL можно переопределить переменной NEXT_PUBLIC_SITE_URL
 * (актуально при подключении кастомного домена).
 */
export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://anime-fix.vercel.app';
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
