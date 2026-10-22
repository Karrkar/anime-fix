/**
 * Единый серверный гейт для всего 18+-контента.
 *
 * Раньше (F-15) проверялась только возрастная cookie — контент формально
 * был доступен любому, кто нажал «Мне есть 18». По продуктовому решению
 * платформа теперь честный пейволл: раздел 18+ доступен ТОЛЬКО пользователям
 * с активной подпиской (или админам), и это проверяется на сервере в каждом
 * adult-маршруте: hentai, games, arts?adult=true, rule34, rule34-post, r34img.
 *
 * Порядок проверок:
 *   1. Возрастная cookie anime_age_confirmed (24ч, ставится через /api/age-confirm)
 *   2. Активная подписка / роль admin (httpOnly cookie сессии)
 */
import { NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/db';
import { isAgeVerifiedFromRequest } from '@/lib/validate';
import { logEvent } from '@/lib/logger';

export type AdultAccessResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

export async function checkAdultAccess(
  request: Request,
  path: string,
): Promise<AdultAccessResult> {
  // Шаг 1: возрастное подтверждение (как и раньше)
  if (!isAgeVerifiedFromRequest(request)) {
    logEvent('age_gate_denied', { path }, 'warn');
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'age_verification_required', message: 'Подтвердите возраст 18+ в разделе 18+' },
        { status: 403 },
      ),
    };
  }

  // Шаг 2: активная подписка или админ
  const user = await authFromRequest(request);
  const hasAccess =
    !!user && (user.role === 'admin' || !!user.subscription?.isActive);

  if (!hasAccess) {
    logEvent(
      'subscription_required',
      { path, userId: user?.id, hasUser: !!user },
      'warn',
    );
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'subscription_required',
          message: 'Раздел 18+ доступен по подписке. Оформите подписку в профиле.',
        },
        { status: 403 },
      ),
    };
  }

  return { ok: true };
}
