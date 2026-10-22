-- ═══════════════════════════════════════════════════════════════════════════
-- anime-fix — БЕЗОПАСНАЯ СХЕМА ДОСТУПА SUPABASE (v3)
-- Замена supabase-anime-table.sql. Выполнить ОДИН раз в Supabase SQL Editor:
-- Dashboard → SQL Editor → New query → вставить целиком → Run.
--
-- ЧТО БЫЛО НЕ ТАК В СТАРОЙ ВЕРСИИ:
--   1. Политики «Service role can insert/update/delete» имели тела
--      WITH CHECK (true) / USING (true) БЕЗ ограничения роли (TO service_role),
--      то есть разрешали запись ЛЮБОЙ роли, включая анонимную (anon-ключ
--      в модели Supabase считается публичным). Имена обещали одно,
--      тела делали другое.
--   2. Скрипт не был идемпотентным: CREATE POLICY без DROP IF EXISTS
--      падал при повторном запуске на середине.
--   3. Таблицы users / sessions / subscriptions / payments / favorites /
--      history / rate_limits создавались вообще без RLS — в Supabase это
--      означает полный доступ anon-ключа (grants по умолчанию дают ALL).
--
-- МОДЕЛЬ ДОСТУПА ПОСЛЕ ЭТОГО СКРИПТА (два эшелона: RLS + GRANT):
--   * anon / authenticated → ТОЛЬКО чтение каталога anime_catalog (SELECT).
--   * users / sessions / subscriptions / payments / favorites / history /
--     rate_limits / sync_status → для anon закрыты полностью.
--   * Приложение работает через серверные роуты с service-ключом и
--     НЕ МЕНЯЕТ ПОВЕДЕНИЯ: service_role обходит RLS (доказано продом:
--     кроны ежедневно пишут в sync_status, где RLS включён и политик нет),
--     плюс на всякий случай созданы явные политики TO service_role.
--   * RPC check_rate_limit / cleanup_rate_limits → EXECUTE только у service_role.
--   * Будущие таблицы, созданные postgres в public → anon больше не
--     получает автоматических прав (secure by default).
--
-- ПОВТОРНЫЙ ЗАПУСК БЕЗОПАСЕН (идемпотентен). Перезапуск приложения не нужен.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Таблица каталога (полная схема — на случай чистой БД) ──────────────
CREATE TABLE IF NOT EXISTS public.anime_catalog (
  id BIGSERIAL PRIMARY KEY,
  vost_id INTEGER UNIQUE NOT NULL,
  title TEXT NOT NULL,
  title_russian TEXT,
  title_japanese TEXT,
  description TEXT DEFAULT '',
  image_url TEXT NOT NULL,
  type TEXT DEFAULT 'ТВ',
  episodes INTEGER DEFAULT 0,
  genres TEXT DEFAULT '',
  status TEXT DEFAULT '',
  score REAL DEFAULT 0,
  views INTEGER DEFAULT 0,
  year INTEGER DEFAULT 2025,
  source_url TEXT NOT NULL,
  embed_url TEXT DEFAULT '',
  is_adult BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anime_catalog_vost_id  ON public.anime_catalog(vost_id);
CREATE INDEX IF NOT EXISTS idx_anime_catalog_is_adult ON public.anime_catalog(is_adult);
CREATE INDEX IF NOT EXISTS idx_anime_catalog_year    ON public.anime_catalog(year);
CREATE INDEX IF NOT EXISTS idx_anime_catalog_score   ON public.anime_catalog(score DESC);
CREATE INDEX IF NOT EXISTS idx_anime_catalog_created ON public.anime_catalog(created_at DESC);

-- ── 2. RLS включён на ВСЕХ таблицах проекта ───────────────────────────────
ALTER TABLE public.anime_catalog  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favorites      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.history        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_status    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits    ENABLE ROW LEVEL SECURITY;

-- FORCE: даже владелец таблицы (не суперпользователь) не пройдёт мимо RLS.
-- Суперпользователь postgres и роль service_role (BYPASSRLS) не затронуты.
ALTER TABLE public.users         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sessions      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payments      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.favorites     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.history       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sync_status   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits   FORCE ROW LEVEL SECURITY;

-- ── 3. Снос ВСЕХ старых политик на таблицах проекта ───────────────────────
--    Попадают и «Anyone can read anime», и опасные «Service role can
--    insert/update/delete» (тела USING(true) действовали для всех ролей).
DO $drop$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('anime_catalog','users','sessions','subscriptions',
                        'payments','favorites','history','sync_status',
                        'rate_limits')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   r.policyname, r.schemaname, r.tablename);
    RAISE NOTICE 'Удалена политика %.%', r.tablename, r.policyname;
  END LOOP;
