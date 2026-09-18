async function fetchUrl(url: string): Promise<string> {
  const r = await fetch('https://r.jina.ai/' + encodeURIComponent(url), {
    headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  });
  return r.text();
}

async function main() {
  // xxx-igra.com - card structure
  console.log('=== xxx-igra.com CARDS ===');
  try {
    const html = await fetchUrl('https://xxx-igra.com/');
    const parts = html.split('game_card');
    console.log('game_card occurrences:', parts.length - 1);
    for (let i = 1; i < Math.min(parts.length, 4); i++) {
      console.log(`\n--- Card ${i} ---`);
      console.log(parts[i].slice(0, 600));
    }
  } catch(e: any) { console.log('Error:', e.message); }

  // erogames.com - individual game links
  console.log('\n\n=== erogames.com ===');
  try {
    const html = await fetchUrl('https://erogames.com/ru/hentai-games/genre-visual-novel/');
    console.log('Len:', html.length);
    const linkPattern = new RegExp('href="(/ru/hentai-games/[a-z0-9-]+)"', 'gi');
    const gameLinks = html.match(linkPattern);
    const unique = gameLinks ? [...new Set(gameLinks)].filter(l => !l.includes('genre-') && !l.includes('tag-') && !l.includes('type-')) : [];
    console.log('Individual game links:', unique.length);
    if (unique.length) console.log('Samples:', unique.slice(0, 10));
    const imgPattern = new RegExp('<img[^>]+src="(https?:\\S+)"[^>]+alt="([^"]+)"', 'g');
    let im, imgCount = 0;
    while ((im = imgPattern.exec(html)) !== null && imgCount < 3) {
      console.log('Img:', im[1].slice(0, 80), '| alt:', im[2].slice(0, 60));
      imgCount++;
    }
  } catch(e: any) { console.log('Error:', e.message); }

  // feelex.fun - card blocks
  console.log('\n\n=== feelex.fun ===');
  try {
    const html = await fetchUrl('https://feelex.fun/ru/games/hentai');
    const blocks = html.split('card-game-block');
    console.log('card-game-block:', blocks.length - 1);
    if (blocks.length > 1) console.log(blocks[1].slice(0, 800));
  } catch(e: any) { console.log('Error:', e.message); }
}

main().catch(console.error);