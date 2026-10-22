-- ═══════════════════════════════════════════════════════════════════════════
-- AP-БАЛАНС + ПРОМО-КОДЫ — миграция для Supabase SQL Editor (один запуск).
-- Платформа: animeplatforma-new.online | 1 AP = 1 ₽ | 29.09.2026
--
-- ЧТО СОЗДАЁТСЯ:
--   user_balance          — текущий баланс AP на юзера
--   balance_transactions  — журнал операций (append-only ledger)
--   promo_codes           — промо-коды AP-XXXXX-XXXXX
--   promo_redemptions     — кто какой код активировал (UNIQUE code+user)
--   RPC ap_credit / ap_debit / ap_redeem — атомарные операции (SECURITY DEFINER)
--
-- БЕЗОПАСНОСТЬ:
--   • RLS ENABLE на всех таблицах БЕЗ политик → anon/authenticated не читают
--     и не пишут; платформа ходит через service_role (RLS не применяется).
--   • REVOKE EXECUTE на RPC от anon/authenticated → юзер НЕ может начислить
--     себе баланс напрямую через PostgREST.
--   • Заодно закрыты старые RPC check_rate_limit / cleanup_rate_limits
--     (раньше были доступны anon — байпас рейт-лимита).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Таблицы ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_balance (
  user_id     UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  balance_ap  INTEGER NOT NULL DEFAULT 0 CHECK (balance_ap >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.balance_transactions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('topup', 'redeem', 'spend', 'admin')),
  amount_ap     INTEGER NOT NULL,          -- положительное = поступление, отрицательное = списание
  balance_after INTEGER NOT NULL,          -- баланс сразу после операции (для истории/аудита)
  meta          JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_baltr_user ON public.balance_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.promo_codes (
  code       TEXT PRIMARY KEY,              -- AP + 10 символов Crockford base32
  amount_ap  INTEGER NOT NULL CHECK (amount_ap > 0),
  max_uses   INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_promo_created ON public.promo_codes(created_at DESC);

CREATE TABLE IF NOT EXISTS public.promo_redemptions (
  id         BIGSERIAL PRIMARY KEY,
  code       TEXT NOT NULL REFERENCES public.promo_codes(code),
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (code, user_id)                    -- один код = один redeem на юзера
);
CREATE INDEX IF NOT EXISTS idx_promored_user ON public.promo_redemptions(user_id);

-- ─── 2. Атомарные RPC ──────────────────────────────────────────────────────

-- Начислить AP: upsert баланса + строка журнала. Возвращает новый баланс.
CREATE OR REPLACE FUNCTION public.ap_credit(
  p_user UUID, p_amount INTEGER, p_kind TEXT, p_meta JSONB DEFAULT '{}'::jsonb
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_new INTEGER;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'ap_credit: amount must be positive';
  END IF;
  INSERT INTO user_balance (user_id, balance_ap) VALUES (p_user, p_amount)
  ON CONFLICT (user_id) DO UPDATE
    SET balance_ap = user_balance.balance_ap + p_amount, updated_at = NOW()
  RETURNING balance_ap INTO v_new;
  INSERT INTO balance_transactions (user_id, kind, amount_ap, balance_after, meta)
  VALUES (p_user, p_kind, p_amount, v_new, COALESCE(p_meta, '{}'::jsonb));
  RETURN v_new;
END $$;

-- Списать AP: атомарно (WHERE balance >= amount). NULL = недостаточно средств.
CREATE OR REPLACE FUNCTION public.ap_debit(
  p_user UUID, p_amount INTEGER, p_kind TEXT, p_meta JSONB DEFAULT '{}'::jsonb
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_new INTEGER;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'ap_debit: amount must be positive';
  END IF;
  UPDATE user_balance SET balance_ap = balance_ap - p_amount, updated_at = NOW()
  WHERE user_id = p_user AND balance_ap >= p_amount
  RETURNING balance_ap INTO v_new;
  IF v_new IS NULL THEN RETURN NULL; END IF;
  INSERT INTO balance_transactions (user_id, kind, amount_ap, balance_after, meta)
  VALUES (p_user, p_kind, -p_amount, v_new, COALESCE(p_meta, '{}'::jsonb));
  RETURN v_new;
END $$;

-- Активировать промо-код (одна транзакция: проверка + redeem + зачисление).
-- Возврат: >0 = начислено AP; -1 = код не найден/истёк/исчерпан/погашен; -2 = уже активировал.
CREATE OR REPLACE FUNCTION public.ap_redeem(p_code TEXT, p_user UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code TEXT := UPPER(TRIM(p_code));
  v_amount INTEGER;
  v_new INTEGER;
BEGIN
  SELECT amount_ap INTO v_amount FROM promo_codes
  WHERE code = v_code
    AND is_active
    AND (expires_at IS NULL OR expires_at > NOW())
    AND used_count < max_uses;

  IF v_amount IS NULL THEN
    RETURN -1;
  END IF;

  -- один код = один redeem на юзера
  BEGIN
    INSERT INTO promo_redemptions (code, user_id) VALUES (v_code, p_user);
  EXCEPTION WHEN unique_violation THEN
    RETURN -2;
  END;

  UPDATE promo_codes SET used_count = used_count + 1 WHERE code = v_code;

  INSERT INTO user_balance (user_id, balance_ap) VALUES (p_user, v_amount)
  ON CONFLICT (user_id) DO UPDATE
    SET balance_ap = user_balance.balance_ap + v_amount, updated_at = NOW()
  RETURNING balance_ap INTO v_new;

  INSERT INTO balance_transactions (user_id, kind, amount_ap, balance_after, meta)
  VALUES (p_user, 'redeem', v_amount, v_new, jsonb_build_object('code', v_code));

  RETURN v_amount;
END $$;

-- ─── 3. Закрыть доступ извне ──────────────────────────────────────────────

-- RLS: таблицы видны только service_role (обходит RLS)
ALTER TABLE public.user_balance         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_codes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_redemptions    ENABLE ROW LEVEL SECURITY;

-- RPC: только service_role/postgres могут вызывать (не anon!)
REVOKE EXECUTE ON FUNCTION public.ap_credit(UUID, INTEGER, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ap_debit(UUID, INTEGER, TEXT, JSONB)  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ap_redeem(TEXT, UUID)                 FROM PUBLIC, anon, authenticated;

-- Гигиена: старые RPC тоже закрываем от anon (были открыты — байпас рейт-лимита)
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_rate_limits()                          FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ap_credit(UUID, INTEGER, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.ap_debit(UUID, INTEGER, TEXT, JSONB)  TO service_role;
GRANT EXECUTE ON FUNCTION public.ap_redeem(TEXT, UUID)                 TO service_role;

-- ─── 4. Проверка (выполнится и покажет результат прямо в редакторе) ───────
SELECT 'AP-balance migration OK' AS status,
       (SELECT COUNT(*) FROM public.user_balance)         AS balances,
       (SELECT COUNT(*) FROM public.promo_codes)          AS promo_codes,
       (SELECT COUNT(*) FROM public.balance_transactions) AS txs;
