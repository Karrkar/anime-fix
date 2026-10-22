import * as fs from 'fs';
import * as path from 'path';

const R34 = 'https://rule34.xxx';
const PP = 42;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = {
  'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'identity',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1', 'Cache-Control': 'max-age=0',
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Post {
  id: string; thumbnailUrl: string; tags: string[]; artist: string;
  characters: string[]; score: number; rating: string; title: string; postUrl: string;
}

function parse(html: string): Post[] {
  const posts: Post[] = [];
  const rx = /<span id="s(\d+)" class="thumb"[^>]*>\s*<a id="p(\d+)" href="([^"]+)">[\s\S]*?<img[^>]*src="([^"]+)"[^>]*title="([^"]+)"/g;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const [, , id, href, thumb, title] = m;
    const tags: string[] = [];
    let score = 0, rating = 'explicit';
    for (const p of title.trim().split(/\s+/)) {
      if (p.startsWith('score:')) score = parseInt(p.replace('score:', ''), 10) || 0;
      else if (p.startsWith('rating:')) rating = p.replace('rating:', '');
      else if (p && !p.startsWith('(') && !p.startsWith(')')) {
        const n = p.replace(/_/g, ' ');
        if (!tags.some(t => t.toLowerCase() === n.toLowerCase())) tags.push(n);
      }
    }
    const ch = tags.filter(t => t.includes('('));
    const sl = ch.length > 0 ? ch.slice(0, 2).map(c => c.replace(/ \(.*\)$/, '')).join(', ') : tags.slice(0, 3).join(', ');
    const a = tags.find(t => t.toLowerCase() === 'balecxi') || tags.find(t => !t.includes('(') && t !== '1girl' && t !== '1boy' && !t.startsWith('ai '));
    posts.push({ id, thumbnailUrl: thumb, tags, artist: a || 'Unknown', characters: ch.filter(t => !t.includes('fate') && !t.includes('series')).map(c => c.replace(/ \(.*\)$/, '')), score, rating, title: sl, postUrl: R34 + href });
  }
  return posts;
}

async function getPage(pid: number, retries: number): Promise<Post[] | null> {
  for (let a = 0; a <= retries; a++) {
    try {
      const r = await fetch(R34 + '/index.php?page=post&s=list&tags=balecxi&pid=' + pid, { headers: H, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { continue; }
      const html = await r.text();
      if (html.length < 10000 && html.includes('Just a moment')) { await sleep(3000 * (a + 1)); continue; }
      return parse(html);
    } catch { await sleep(2000 * (a + 1)); }
  }
  return null;
}

async function main() {
  let html = '';
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(R34 + '/index.php?page=post&s=list&tags=balecxi&pid=0', { headers: H, signal: AbortSignal.timeout(15000) });
      html = await r.text(); break;
    } catch { await sleep(5000); }
  }
  const m = html.match(/href="[^"]*pid=(\d+)"[^>]*alt="last page"/);
  const total = m ? Math.floor(parseInt(m[1], 10) / PP) + 1 : 1;
  console.log('Pages:', total);

  const all: Post[] = [];
  const seen = new Set<string>();
  const fail: number[] = [];

  for (let p = 0; p < total; p++) {
    const posts = await getPage(p * PP, 1);
    if (posts) { for (const post of posts) { if (!seen.has(post.id)) { seen.add(post.id); all.push(post); } } }
    else { fail.push(p); }
    process.stdout.write('\r' + (p + 1) + '/' + total + ' | ' + all.length + ' posts | ' + fail.length + ' failed   ');
    await sleep(1000);
  }
  console.log('\nPhase 1 done:', all.length, 'failed:', fail.length);

  if (fail.length > 0) {
    console.log('\nRetrying', fail.length, 'pages...');
    const sf: number[] = [];
    for (const p of fail) {
      const posts = await getPage(p * PP, 2);
      if (posts) { for (post of posts) { if (!seen.has(post.id)) { seen.add(post.id); all.push(post); } } }
      else { sf.push(p); }
      process.stdout.write('\rRetried: ' + (fail.length - sf.length) + '/' + fail.length + ' | ' + all.length + ' total   ');
      await sleep(3000);
    }
    console.log('\nPhase 2 done:', all.length, 'still failed:', sf.length);
  }

  all.sort((a, b) => parseInt(b.id) - parseInt(a.id));
  const dir = path.join(__dirname, '..', 'src', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'balecxi-arts.json'), JSON.stringify(all, null, 2));
  console.log('\nSaved', all.length, 'posts to balecxi-arts.json');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
