-- Rate limit table for Supabase
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.rate_limits (
  id BIGSERIAL PRIMARY KEY,
  bucket_key TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  EXCLUDE CONSTRAINT rate_limits_bucket_key_ip UNIQUE (bucket_key, ip)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_bucket ON public.rate_limits (bucket_key, created_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_created ON public.rate_limits (created_at);

-- Auto-cleanup old entries (run as scheduled task/cron)
CREATE OR REPLACE FUNCTION public.cleanup_rate_limits()
RETURNS void AS $$
  DELETE FROM public.rate_limits WHERE created_at < NOW() - INTERVAL '1 minute';
$$ LANGUAGE plpgsql SECURITY DEFINER SET SEARCH_PATH = public;

-- Function to check rate limit (returns true if allowed)
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_bucket TEXT,
  p_ip TEXT,
  p_max INTEGER DEFAULT 60,
  p_window_ms INTEGER DEFAULT 60000
) RETURNS BOOLEAN AS $$
  DELETE FROM public.rate_limits
  WHERE bucket_key = p_bucket
    AND ip = p_ip
    AND created_at > NOW() - (p_window_ms || 60000) / 1000;
  INSERT INTO public.rate_limits (bucket_key, ip, created_at)
  VALUES (p_bucket, p_ip, NOW());
  SELECT NOT EXISTS (
    SELECT 1 FROM public.rate_limits
    WHERE bucket_key = p_bucket
      AND ip = p_ip
      AND created_at > NOW() - (p_window_ms || 60000) / 1000
  );
$$ LANGUAGE plpgsql SECURITY DEFINER SET SEARCH_PATH = public;
