async function main() {
  const r = await fetch('https://r.jina.ai/' + encodeURIComponent('https://v13.vost.pw'), {
    headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(30000),
  });
  const html = await r.text();

  // Extract all shortstory blocks and show the first one
  const blocks = html.split(/<div class="shortstory">/);
  console.log(`Found ${blocks.length - 1} shortstory blocks`);

  if (blocks.length > 1) {
    // Show first block (first 5000 chars)
    const firstBlock = blocks[1];
    console.log('\n=== FIRST SHORTSTORY BLOCK (5000 chars) ===');
    console.log(firstBlock.slice(0, 5000));
    
    // Also check if there are links within it
    const links = firstBlock.match(/href="([^"]+)"/g);
    console.log('\n\nLinks found in first block:', links ? links.slice(0, 10) : 'none');
    
    // Look for img tags
    const imgs = firstBlock.match(/<img[^>]+>/g);
    console.log('\nImg tags:', imgs ? imgs.slice(0, 5) : 'none');
  }
}

main().catch(console.error);