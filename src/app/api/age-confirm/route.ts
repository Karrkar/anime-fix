import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/with-rate-limit';
import { isAgeVerifiedFromRequest } from '@/lib/validate';

/**
 * F-15 fix: серверная часть возрастного гейта 18+.
 *
 * Раньше подтверждение возраста жило ТОЛЬКО в localStorage — все 18+-данные
 * (hentai, games, adult-арты, rule34) были доступны прямым API-запросом.
 * Теперь клиент после клика «Мне есть 18» вызывает этот эндпоинт, он ставит
 * httpOnly-cookie anime_age_confirmed=1 на 24 часа (тот же TTL, что и у
 * localStorage-флага), а все 18+-маршруты проверяют её на сервере.
 *
 * Cookie httpOnly, потому что клиенту её читать не нужно: собственный UI-флаг
 * фронтенд хранит в localStorage, cookie существует только для сервера.
 */
async function ageConfirmPostHandler(_request: NextRequest) {
  const res = NextResponse.json({ ok: true, verified: true });
  res.cookies.set('anime_age_confirmed', '1', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60, // 24 часа — как VERIFY_TTL на клиенте
  });
  return res;
}

async function ageConfirmGetHandler(request: NextRequest) {
  return NextResponse.json({ verified: isAgeVerifiedFromRequest(request) });
}

export const POST = withRateLimit(ageConfirmPostHandler, '/api/age-confirm');
export const GET = withRateLimit(ageConfirmGetHandler, '/api/age-confirm');
