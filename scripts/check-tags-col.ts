import { createClient } from '@supabase/supabase-js';

const db = createClient(
  'https://uymeyfnuxfbkwisggzdt.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function main() {
  // Test if tags column exists by trying to select it
  const { data, error } = await db.from('anime_catalog').select('id,tags').limit(1);
  if (error) {
    console.log('Error selecting tags:', error.message);
    // Try inserting a test row without tags to see what columns exist
    const { error: e2 } = await db.from('anime_catalog').select('*').limit(1);
    console.log('Select * error:', e2?.message);
  } else {
    console.log('tags column exists! Data:', data);
  }
  
  // Also check what type values exist
  const { data: types } = await db.from('anime_catalog').select('type').limit(5);
  console.log('Sample types:', types);
}

main().catch(console.error);