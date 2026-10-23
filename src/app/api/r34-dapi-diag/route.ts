// ВРЕМЕННЫЙ ДИАГНОСТИЧЕСКИЙ РОУТ (октябрь 2026, разбор «почему dapi не проходит
// с рантайма Vercel»). Крон-авторизация; показывает цепочку попыток dapi
// (direct / jina с ключом / jina анонимно) с сырыми фрагментами ответов.
import { NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';
import { JINA_READER, R34_BASE } from '@/lib/sources';
import { jinaHeaders } from '@/lib/jina';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const tag = searchParams.get('tag') || 'arzagod';
  const pid = parseInt(searchParams.get('pid') || '0', 10) || 0;
  const url = `${R34_BASE}/index.php?page=dapi&s=post&q=index&json=1&limit=3&pid=${pid}&tags=${encodeURIComponent(tag)}`;

  const attempts: Array<Record<string, unknown>> = [];

  // 1) direct
  try {
    const t0 = Date.now();
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    attempts.push({ via: 'direct', status: r.status, ms: Date.now() - t0, head: text.slice(0, 120), json: text.trim().startsWith('[') });
  } catch (e) {
    attempts.push({ via: 'direct', error: String(e).slice(0, 100) });
  }

  // 2) jina с ключом (html-формат по умолчанию)
  for (const fmt of ['text', 'html']) {
    try {
      const t0 = Date.now();
      const headers = jinaHeaders({ Accept: 'application/json', 'X-Return-Format': fmt });
      const r = await fetch(JINA_READER + encodeURIComponent(url), { headers, signal: AbortSignal.timeout(15000) });
      const text = await r.text();
      attempts.push({
        via: `jina-${fmt}${'Authorization' in headers ? '-key' : '-anon'}`, status: r.status, ms: Date.now() - t0,
        head: text.slice(0, 150), len: text.length, json: text.trim().startsWith('['),
      });
    } catch (e) {
      attempts.push({ via: `jina-${fmt}`, error: String(e).slice(0, 100) });
    }
  }

  // 3) HTML-список через jina (эталон работоспособности reader на этом источнике)
  try {
    const t0 = Date.now();
    const headers = jinaHeaders({});
    const r = await fetch(JINA_READER + encodeURIComponent(`${R34_BASE}/index.php?page=post&s=list&tags=${encodeURIComponent(tag)}&pid=0`), { headers, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    attempts.push({
      via: `jina-html-list${'Authorization' in headers ? '-key' : '-anon'}`, status: r.status, ms: Date.now() - t0,
      len: text.length, thumbs: (text.match(/class="thumb"/g) || []).length,
    });
  } catch (e) {
    attempts.push({ via: 'jina-html-list', error: String(e).slice(0, 100) });
  }

  return NextResponse.json({ url, attempts, jinaKeyInEnv: !!process.env.JINA_API_KEY?.trim() });
}
