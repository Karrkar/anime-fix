async function fetchUrl(url: string): Promise<string> {
  const r = await fetch('https://r.jina.ai/' + encodeURIComponent(url), {
    headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  });
  return r.text();
}

async function main() {
  // 1. itch.io
  console.log('=== itch.io ===');
  try {
    const html = await fetchUrl('https://itch.io/games/free/platform-web/tag-hentai');
    console.log('Len:', html.length);
    // Look for game cards
    const links = html.match(/href="https:\/\/[a-z0-9-]+\.itch\.io\/[a-z0-9-]+"/gi);
    console.log('Game links:', links ? new Set(links).size : 0);
    if (links) console.log('Samples:', [...new Set(links)].slice(0, 5));
    // Look for title + image patterns
    const titles = html.match(/<a[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/a>/gi);
    console.log('Title links:', titles ? titles.length : 0);
    // Check for img tags
    const imgs = html.match(/<img[^>]+src="([^"]+)"[^>]*>/g);
    console.log('Img tags:', imgs ? imgs.length : 0);
    if (imgs) console.log('Sample imgs:', imgs.slice(0, 3));
    // Show a chunk around a game link
    const idx = html.indexOf('itch.io/');
    if (idx > 100) console.log('\nContext:', html.slice(Math.max(0,idx-200), idx+300));
  } catch(e: any) { console.log('Error:', e.message); }

  // 2. xxx-igra.com
  console.log('\n\n=== xxx-igra.com ===');
  try {
    const html = await fetchUrl('https://xxx-igra.com/');
    console.log('Len:', html.length);
    const title = html.match(/<title>([^<]+)<\/title>/);
    console.log('Title:', title ? title[1] : 'none');
    if (html.length < 1000) console.log('Body:', html);
    else {
      // Look for game cards/links
      const gameLinks = html.match(/href="([^"]*(?:game|igra|play)[^"]*)"/gi);
      console.log('Game links:', gameLinks ? gameLinks.length : 0);
      if (gameLinks) console.log('Samples:', gameLinks.slice(0, 5));
      const imgs = html.match(/<img[^>]+src="([^"]+)"[^>]*>/g);
      console.log('Img tags:', imgs ? imgs.length : 0);
      // Context
      const aIdx = html.indexOf('<a href');
      if (aIdx > 0) console.log('\nFirst link context:', html.slice(aIdx, aIdx+500));
    }
  } catch(e: any) { console.log('Error:', e.message); }

  // 3. erogames.com
  console.log('\n\n=== erogames.com ===');
  try {
    const html = await fetchUrl('https://erogames.com/ru/hentai-games/type-browser/');
    console.log('Len:', html.length);
    const title = html.match(/<title>([^<]+)<\/title>/);
    console.log('Title:', title ? title[1] : 'none');
    if (html.length < 1000) console.log('Body:', html);
    else {
      const gameLinks = html.match(/href="([^"]*\/game\/[^"]+)"/gi);
      console.log('Game links:', gameLinks ? new Set(gameLinks).size : 0);
      if (gameLinks) console.log('Samples:', [...new Set(gameLinks)].slice(0, 5));
      const imgs = html.match(/<img[^>]+src="([^"]+)"[^>]*>/g);
      console.log('Img tags:', imgs ? imgs.length : 0);
      const aIdx = html.indexOf('game/');
      if (aIdx > 100) console.log('\nGame context:', html.slice(Math.max(0,aIdx-300), aIdx+400));
    }
  } catch(e: any) { console.log('Error:', e.message); }

  // 4. feelex.fun
  console.log('\n\n=== feelex.fun ===');
  try {
    const html = await fetchUrl('https://feelex.fun/ru/games/hentai');
    console.log('Len:', html.length);
    const title = html.match(/<title>([^<]+)<\/title>/);
    console.log('Title:', title ? title[1] : 'none');
    if (html.length < 1000) console.log('Body:', html);
    else {
      const gameLinks = html.match(/href="([^"]*(?:game|play)[^"]*)"/gi);
      console.log('Game links:', gameLinks ? gameLinks.length : 0);
      if (gameLinks) console.log('Samples:', gameLinks.slice(0, 5));
      const imgs = html.match(/<img[^>]+src="([^"]+)"[^>]*>/g);
      console.log('Img tags:', imgs ? imgs.length : 0);
      const aIdx = html.indexOf('<a href');
      if (aIdx > 0) console.log('\nFirst link context:', html.slice(aIdx, aIdx+500));
    }
  } catch(e: any) { console.log('Error:', e.message); }
}

main().catch(console.error);