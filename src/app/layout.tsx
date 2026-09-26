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
    default: "AnimePlatform — смотреть аниме онлайн бесплатно",
    template: "%s — AnimePlatform",
  },
  description:
    "Тысячи аниме тайтлов, свежие серии и лучшие арты — всё в одном месте. Смотри аниме онлайн бесплатно в хорошем качестве.",
  keywords: ["аниме", "смотреть аниме", "аниме онлайн", "аниме бесплатно", "аниме с русской озвучкой", "anime online"],
  applicationName: "AnimePlatform",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "AnimePlatform",
    statusBarStyle: "black-translucent",
  },
  icons: {
    // Раньше /favicon.ico отдавал 404 → в закладках/встроенных браузерах
    // рядом со ссылкой не было жёлтой AP-иконки. Возвращаем: ico для
    // прямых запросов + PNG для остальных размеров.
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: "/icons/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    siteName: "AnimePlatform",
    locale: "ru_RU",
    url: SITE_URL,
    title: "AnimePlatform — смотреть аниме онлайн бесплатно",
    description: "Тысячи аниме тайтлов, свежие серии и лучшие арты — всё в одном месте.",
    images: [{ url: "/icons/icon-512.png", width: 512, height: 512, alt: "AnimePlatform" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "AnimePlatform — смотреть аниме онлайн бесплатно",
    description: "Тысячи аниме тайтлов, свежие серии и лучшие арты — всё в одном месте.",
    images: ["/icons/icon-512.png"],
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
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
