async function fetchUrl(url: string): Promise<string> {
  const r = await fetch('https://r.jina.ai/' + encodeURIComponent(url), {
    headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  });
  return r.text();
}

async function main() {
  // xxx-igra.com - get game card structure
  console.log('=== xxx-igra.com GAME CARD ===');
  try {
    const html = await fetchUrl('https://xxx-igra.com/game.php?i=391');
    console.log('Len:', html.length);
    const title = html.match(/<title>([^<]+)<\/title>/);
    console.log('Title:', title ? title[1] : 'none');
    // Find image
    const imgs = html.match(/<img[^>]+src="([^"]+)"[^>]*>/g);
    console.log('Imgs:', imgs ? imgs.length : 0);
    if (imgs) console.log('Sample:', imgs[0]);
    // Find description
    const desc = html.match(/<meta name="description" content="([^"]+)"/);
    console.log('Desc:', desc ? desc[1].slice(0, 200) : 'none');
    // Show first 2000 chars
    console.log('\nFirst 2000:', html.slice(0, 2000));
  } catch(e: any) { console.log('Error:', e.message); }

  // xxx-igra.com main page - look for game cards with titles
  console.log('\n\n=== xxx-igra.com MAIN CARDS ===');
  try {
    const html = await fetchUrl('https://xxx-igra.com/');
    // Find game_card divs
    const cards = html.split('game_card');
    console.log('game_card occurrences:', cards.length - 1);
    if (cards.length > 2) {
      console.log('Card 1 context:', cards[1].slice(0, 800));
    }
    // Find all game.php links with surrounding context
    const gameLinkRegex = /<a[^>]*href="game\.php\?i=(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m, count = 0;
    while ((m = gameLinkRegex.exec(html)) !== null && count < 3) {
      console.log(`\nGame link ${m[1]}:`, m[2].replace(/<[^>]*>/g, '').trim().slice(0, 100));
      count++;
    }
  } catch(e: any) { console.log('Error:', e.message); }

  // erogames.com - look for actual game links
  console.log('\n\n=== erogames.com GAME LINKS ===');
  try {
    const html = await fetchUrl('https://erogames.com/ru/hentai-games/type-browser/');
    // Look for various link patterns
    const allLinks = html.match(/href="([^"]+)"/g);
    const gameLinks = allLinks?.filter(l => l.includes('/ru/hentai-games/') && !l.includes('type-browser')) || [];
    console.log('Erogame links:', new Set(gameLinks).size);
    if (gameLinks.length) console.log('Samples:', [...new Set(gameLinks)].slice(0, 8));
    // Look for title patterns near images
    const imgContexts: string[] = [];
    const imgRegex = /<img[^>]+src="([^"]+)"[^>]*alt="([^"]+)"/g;
    let im;
    while ((im = imgRegex.exec(html)) !== null && imgContexts.length < 5) {
      if (im[1].includes('game') || im[2].length > 5) {
        imgContexts.push(`alt="${im[2]}" src="${im[1]}"`);
      }
    }
    console.log('Img+alt samples:', imgContexts);
  } catch(e: any) { console.log('Error:', e.message); }

  // feelex.fun - look for individual game links
  console.log('\n\n=== feelex.fun GAME LINKS ===');
  try {
    const html = await fetchUrl('https://feelex.fun/ru/games/hentai');
    // Find /ru/games/ or /games/ links that aren't category links
    const allLinks = html.match(/href="(https?:\/\/feelex\.fun\/(?:ru\/)?(?:play\/|game\/)[^"]+)"/g);
    console.log('Feelex game links:', allLinks ? new Set(allLinks).size : 0);
    if (allLinks) console.log('Samples:', [...new Set(allLinks)].slice(0, 8));
    // Alternative: look for card-like structures
    const cardDivs = html.match(/class="[^"]*game[^"]*card[^"]*"/gi);
    console.log('Game card classes:', cardDivs ? new Set(cardDivs).size : 0);
    if (cardDivs) console.log('Samples:', [...new Set(cardDivs)].slice(0, 5));
  } catch(e: any) { console.log('Error:', e.message); }
}

main().catch(console.error);
