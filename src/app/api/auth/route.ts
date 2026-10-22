import { NextResponse } from 'next/server';

/**
 * F-28 fix: раньше /api/auth существовал как пустой файл и отвечал
 * HTML-страницей 404 без пояснений. Теперь маршрут отвечает понятным
 * JSON с подсказкой: вся аутентификация живёт в едином маршруте
 * /api/subscription (action: register | login | check | logout).
 */
function authNotFound() {
  return NextResponse.json(
    {
      ok: false,
      reason: 'not_found',
      hint: 'Auth lives at /api/subscription — POST { action: "register" | "login" | "check" | "logout", ... }',
    },
    {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}

export async function GET() {
  return authNotFound();
}

export async function POST() {
  return authNotFound();
}
