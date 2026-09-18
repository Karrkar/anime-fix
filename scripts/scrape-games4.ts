async function fetchUrl(url: string): Promise<string> {
  const r = await fetch('https://r.jina.ai/' + encodeURIComponent(url), {
    headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  });
  return r.text();
}

async function main() {
  // feelex.fun - get the content of card-game-block
  console.log('=== feelex.fun CARDS ===');
  try {
    const html = await fetchUrl('https://feelex.fun/ru/games/hentai');
    const blockPattern = new RegExp('card-game-block[^>]*>([\\s\\S]*?)(?=card-game-block|$)', 'g');
    let m, count = 0;
    while ((m = blockPattern.exec(html)) !== null && count < 3) {
      const block = m[1].slice(0, 1000);
      if (block.includes('href') || block.includes('img') || block.includes('src')) {
        console.log(`\n--- Block ${count + 1} ---`);
        console.log(block);
        count++;
      }
    }
    if (count === 0) {
      // Try different approach - find href near card-game-block
      const idx = html.indexOf('card-game-block');
      if (idx > -1) {
        console.log('Context around first card-game-block (1500 chars):');
        console.log(html.slice(Math.max(0, idx - 100), idx + 1400));
      }
    }
  } catch(e: any) { console.log('Error:', e.message); }

  // xxx-igra.com - get a real game card with image
  console.log('\n\n=== xxx-igra.com REAL GAME CARD ===');
  try {
    const html = await fetchUrl('https://xxx-igra.com/');
    // Find all game.php links with full context
    const linkPattern = new RegExp('<a[^>]*href="game\\.php\\?i=(\\d+)"[^>]*>([\\s\\S]*?)<\\/a>', 'g');
    let lm, gc = 0;
    while ((lm = linkPattern.exec(html)) !== null && gc < 3) {
      const title = lm[2].replace(/<[^>]*>/g, '').trim();
      if (title.length > 3) {
        console.log(`\nGame ${lm[1]}: ${title}`);
        // Get surrounding context for image
        const start = Math.max(0, lm.index - 500);
        const context = html.slice(start, lm.index + 200);
        const imgMatch = context.match(/src="([^"]+(?:\.jpg|\.png|\.webp|\.gif))[^"]*"/);
        console.log('  Image:', imgMatch ? imgMatch[1] : 'none found in context');
        gc++;
      }
    }
  } catch(e: any) { console.log('Error:', e.message); }

  // Also check what a game page looks like for description/image
  console.log('\n\n=== xxx-igra.com GAME PAGE ===');
  try {
    const html = await fetchUrl('https://xxx-igra.com/game.php?i=391');
    const desc = html.match(/name="Description" content="([^"]+)"/);
    console.log('Description:', desc ? desc[1].slice(0, 200) : 'none');
    // Find main game image
    const imgs = html.match(/src="(pic[^"]+)"/g);
    console.log('pic/ images:', imgs ? imgs.length : 0);
    if (imgs) console.log('Samples:', imgs.slice(0, 3));
  } catch(e: any) { console.log('Error:', e.message); }
}

main().catch(console.error);