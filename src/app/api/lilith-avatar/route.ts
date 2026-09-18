import { NextResponse } from 'next/server';
import { checkAdultAccess } from '@/lib/adult-access';
import { LILITH_AVATAR_WEBP_BASE64 } from '@/lib/lilith-avatar-data';

/**
 * GET /api/lilith-avatar — аватар Лилит (суккуб) для чата в разделе 18+.
 *
 * Изображение откровенное, поэтому НЕ лежит в /public: отдаётся только через
 * этот эндпоинт и только после серверного adult-гейта (возрастная cookie +
 * активная подписка/админ) — той же проверки, что и весь раздел 18+.
 * Браузерные <img>/fetch прикладывают обе httpOnly-cookie автоматически,
 * поэтому UI чата внутри 18+ работает без лишних заголовков.
 *
 * Кэш отключён (no-store): при обновлении арта пользователи видят новую
 * версию сразу, без ожидания истечения max-age (раньше из-за max-age=86400
 * старая картинка жила в браузере сутки после деплоя).
 */

export async function GET(request: Request) {
  const access = await checkAdultAccess(request, '/api/lilith-avatar');
  if (!access.ok) return access.response;

  const bytes = Buffer.from(LILITH_AVATAR_WEBP_BASE64, 'base64');
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, no-store',
    },
  });
}
