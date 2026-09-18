async function main() {
  const r = await fetch('https://r.jina.ai/' + encodeURIComponent('https://hentaibaza.com/videos'), {
    headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  });
  const html = await r.text();
  console.log('Status:', r.status, 'Len:', html.length);
  console.log('First 4000 chars:');
  console.log(html.slice(0, 4000));
}

main().catch(console.error);