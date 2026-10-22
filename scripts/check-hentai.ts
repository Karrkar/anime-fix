async function main() {
  // Check vost.pw hentai section
  const r = await fetch('https://r.jina.ai/' + encodeURIComponent('https://v13.vost.pw/hentai/'), {
    headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  });
  const html = await r.text();
  console.log('Hentai page status:', r.status, 'length:', html.length);
  
  const shortstories = html.match(/<div class="shortstory">/g);
  console.log('shortstory divs:', shortstories ? shortstories.length : 0);
  
  if (shortstories) {
    const blocks = html.split(/<div class="shortstory">/);
    if (blocks.length > 1) {
      // Show first hentai block
      const block = blocks[1].slice(0, 3000);
      console.log('\n=== FIRST HENTAI BLOCK ===');
      console.log(block);
    }
  }
  
  // Also try page 2 for hentai
  const r2 = await fetch('https://r.jina.ai/' + encodeURIComponent('https://v13.vost.pw/hentai/page/1/'), {
    headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  });
  const html2 = await r2.text();
  console.log('\nHentai page/1 status:', r2.status, 'length:', html2.length);
  const ss2 = html2.match(/<div class="shortstory">/g);
  console.log('shortstory divs on page/1:', ss2 ? ss2.length : 0);
}

main().catch(console.error);