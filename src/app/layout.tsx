import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import PwaRegister from "./pwa-register";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://anime-fix.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Anime Platforma — смотреть аниме онлайн бесплатно",
    template: "%s — Anime Platforma",
  },
  description:
    "Тысячи аниме тайтлов, свежие серии и лучшие арты — всё в одном месте. Смотри аниме онлайн бесплатно в хорошем качестве.",
  keywords: ["аниме", "смотреть аниме", "аниме онлайн", "аниме бесплатно", "аниме с русской озвучкой", "anime online"],
  applicationName: "Anime Platforma",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Anime Platforma",
    statusBarStyle: "black-translucent",
  },
  icons: {
    // Раньше /favicon.ico отдавал 404 → рядом со ссылкой не было жёлтой
    // AP-иконки. Браузеры кэшируют favicon очень агрессивно (Ctrl+F5 его НЕ
    // обновляет) → подключаем с версионным суффиксом ?v=ap3: новый URL
    // заставляет вкладку/закладки/превью перезагрузить иконку.
    icon: [
      { url: "/favicon.ico?v=ap3", sizes: "48x48" },
      { url: "/icons/icon-192.png?v=ap3", sizes: "192x192", type: "image/png" },
    ],
    shortcut: "/favicon.ico?v=ap3",
    apple: "/icons/apple-touch-icon.png?v=ap3",
  },
  openGraph: {
    type: "website",
    siteName: "Anime Platforma",
    locale: "ru_RU",
    url: SITE_URL,
    title: "Anime Platforma — смотреть аниме онлайн бесплатно",
    description: "Тысячи аниме тайтлов, свежие серии и лучшие арты — всё в одном месте.",
    images: [{ url: "/icons/icon-512.png?v=ap3", width: 512, height: 512, alt: "Anime Platforma" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Anime Platforma — смотреть аниме онлайн бесплатно",
    description: "Тысячи аниме тайтлов, свежие серии и лучшие арты — всё в одном месте.",
    images: ["/icons/icon-512.png?v=ap3"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0f0f13",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {/* СТОРОЖ САМОЛЕЧЕНИЯ (26.10.2026, «чёрный экран после деплоев»): инлайн-скрипт
            исполняется всегда, даже если JS-чанки сборки не загрузились (404 старых
            хэшей). Если React-приложение не поставило маркер __apBoot за 9с — вычищаем
            service worker'ы и кэши и перезагружаем страницу один раз за сессию вкладки.
            Логин не страдает: httpOnly cookie недоступны из JS и не трогаются. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
              window.__apBoot=false;
              setTimeout(function(){
                if(window.__apBoot)return;
                try{if(sessionStorage.getItem('ap_healed'))return;}catch(e){return;}
                try{sessionStorage.setItem('ap_healed','1');}catch(e){}
                try{
                  navigator.serviceWorker.getRegistrations().then(function(rs){
                    rs.forEach(function(r){r.unregister();});
                  });
                }catch(e){}
                try{
                  if(window.caches&&caches.keys){
                    caches.keys().then(function(ks){ks.forEach(function(k){caches.delete(k);});});
                  }
                }catch(e){}
                setTimeout(function(){location.replace('/?selfheal=1');},600);
              },9000);
            })();`,
          }}
        />
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
