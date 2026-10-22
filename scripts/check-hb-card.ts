async function main() {
  const r = await fetch('https://r.jina.ai/' + encodeURIComponent('https://hentaibaza.com/'), {
    headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  });
  const html = await r.text();

  // Extract one full video card - from <a href="/watch/ to next </a>
  const cardRegex = /<a href="\/watch\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  let count = 0;
  while ((match = cardRegex.exec(html)) !== null && count < 2) {
    console.log(`\n=== CARD ${match[1]} ===`);
    console.log(match[2].slice(0, 1500));
    count++;
  }

  // Also check a watch page for description/genres
  console.log('\n\n=== WATCH PAGE 129 ===');
  const r2 = await fetch('https://r.jina.ai/' + encodeURIComponent('https://hentaibaza.com/watch/129'), {
    headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  });
  const html2 = await r2.text();
  console.log('Len:', html2.length);
  console.log(html2.slice(0, 3000));
}

main().catch(console.error);