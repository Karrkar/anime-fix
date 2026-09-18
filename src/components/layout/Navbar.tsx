'use client';

import { Search, Heart, Clock, User, Play, Menu, ShieldAlert, Home, List, MoreHorizontal } from 'lucide-react';
import { Footer } from '@/components/layout/Footer';
import { Anime, Page } from '@/lib/client-types';

export const BOTTOM_TABS: { page: Page; label: string; icon: React.ReactNode }[] = [
  { page: 'home', label: 'Главная', icon: <Home className="w-5 h-5" /> },
  { page: 'catalog', label: 'Каталог', icon: <List className="w-5 h-5" /> },
  { page: 'search', label: 'Поиск', icon: <Search className="w-5 h-5" /> },
  { page: 'favorites', label: 'Избранное', icon: <Heart className="w-5 h-5" /> },
  { page: 'hentai', label: '18+', icon: <ShieldAlert className="w-5 h-5" /> },
];

export function MobileBottomNav({ page, onNavigate, onSearch, favCount, favUpd, onMoreOpen }: {
  page: Page; onNavigate: (p: Page) => void; onSearch: () => void; favCount: number; favUpd: number; onMoreOpen: () => void;
}) {
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-[var(--card)]/95 backdrop-blur-xl border-t border-[var(--border)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="flex items-stretch justify-around">
        {BOTTOM_TABS.map(t => {
          const isActive = page === t.page;
          const isAdult = t.page === 'hentai';
          return (
            <button
              key={t.page}
              onClick={() => { if (t.page === 'search') { onSearch(); } else { onNavigate(t.page); } }}
              className={`flex flex-col items-center justify-center gap-0.5 flex-1 py-2.5 min-h-[56px] transition-all duration-200 active:scale-95 ${isAdult && isActive ? 'text-red-400' : isAdult ? 'text-[var(--muted-foreground)]' : isActive ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)]'}`}
            >
              <span className="relative">{t.icon}{t.page === 'favorites' && favUpd > 0 && <span className="absolute -top-1.5 -left-2.5 min-w-4 h-4 rounded-full bg-orange-500 text-[9px] text-white flex items-center justify-center font-bold px-1">+{favUpd > 9 ? '9+' : favUpd}</span>}{t.page === 'favorites' && favCount > 0 && <span className="absolute -top-1.5 -right-2.5 min-w-4 h-4 rounded-full bg-red-500 text-[9px] text-white flex items-center justify-center font-bold px-1">{favCount > 9 ? '9+' : favCount}</span>}{t.page === 'hentai' && <span className="absolute -top-1 -right-1.5 w-1.5 h-1.5 rounded-full bg-red-500" />}</span>
              <span className={`text-[10px] leading-tight ${isActive ? 'font-semibold' : ''}`}>{t.label}</span>
              {isActive && !isAdult && <span className="w-5 h-0.5 rounded-full bg-[var(--primary)] mt-0.5" />}
              {isAdult && isActive && <span className="w-5 h-0.5 rounded-full bg-red-400 mt-0.5" />}
            </button>
          );
        })}
        <button
          onClick={onMoreOpen}
          className={`flex flex-col items-center justify-center gap-0.5 flex-1 py-2.5 min-h-[56px] text-[var(--muted-foreground)] transition-all duration-200 active:scale-95`}
        >
          <MoreHorizontal className="w-5 h-5" />
          <span className="text-[10px] leading-tight">Ещё</span>
        </button>
      </div>
    </nav>
  );
}

// ─── Desktop + Mobile More Menu ────────────────────────────────────
export function Navbar({ page, onNavigate, onSearch, favCount, favUpd, onMoreOpen }: {
  page: Page; onNavigate: (p: Page) => void; onSearch: () => void; favCount: number; favUpd: number; onMoreOpen: () => void;
}) {
  const links: { page: Page; label: string; icon: React.ReactNode }[] = [
    { page: 'home', label: 'Главная', icon: <Home className="w-4 h-4" /> },
    { page: 'catalog', label: 'Каталог', icon: <List className="w-4 h-4" /> },
    { page: 'search', label: 'Поиск', icon: <Search className="w-4 h-4" /> },
    { page: 'favorites', label: `Избранное${favCount > 0 ? ` (${favCount})` : ''}${favUpd > 0 ? ` · +${favUpd}` : ''}`, icon: <Heart className="w-4 h-4" /> },
    { page: 'history', label: 'История', icon: <Clock className="w-4 h-4" /> },
    { page: 'profile', label: 'Профиль', icon: <User className="w-4 h-4" /> },
    { page: 'hentai', label: '18+', icon: <ShieldAlert className="w-4 h-4 text-red-400" /> },
  ];

  return (
    <header className="sticky top-0 z-50 bg-[var(--background)]/95 backdrop-blur-md border-b border-[var(--border)]">
      <div className="max-w-7xl mx-auto px-4 h-12 sm:h-14 flex items-center justify-between">
        <button onClick={() => onNavigate('home')} className="flex items-center gap-1.5 sm:gap-2 font-bold text-base sm:text-lg text-[var(--primary)] hover:opacity-80 transition-opacity">
          <Play className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" /> <span className="hidden xs:inline">Anime</span>Platform
        </button>
        <nav className="hidden md:flex items-center gap-1">
          {links.map(l => {
            const isAdult = l.page === 'hentai';
            const isActive = page === l.page;
            return (
              <button
                key={l.page}
                onClick={() => { if (l.page === 'search') { onSearch(); } else { onNavigate(l.page as Page); } }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${isAdult && isActive ? 'bg-red-500/20 text-red-400' : isAdult ? 'text-red-400/70 hover:text-red-400 hover:bg-red-500/10' : isActive ? 'bg-[var(--primary)]/15 text-[var(--primary)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)]'}`}
              >
                {l.icon} {l.label}
              </button>
            );
          })}
        </nav>
        {/* Mobile: More button in header (desktop: hidden) */}
        <div className="md:hidden">
          <button onClick={onMoreOpen} className="p-2 hover:bg-[var(--muted)] rounded-lg active:bg-[var(--muted)]"><Menu className="w-5 h-5" /></button>
        </div>
      </div>
    </header>
  );
}

// ─── Footer ──────────────────────────────────────────────────────────────
