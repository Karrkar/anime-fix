import { createClient } from '@supabase/supabase-js';

const db = createClient(
  'https://uymeyfnuxfbkwisggzdt.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function main() {
  // Try creating table via rpc if available, otherwise just try inserting
  // Most Supabase setups don't allow raw SQL from client, so we'll try
  console.log('Testing games_catalog table...');
  
  const { error } = await db.from('games_catalog').select('id').limit(1);
  if (error && error.message.includes('does not exist')) {
    console.log('Table does not exist. Creating via SQL...');
    // We need to use the Supabase dashboard SQL editor for DDL
    // For now, let's try the REST API approach with a direct fetch
    const url = 'https://uymeyfnuxfbkwisggzdt.supabase.co/rest/v1/rpc/exec_sql';
    // This won't work without the rpc function, so let's inform user
    console.log('Need to create table via Supabase dashboard SQL editor.');
    console.log('SQL:');
    console.log(`
CREATE TABLE IF NOT EXISTS games_catalog (
  id BIGSERIAL PRIMARY KEY,
  external_id TEXT UNIQUE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  source TEXT DEFAULT '',
  rating NUMERIC DEFAULT 0,
  views INTEGER DEFAULT 0,
  tags TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_games_source ON games_catalog(source);
CREATE INDEX IF NOT EXISTS idx_games_created ON games_catalog(created_at);
    `);
  } else if (error) {
    console.log('Error:', error.message);
  } else {
    console.log('Table exists!');
  }
}

main().catch(console.error);