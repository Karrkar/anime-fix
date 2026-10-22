import { Page } from '@/lib/client-types';

/* ──────────────────── Hentai Page (improved) ──────────────────── */
export const ADULT_VERIFY_KEY = 'anime_platform_adult_verified';
export const VERIFY_TTL = 24 * 60 * 60 * 1000; // 24 hours

export function isVerificationValid(): boolean {
  try {
    const raw = localStorage.getItem(ADULT_VERIFY_KEY);
    if (!raw) return false;
    const { ts } = JSON.parse(raw);
    return Date.now() - ts < VERIFY_TTL;
  } catch { return false; }
}
