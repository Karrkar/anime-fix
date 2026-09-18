import type { NextConfig } from "next";
// F-27 fix: CSP-хосты берутся из единого реестра внешних источников (src/lib/sources.ts)
import { CSP_FRAME_HOSTS, CSP_CONNECT_HOSTS, IMAGE_HOSTS } from "./src/lib/sources";

// Origin Supabase для connect-src — из env сборки (fallback — текущий проект)
const supabaseOrigin = (() => {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://uymeyfnuxfbkwisggzdt.supabase.co";
  try {
    return new URL(raw).origin;
  } catch {
    return "https://uymeyfnuxfbkwisggzdt.supabase.co";
  }
})();

const nextConfig: NextConfig = {
  // F-24 fix: страховки компилятора и React возвращены.
  // typescript.ignoreBuildErrors удалён (раньше ошибки типов молча попадали в
  // production — так прошёл баг вебхука body→n и лишний [] в useState),
  // reactStrictMode включает двойной рендер в dev для выявления побочных эффектов.
  reactStrictMode: true,
  // next/image: оптимизация постеров (lazy-load, resize, blur-плейсхолдеры).
  // Домены — из единого реестра источников (F-27), плюс CDN мал.списка артов.
  images: {
    remotePatterns: IMAGE_HOSTS.map(h => ({ protocol: 'https' as const, hostname: h })),
    formats: ['image/avif', 'image/webp'],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // F-06 fix: убран 'unsafe-eval' из script-src (React/Next в production
              // и framer-motion его не требуют). 'unsafe-inline' остаётся — Next.js
              // без nonce-инфраструктуры не работает без инлайновых bootstrap-скриптов.
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: blob: https:",
              "media-src 'self' blob: https:",
              // F-27 fix: хосты производятся от src/lib/sources.ts и env
              "connect-src 'self' " + [supabaseOrigin, ...CSP_CONNECT_HOSTS].join(" "),
              "frame-src 'self' " + CSP_FRAME_HOSTS.join(" "),
              "worker-src 'self' blob:",
              "frame-ancestors 'self'",
              "object-src 'none'",
              "base-uri 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
