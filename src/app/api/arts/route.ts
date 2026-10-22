import { NextRequest, NextResponse } from 'next/server';
import { mapToCamel } from '@/lib/anime-utils'; // F-08: без 6.1 МБ data.ts в холодном старте
import { withRateLimit } from '@/lib/with-rate-limit';
import { checkAdultAccess } from '@/lib/adult-access'; // 18+ = возраст + подписка

async function artsHandler(request: NextRequest) {
  // F-15 fix: adult-арты проверяют серверную cookie возрастного гейта.
  // Усилено: adult-арты требуют ещё и активную подписку (18+ по подписке).
  // SFW-арты доступны без ограничений.
  const adult = new URL(request.url).searchParams.get('adult') === 'true';
  if (adult) {
    const access = await checkAdultAccess(request, '/api/arts');
    if (!access.ok) return access.response;
  }

  // F-08: статические массивы грузятся лениво при первом запросе
  const { SFW_ARTS, ADULT_ARTS } = await import('@/lib/data');
  const arts = adult ? ADULT_ARTS : SFW_ARTS;
  return NextResponse.json({ arts: mapToCamel(arts), total: arts.length });
}

export const GET = withRateLimit(artsHandler, '/api/arts')