END
$drop$;

-- ── 4. Политики каталога ──────────────────────────────────────────────────
-- 4а. Публичное ЧТЕНИЕ (аноним может листать каталог — это публичный контент).
DROP POLICY IF EXISTS "Public read anime_catalog" ON public.anime_catalog;
CREATE POLICY "Public read anime_catalog"
  ON public.anime_catalog
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- 4б. Явный полный доступ service_role (страховка для окружений без
--     BYPASSRLS; в Supabase service_role и так обходит RLS).
DROP POLICY IF EXISTS "service_role full access" ON public.anime_catalog;
CREATE POLICY "service_role full access"
  ON public.anime_catalog
  FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- Политик записи для anon/authenticated НЕТ — и не нужно: парсеры и
-- синхроны работают под service_role.

-- ── 5. Пользовательские и служебные таблицы: политики только для service ──
DROP POLICY IF EXISTS "service_role full access" ON public.users;
CREATE POLICY "service_role full access" ON public.users
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role full access" ON public.sessions;
CREATE POLICY "service_role full access" ON public.sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role full access" ON public.subscriptions;
CREATE POLICY "service_role full access" ON public.subscriptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role full access" ON public.payments;
CREATE POLICY "service_role full access" ON public.payments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role full access" ON public.favorites;
CREATE POLICY "service_role full access" ON public.favorites
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role full access" ON public.history;
CREATE POLICY "service_role full access" ON public.history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role full access" ON public.sync_status;
CREATE POLICY "service_role full access" ON public.sync_status
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role full access" ON public.rate_limits;
CREATE POLICY "service_role full access" ON public.rate_limits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 6. Привилегии GRANT (эшелон №2, независимый от RLS) ──────────────────
-- 6а. Каталог: у anon остаётся только SELECT.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.anime_catalog FROM anon, authenticated;

-- 6б. Пользовательские и служебные таблицы: у anon — НИЧЕГО.
REVOKE ALL PRIVILEGES
  ON public.users, public.sessions, public.subscriptions, public.payments,
     public.favorites, public.history, public.sync_status, public.rate_limits
  FROM anon, authenticated;

-- ── 7. RPC-функции: EXECUTE только у service_role ────────────────────────
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_rate_limits() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, INTEGER, INTEGER) TO service_role;
GRANT  EXECUTE ON FUNCTION public.cleanup_rate_limits() TO service_role;

-- ── 8. Будущие таблицы: secure by default ────────────────────────────────
--  В Supabase новые таблицы, созданные ролью postgres в SQL-редакторе,
--  автоматически получают ALL-права для anon. Отключаем это для public.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon;
--  service_role сохраняет полный доступ и к будущим таблицам:
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;

-- ── 9. Контрольная печать итогового состояния ────────────────────────────
--  Ожидаемо: anime_catalog — rls=t, anon_select=t, anon_insert=f, anon_delete=f;
--  все остальные — rls=t, force=t, все anon_* = f.
--  v3: FORCE-статус берём из pg_class — в представлении pg_tables колонки
--  forcerowsecurity нет (из-за неё v2 падал здесь с ошибкой 42703).
SELECT c.relname AS tablename,
       c.relrowsecurity      AS rls,
       c.relforcerowsecurity AS force_rls,
       has_table_privilege('anon', 'public.' || c.relname, 'SELECT') AS anon_select,
       has_table_privilege('anon', 'public.' || c.relname, 'INSERT') AS anon_insert,
       has_table_privilege('anon', 'public.' || c.relname, 'DELETE') AS anon_delete
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
ORDER BY c.relname;

SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
