-- ═══════════════════════════════════════════════════════════════════════
-- Rate limiting на Supabase (патчи F-10 + F-11, батч 3)
--
-- ЗАПУСТИТЬ В Supabase SQL Editor (Dashboard → SQL → New query → вставить → Run).
--
-- ВАЖНО: в проекте уже был файл scripts/create-rate-limit-table.sql, но его
-- функция check_rate_limit содержала ошибки ((p_window_ms || 60000)/1000 —
-- склейка текста вместо деления, плюс EXCLUDE-ограничение UNIQUE(bucket, ip)
-- не позволяло хранить несколько запросов одного клиента). Этот скрипт
-- пересоздаёт таблицу и функцию в корректном виде.
--
-- Пока этот скрипт НЕ выполнен, приложение работает в fallback-режиме
-- (in-memory лимиты) и никоим образом не ломается. После выполнения —
-- лимиты станут общими для всех инстансов серверлесс-функций.
-- ═══════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS public.rate_limits;

CREATE TABLE public.rate_limits (
  id BIGSERIAL PRIMARY KEY,
  bucket_key TEXT NOT NULL,          -- маршрут, напр. '/api/subscription'
  ip TEXT NOT NULL,                  -- адрес клиента (getClientIp)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup
  ON public.rate_limits (bucket_key, ip, created_at);

CREATE INDEX IF NOT EXISTS idx_rate_limits_created
  ON public.rate_limits (created_at);

-- Атомарная проверка лимита: удаляем вышедшие из окна записи, считаем
-- оставшиеся, если меньше p_max — добавляем новую и разрешаем запрос.
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_bucket TEXT,
  p_ip TEXT,
  p_max INTEGER DEFAULT 60,
  p_window_ms INTEGER DEFAULT 60000
) RETURNS BOOLEAN AS $$
DECLARE
  v_cutoff TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  v_cutoff := NOW() - make_interval(secs => GREATEST(p_window_ms, 1000) / 1000.0);

  DELETE FROM public.rate_limits
  WHERE bucket_key = p_bucket
    AND ip = p_ip
    AND created_at < v_cutoff;

  SELECT COUNT(*) INTO v_count
  FROM public.rate_limits
  WHERE bucket_key = p_bucket
    AND ip = p_ip
    AND created_at >= v_cutoff;

  IF v_count >= p_max THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.rate_limits (bucket_key, ip) VALUES (p_bucket, p_ip);
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET SEARCH_PATH = public;

-- Служебная очистка (опционально можно вызывать вручную или из cron-pg_cron)
CREATE OR REPLACE FUNCTION public.cleanup_rate_limits()
RETURNS void AS $$
  DELETE FROM public.rate_limits WHERE created_at < NOW() - INTERVAL '1 hour';
$$ LANGUAGE plpgsql SECURITY DEFINER SET SEARCH_PATH = public;

-- Таблица используется только service-role ключом из серверных функций,
-- RLS для анонов оставляем закрытым по умолчанию (RLS не включён = доступ
-- только через service key / владельцев, anon-ключ таблицу не увидит).
