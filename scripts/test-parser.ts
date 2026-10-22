const VOST_BASE = 'https://v13.vost.pw';
const JINA_READER = 'https://r.jina.ai/';

async function fetchPage(url: string, retries = 2): Promise<string> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(JINA_READER + encodeURIComponent(url), {
        headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) return await r.text();
    } catch { /* retry */ }
    if (i < retries) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  return '';
}

function parseAnimeCards(html: string) {
  const results: any[] = [];
  const parts = html.split(/<div class="shortstory">/);

  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    try {
      const h2Match = block.match(/<h2>\s*<a href="([^"]+)">([\s\S]*?)<\/a>\s*<\/h2>/);
      if (!h2Match) continue;
      let sourceUrl = h2Match[1].trim();
      let rawTitle = h2Match[2].replace(/<[^>]*>/g, '').trim();
      rawTitle = rawTitle.replace(/\[\d+\s*(?:из|\/\s*\d+\+?)?[^\]]*\]/g, '').trim();
      rawTitle = rawTitle.replace(/\[[^\]]*\]/g, '').trim();

      let title = rawTitle;
      let titleRussian = '';
      const slashIdx = rawTitle.indexOf(' / ');
      if (slashIdx > -1) {
        titleRussian = rawTitle.slice(0, slashIdx).trim();
        title = rawTitle.slice(slashIdx + 3).trim();
      } else {
        titleRussian = rawTitle;
      }

      const idMatch = sourceUrl.match(/\/(\d+)-/);
      if (!idMatch) continue;
      const vostId = parseInt(idMatch[1], 10);

      const imgMatch = block.match(/<img class="imgRadius" src="([^"]+)"/);
      const imageUrl = imgMatch
        ? (imgMatch[1].startsWith('http') ? imgMatch[1] : VOST_BASE + imgMatch[1])
        : '';

      const yearMatch = block.match(/Год выхода:\s*<\/strong>(\d{4})/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : 2025;

      const genreMatch = block.match(/Жанр:\s*<\/strong>([\s\S]*?)(?:<\/p>|<p)/);
      const genres = genreMatch ? genreMatch[1].replace(/<[^>]*>/g, '').trim().slice(0, 200) : '';

      const typeMatch = block.match(/Тип:\s*<\/strong>([^<]+)/);
      const type = typeMatch ? typeMatch[1].trim() : 'ТВ';

      const epMatch = block.match(/Количество серий:\s*<\/strong>([^<]+)/);
      let episodes = 0;
      if (epMatch) {
        const numMatch = epMatch[1].trim().match(/(\d+)/);
        if (numMatch) episodes = parseInt(numMatch[1], 10);
      }

      const ratingMatch = block.match(/class="current-rating"[^>]*style="width:\s*(\d+)%/);
      const score = ratingMatch ? parseFloat(ratingMatch[1]) : 0;

      const viewMatch = block.match(/class="staticInfoRightSmotr">(\d+)/);
      const views = viewMatch ? parseInt(viewMatch[1], 10) : 0;

      const descMatch = block.match(/Описание:\s*<\/strong>([\s\S]*?)(?:<\/p>|<div)/);
      const description = descMatch ? descMatch[1].replace(/<[^>]*>/g, '').trim().slice(0, 100) : '';

      results.push({
        vostId, title, titleRussian, imageUrl, type, episodes,
        genres, year, score, views, description: description.slice(0, 60) + '...',
      });
    } catch { /* skip */ }
  }
  return results;
}

async function main() {
  console.log('Fetching page 1...');
  const html = await fetchPage('https://v13.vost.pw/page/1/');
  console.log('HTML length:', html.length);
  const anime = parseAnimeCards(html);
  console.log(`\nParsed ${anime.length} anime:\n`);
  for (const a of anime) {
    console.log(`[${a.vostId}] ${a.titleRussian} / ${a.title} | ${a.type} | ${a.episodes} ep | ${a.year} | ${a.genres} | score:${a.score} views:${a.views}`);
    console.log(`  img: ${a.imageUrl}`);
  }
}

main().catch(console.error);
