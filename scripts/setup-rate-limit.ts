import { createClient } from '@supabase/supabase-js';

const db = createClient(
  'https://uymeyfnuxfbkwisggzdt.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function main() {
  console.log('Creating rate_limits table...');

  // Create table
  const { error: e1 } = await db.rpc('exec_sql', { sql: `
    CREATE TABLE IF NOT EXISTS public.rate_limits (
      id BIGSERIAL PRIMARY KEY,
      bucket_key TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rl_bucket ON public.rate_limits(bucket_key, ip);
    CREATE INDEX IF NOT EXISTS idx_rl_created ON public.rate_limits(created_at);
  ` });
  if (e1) console.error('Create error:', e1.message);
  else console.log('Table created');

  // Create check function
  const { error: e2 } = await db.rpc('exec_sql', { sql: `
    CREATE OR REPLACE FUNCTION public.check_rate_limit(
      p_bucket TEXT,
      p_ip TEXT,
      p_max INTEGER DEFAULT 60,
      p_window_ms INTEGER DEFAULT 60000
    ) RETURNS BOOLEAN AS \$\n      DELETE FROM public.rate_limits
      WHERE bucket_key = p_bucket AND ip = p_ip
        AND created_at > NOW() - (p_window_ms || 60000) / 1000;
      INSERT INTO public.rate_limits (bucket_key, ip, created_at)
      VALUES (p_bucket, p_ip, NOW());
      SELECT NOT EXISTS (
        SELECT 1 FROM public.rate_limits
        WHERE bucket_key = p_bucket AND ip = p_ip
          AND created_at > NOW() - (p_window_ms || 60000) / 1000
      );
    \$ LANGUAGE plpgsql SECURITY DEFINER SET SEARCH_PATH = public;
  ` });
  if (e2) console.error('Function error:', e2.message);
  else console.log('Function created');

  // Create cleanup function
  const { error: e3 } = await db.rpc('exec_sql', { sql: `
    CREATE OR REPLACE FUNCTION public.cleanup_rate_limits()
    RETURNS VOID AS \$\n      DELETE FROM public.rate_limits WHERE created_at < NOW() - INTERVAL '1 minute';
    \$ LANGUAGE plpgsql SECURITY DEFINER SET SEARCH_PATH = public;
  ` });
  if (e3) console.error('Cleanup error:', e3.message);
  else console.log('Cleanup function created');
}

main().catch(console.error);
