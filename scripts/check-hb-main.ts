async function main() {
  const r = await fetch('https://r.jina.ai/' + encodeURIComponent('https://hentaibaza.com/'), {
    headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  });
  const html = await r.text();
  console.log('Status:', r.status, 'Len:', html.length);
  
  // Find video cards - look for patterns
  const watchLinks = html.match(/href="(\/watch\/\d+)"/g);
  console.log('Watch links:', watchLinks ? watchLinks.length : 0);
  if (watchLinks) console.log('Sample:', watchLinks.slice(0, 5));
  
  // Look for img tags near watch links
  const imgPattern = new RegExp('<img[^>]+src="([^"]+)"[^>]*>', 'g');
  const imgs: string[] = [];
  let m;
  while ((m = imgPattern.exec(html)) !== null) {
    if (m[1].includes('thumb') || m[1].includes('video') || m[1].includes('cover')) {
      imgs.push(m[1]);
    }
  }
  console.log('Thumbnail imgs:', imgs.length);
  if (imgs.length) console.log('Sample:', imgs.slice(0, 3));
  
  // Look for any JSON data embedded
  const jsonMatch = html.match(/<script[^>]*>\s*window\.__DATA__\s*=\s*({.+?})\s*<\/script>/s);
  if (jsonMatch) {
    console.log('Found embedded JSON data!');
  }
  
  // Check for API endpoints in JS
  const apiMatch = html.match(/(\/api\/[^"'\s]+)/g);
  console.log('API endpoints:', apiMatch ? [...new Set(apiMatch)] : 'none');
  
  // Show a chunk of HTML around a watch link
  const watchIdx = html.indexOf('href="/watch/');
  if (watchIdx > -1) {
    console.log('\nContext around watch link (500 chars):');
    console.log(html.slice(Math.max(0, watchIdx - 300), watchIdx + 200));
  }
}

main().catch(console.error);