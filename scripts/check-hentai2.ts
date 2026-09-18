async function main() {
  // Check what the hentai URL actually returns
  const r = await fetch('https://r.jina.ai/' + encodeURIComponent('https://v13.vost.pw/hentai/'), {
    headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  });
  const html = await r.text();
  console.log('Hentai response (full):');
  console.log(html);

  // Also try the main page page/2 to see more anime
  console.log('\n\n=== Checking main page 2 ===');
  const r2 = await fetch('https://r.jina.ai/' + encodeURIComponent('https://v13.vost.pw/page/2/'), {
    headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  });
  const html2 = await r2.text();
  const ss2 = html2.match(/<div class="shortstory">/g);
  console.log('Page 2 shortstory divs:', ss2 ? ss2.length : 0);
  
  // Check the title from the page to see if it mentions hentai
  const titleMatch = html2.match(/<title>([^<]+)<\/title>/);
  console.log('Page 2 title:', titleMatch ? titleMatch[1] : 'no title');
}

main().catch(console.error);