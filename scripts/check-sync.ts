import { createClient } from '@supabase/supabase-js';

const db = createClient(
  'https://uymeyfnuxfbkwisggzdt.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function main() {
  // 1. Check if table exists
  console.log('=== Checking anime_catalog table ===');
  const { data, error, count } = await db
    .from('anime_catalog')
    .select('*', { count: 'exact', head: true });
  
  if (error) {
    console.log('TABLE ERROR:', error.message);
    console.log('Table might not exist. Creating...');
    
    // Try to create the table
    const { error: createErr } = await db.rpc('exec_sql', {
      sql: `
        CREATE TABLE IF NOT EXISTS anime_catalog (
          id BIGSERIAL PRIMARY KEY,
          vost_id INTEGER UNIQUE,
          title TEXT,
          title_russian TEXT,
          description TEXT,
          image_url TEXT,
          type TEXT DEFAULT 'ТВ',
          episodes INTEGER DEFAULT 0,
          genres TEXT DEFAULT '',
          year INTEGER DEFAULT 2025,
          score NUMERIC DEFAULT 0,
          views INTEGER DEFAULT 0,
          source_url TEXT,
          embed_url TEXT,
          is_adult BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_anime_catalog_vost_id ON anime_catalog(vost_id);
        CREATE INDEX IF NOT EXISTS idx_anime_catalog_is_adult ON anime_catalog(is_adult);
        CREATE INDEX IF NOT EXISTS idx_anime_catalog_created_at ON anime_catalog(created_at);
      `
    });
    if (createErr) {
      console.log('Create via RPC failed:', createErr.message);
    }
  } else {
    console.log('Table exists! Count:', count);
    
    // Get some sample rows
    const { data: rows } = await db
      .from('anime_catalog')
      .select('id, vost_id, title, title_russian, is_adult, created_at')
      .order('created_at', { ascending: false })
      .limit(5);
    console.log('Recent rows:', JSON.stringify(rows, null, 2));
  }

  // 2. Test Jina reader with vost.pw
  console.log('\n=== Testing Jina reader ===');
  try {
    const r = await fetch('https://r.jina.ai/' + encodeURIComponent('https://v13.vost.pw'), {
      headers: { Accept: 'text/html', 'X-Return-Format': 'html', 'X-No-Cache': 'true' },
      signal: AbortSignal.timeout(30000),
    });
    const html = await r.text();
    console.log('Jina status:', r.status);
    console.log('HTML length:', html.length);
    console.log('First 3000 chars:');
    console.log(html.slice(0, 3000));
    
    // Check for shortstory pattern
    const cardMatches = html.match(/<div class="shortstory">/g);
    console.log('\nshortstory divs found:', cardMatches ? cardMatches.length : 0);
    
    // Check for h2 links
    const h2Matches = html.match(/<h2><a href="/g);
    console.log('h2 links found:', h2Matches ? h2Matches.length : 0);
    
    // Look for alternative patterns
    const articleMatches = html.match(/<article/g);
    console.log('article tags found:', articleMatches ? articleMatches.length : 0);
    
    const aMatches = html.match(/<a href="\/[\d]+-/g);
    console.log('anime links pattern /NNN-... found:', aMatches ? aMatches.length : 0);
    if (aMatches) {
      console.log('Sample links:', aMatches.slice(0, 5));
    }
  } catch (e: any) {
    console.error('Jina fetch error:', e.message);
  }
}

main().catch(console.error);
