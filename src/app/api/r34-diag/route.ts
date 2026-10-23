// Диагностика доступности rule34 с рантайма Vercel (временный роут, админ-гейт)
import { NextRequest, NextResponse } from 'next/server';
import { checkAdultAccess } from '@/lib/adult-access';

export const maxDuration = 60;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function probe(name: string, url: string, headers: Record<string, string>, check: (html: string) => string) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    return { name, status: r.status, ms: Date.now() - t0, bytes: text.length, info: check(text) };
  } catch (e) {
    return { name, status: 0, ms: Date.now() - t0, bytes: 0, info: `THROW: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function GET(request: NextRequest) {
  const access = await checkAdultAccess(request, '/api/r34-diag');
  if (!access.ok) return access.response;

  const key = process.env.JINA_API_KEY?.trim();
  const jinaAnonHeaders = { Accept: 'text/html', 'X-Return-Format': 'html', 'X-Target-Selector': '.content' };
  const jinaKeyHeaders = key ? { ...jinaAnonHeaders, Authorization: `Bearer ${key}` } : null;

  const listUrl = 'https://rule34.xxx/index.php?page=post&s=list&tags=arzagod&pid=0';
  const results = [] as Awaited<ReturnType<typeof probe>>[];

  results.push(await probe('direct_rule34_list', listUrl, { Accept: 'text/html' }, h =>
    h.includes('class="thumb"') ? `thumbs=${(h.match(/class="thumb"/g) || []).length}` : (h.includes('Just a moment') || h.includes('CAPTCHA')) ? 'CF_CHALLENGE' : 'no_thumbs'));
  results.push(await probe('api_subdomain_list', 'https://api.rule34.xxx/index.php?page=post&s=list&tags=arzagod&pid=0', { Accept: 'text/html' }, h =>
    h.includes('class="thumb"') ? `thumbs=${(h.match(/class="thumb"/g) || []).length}` : h.length === 0 ? 'EMPTY_BODY' : 'other'));
  results.push(await probe('api_autocomplete', 'https://api.rule34.xxx/autocomplete.php?q=arzagod', {}, h => h.includes('arzagod') ? h.slice(0, 60) : 'unexpected'));
  results.push(await probe('jina_anon', 'https://r.jina.ai/' + encodeURIComponent(listUrl), jinaAnonHeaders, h =>
    h.includes('class="thumb"') ? `thumbs=${(h.match(/class="thumb"/g) || []).length} len=${h.length}` : h.includes('AuthenticationRequired') || h.includes('401') ? 'AUTH_BLOCK' : h.slice(0, 80)));
  if (jinaKeyHeaders) {
    results.push(await probe('jina_with_key', 'https://r.jina.ai/' + encodeURIComponent(listUrl), jinaKeyHeaders, h =>
      h.includes('class="thumb"') ? `thumbs=${(h.match(/class="thumb"/g) || []).length} len=${h.length}`
        : h.includes('InsufficientBalance') ? 'BALANCE_402'
        : h.includes('AuthenticationRequired') ? 'KEY_AUTH_401'
        : h.slice(0, 80)));
  }
  results.push(await probe('wimg_cdn', 'https://wimg.rule34.xxx/thumbnails/3827/thumbnail_abc123.jpg', {}, h => `body_len=${h.length}`));

  return NextResponse.json({
    env: { JINA_API_KEY: key ? `present(len=${key.length})` : 'MISSING' },
    results,
    ts: new Date().toISOString(),
  });
}
