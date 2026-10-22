import requests, json, re, time, sys, os

SAVE_PATH = '/home/z/my-project/anime-fix/src/data/balecxi-arts.json'

def parse_page(html):
    posts = []
    rx = re.compile(r'<span id="s(\d+)" class="thumb"[^>]*>\s*<a id="p(\d+)" href="([^"]+)">[\s\S]*?<img[^>]*src="([^"]+)"[^>]*title="([^"]+)"')
    for m in rx.finditer(html):
        pid, href, thumb, title = m.group(2), m.group(3), m.group(4), m.group(5)
        tags = []
        score = 0
        for p in title.strip().split():
            if p.startswith('score:'): score = int(p.replace('score:', ''))
            elif p.startswith('rating:'): pass
            elif p and not p.startswith('(') and not p.startswith(')'):
                n = p.replace('_', ' ')
                if n.lower() not in [t.lower() for t in tags]:
                    tags.append(n)
        ch = [t for t in tags if '(' in t]
        sl = ', '.join([c.split('(')[0].strip() for c in ch[:2]]) if ch else ', '.join(tags[:3])
        a = tags[0] if tags[0].lower() == 'balecxi' else next((t for t in tags if '(' not in t and t not in ('1girl', '1boy') and not t.startswith('ai ')), 'Unknown')
        chars = [c.split('(')[0].strip() for c in ch if 'fate' not in c and 'series' not in c]
        posts.append({'id': pid, 'thumbnailUrl': thumb, 'tags': tags, 'artist': a, 'characters': chars, 'score': score, 'title': sl, 'postUrl': 'https://rule34.xxx' + href.replace('&amp;', '&')})
    return posts

def scrape():
    S = requests.Session()
    S.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'identity',
        'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1', 'Cache-Control': 'max-age=0',
    })
    existing = {}
    if os.path.exists(SAVE_PATH):
        with open(SAVE_PATH) as f:
            for p in json.load(f):
                existing[p['id']] = p
        print(f'Loaded {len(existing)} existing posts')
    r = S.get('https://rule34.xxx/index.php?page=post&s=list&tags=balecxi&pid=0', timeout=15)
    html = r.text
    m = re.search(r'alt="last page"[^>]*href="[^"]*pid=(\d+)"', html)
    tp = int(m.group(1)) // 42 + 1 if m else 724
    print(f'Total pages: {tp}')
    all_posts = list(existing.values())
    seen = set(existing.keys())
    failed = []
    def save():
        with open(SAVE_PATH, 'w') as f:
            json.dump(all_posts, f, ensure_ascii=False, indent=2)
        print(f'Saved {len(all_posts)} posts')
    import atexit
    atexit.register(save)
    for page in range(tp):
        pid = page * 42
        url = f'https://rule34.xxx/index.php?page=post&s=list&tags=balecxi&pid={pid}'
        ok = False
        for attempt in range(4):
            try:
                r = S.get(url, timeout=20)
                if r.status_code != 200:
                    time.sleep(2 * (attempt + 1))
                    continue
                html = r.text
                if len(html) < 10000 and 'Just a moment' in html:
                    print(f'  [{page+1}] CF block')
                    time.sleep(3 * (attempt + 1))
                    continue
                posts = parse_page(html)
                for p in posts:
                    if p['id'] not in seen:
                        seen.add(p['id'])
                        all_posts.append(p)
                ok = True
                break
            except Exception as e:
                print(f'  [{page+1}] {str(e)[:60]}')
                time.sleep(2 * (attempt + 1))
        if not ok:
            failed.append(page)
        sys.stdout.write(f'\r{page+1}/{tp} | {len(all_posts)} posts | {len(failed)} failed   ')
        sys.stdout.flush()
        time.sleep(1.0)
        if page > 0 and page % 50 == 0:
            save()
    print(f'\nPhase 1: {len(all_posts)} posts, {len(failed)} failed')
    if failed:
        print(f'\nRetrying {len(failed)} pages...')
        for page in failed:
            for attempt in range(3):
                try:
                    r = S.get(f'https://rule34.xxx/index.php?page=post&s=list&tags=balecxi&pid={page * 42}', timeout=20)
                    if r.status_code != 200:
                        time.sleep(3 * (attempt + 1))
                        continue
                    html = r.text
                    if len(html) < 10000 and 'Just a moment' in html:
                        time.sleep(4 * (attempt + 1))
                        continue
                    posts = parse_page(html)
                    for p in posts:
                        if p['id'] not in seen:
                        seen.add(p['id'])
                        all_posts.append(p)
                    break
                except:
                    time.sleep(3 * (attempt + 1))
            time.sleep(2.5)
    print(f'\nTotal: {len(all_posts)} posts')
    all_posts.sort(key=lambda x: int(x['id']), reverse=True)
    save()

if __name__ == '__main__':
    scrape()