import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * ВРЕМЕННЫЙ роут-посредник для девнет-фейсета (удаляется сразу после использования).
 * Нужен потому, что IP песочницы разработки упёрся в дневной лимит airdrop,
 * а серверы Vercel исходят с других адресов. Секрет в заголовке, максимум 0.5 SOL,
 * только тестовые кластеры (токены ничего не стоят).
 */
const FAUCET_SECRET = 'tmp-faucet-7f3k9xQ2mLpWvR8tN4jZ';

export async function POST(request: NextRequest) {
  if (request.headers.get('x-faucet-secret') !== FAUCET_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  try {
    const { address, cluster } = await request.json();
    if (typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      return NextResponse.json({ error: 'bad address' }, { status: 400 });
    }
    const rpcUrl = cluster === 'testnet' ? 'https://api.testnet.solana.com' : 'https://api.devnet.solana.com';

    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'requestAirdrop',
        params: [address, 500_000_000], // 0.5 SOL максимум
      }),
    });
    const j = await r.json() as { result?: string; error?: { message: string } };
    if (j.error) return NextResponse.json({ ok: false, error: j.error.message }, { status: 502 });
    return NextResponse.json({ ok: true, signature: j.result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'bad request' }, { status: 400 });
  }
}
