import { NextRequest, NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/db';
import { withRateLimit } from '@/lib/with-rate-limit';
import { logEvent } from '@/lib/logger';
import { generatePromoCodes, listPromoCodes, deactivatePromoCode, normalizePromoCode } from '@/lib/balance';

export const dynamic = 'force-dynamic';

/**
 * АДМИН: генерация и управление промо-кодами AP (только role=admin).
 *
 * GET                              → последние 50 кодов с использованием
 * POST { action: 'generate', amountAp, count, maxUses?, expiresInDays?, note? }
 *                                 → создать пачку кодов (AP-XXXXX-XXXXX)
 * POST { action: 'deactivate', code } → погасить код (больше не активируется)
 */

async function promoHandler(request: NextRequest) {
  try {
    const user = await authFromRequest(request);
    if (user?.role !== 'admin') {
      return NextResponse.json({ error: 'Только админ' }, { status: 403 });
    }

    if (request.method === 'GET') {
      const codes = await listPromoCodes(50);
      return NextResponse.json({ ok: true, codes });
    }

    const body = await request.json();
    const { action } = body;

    if (action === 'generate') {
      const amountAp = Math.round(Number(body.amountAp));
      const count = Math.round(Number(body.count));
      const maxUses = body.maxUses === undefined ? 1 : Math.round(Number(body.maxUses));
      const expiresInDays = body.expiresInDays === undefined || body.expiresInDays === null
        ? null : Math.round(Number(body.expiresInDays));
      const note = typeof body.note === 'string' ? body.note : '';

      if (!Number.isFinite(amountAp) || amountAp < 1 || amountAp > 50000) {
        return NextResponse.json({ error: 'Сумма кода: 1–50000 AP' }, { status: 400 });
      }
      if (!Number.isFinite(count) || count < 1 || count > 200) {
        return NextResponse.json({ error: 'Количество: 1–200' }, { status: 400 });
      }
      if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 1000) {
        return NextResponse.json({ error: 'Лимит активаций: 1–1000' }, { status: 400 });
      }
      if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays < 1 || expiresInDays > 365)) {
        return NextResponse.json({ error: 'Срок действия: 1–365 дней' }, { status: 400 });
      }

      try {
        const codes = await generatePromoCodes({ amountAp, count, maxUses, expiresInDays, note });
        logEvent('promo_generated', { amountAp, count, maxUses, expiresInDays, by: user.id });
        return NextResponse.json({
          ok: true,
          codes,
          message: `Создано ${count} кодов по ${amountAp} AP`,
        });
      } catch (e) {
        return NextResponse.json({ error: `Генерация не удалась: ${String((e as Error).message || e).slice(0, 200)}` }, { status: 500 });
      }
    }

    if (action === 'deactivate') {
      const code = typeof body.code === 'string' ? body.code : '';
      if (!normalizePromoCode(code)) {
        return NextResponse.json({ error: 'Некорректный формат кода' }, { status: 400 });
      }
      const ok = await deactivatePromoCode(code);
      if (!ok) return NextResponse.json({ error: 'Не удалось погасить код' }, { status: 500 });
      logEvent('promo_deactivated', { code: code.toUpperCase(), by: user.id });
      return NextResponse.json({ ok: true, message: 'Код погашен' });
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
  } catch (e) {
    console.error('admin promo route error:', e);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}

export const GET = withRateLimit(promoHandler, '/api/admin/promo');
export const POST = withRateLimit(promoHandler, '/api/admin/promo');
