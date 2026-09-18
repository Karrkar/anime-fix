import type { MetadataRoute } from 'next';

/**
 * PWA-манифест (Next.js metadata route → /manifest.webmanifest).
 * Позволяет «установить» сайт как приложение: иконка на рабочем столе,
 * полноэкранный режим без адресной строки.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AnimePlatform — смотреть аниме онлайн',
    short_name: 'Anime',
    description:
      'Тысячи тайтлов, свежие серии и лучшие арты — всё в одном месте. Смотри аниме онлайн бесплатно.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0f0f13',
    theme_color: '#0f0f13',
    lang: 'ru',
    categories: ['entertainment', 'video'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
