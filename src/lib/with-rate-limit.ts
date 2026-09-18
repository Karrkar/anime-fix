import { NextRequest, NextResponse } from 'next/server'
import { rateLimit, getClientIp } from './rate-limit'
import { logEvent } from './logger'

/**
 * Wraps a route handler with rate limiting (async — F-10 fix: счётчики
 * в Supabase, fallback in-memory; 429-события пишутся в структурированный лог).
 * Usage in route.ts:
 *   export const POST = withRateLimit(handler)
 */
export function withRateLimit(
  handler: (req: NextRequest) => Promise<NextResponse>,
  pathname?: string,
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const ip = getClientIp(req)
    const path = pathname || new URL(req.url).pathname
    const result = await rateLimit(ip, path)

    if (!result.allowed) {
      logEvent('rate_limited', { ip, path, source: result.source }, 'warn')
      return NextResponse.json(
        { error: 'Слишком много запросов. Попробуйте позже.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.ceil((result.resetAt - Date.now()) / 1000)),
            'X-RateLimit-Remaining': '0',
          },
        },
      )
    }

    const response = await handler(req)
    response.headers.set('X-RateLimit-Remaining', String(result.remaining))
    return response
  }
}
