async function main() {
  // Test various vost domains for hentai
  const urls = [
    'https://v2.vost.pw/hentai/',
    'https://v13.vost.pw/hentai/',
    'https://vost.pw/hentai/',
    'https://www.vost.pw/hentai/',
  ];

  for (const url of urls) {
    console.log(`\n=== Testing ${url} ===`);
    try {
      const r = await fetch('https://r.jina.ai/' + encodeURIComponent(url), {
        headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
        signal: AbortSignal.timeout(15000),
      });
      const html = await r.text();
      const ss = html.match(/<div class="shortstory">/g);
      const title = html.match(/<title>([^<]+)<\/title>/);
      console.log('Status:', r.status, 'Len:', html.length, 'Cards:', ss ? ss.length : 0, 'Title:', title ? title[1] : 'none');
      if (html.length < 500) console.log('Body:', html.slice(0, 300));
    } catch (e: any) {
      console.log('Error:', e.message);
    }
  }

  // Also check what the existing hentai source URLs look like
  console.log('\n=== Checking hentaibaza.com ===');
  try {
    const r = await fetch('https://r.jina.ai/' + encodeURIComponent('https://hentaibaza.com/'), {
      headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
      signal: AbortSignal.timeout(15000),
    });
    const html = await r.text();
    console.log('Status:', r.status, 'Len:', html.length);
    if (html.length > 1000) {
      // Look for video links or cards
      const videoPattern = new RegExp('href="([^"]*(?:video|watch|\\d+)[^"]*)"', 'gi');
      const links = html.match(videoPattern);
      console.log('Video links:', links ? links.slice(0, 10) : 'none');
      const title = html.match(/<title>([^<]+)<\/title>/);
      console.log('Title:', title ? title[1] : 'none');
    } else {
      console.log('Body:', html.slice(0, 500));
    }
  } catch (e: any) {
    console.log('Error:', e.message);
  }
}

main().catch(console.error);