-- Таблица статуса синхронизаций (админ-страница «last sync»).
-- Выполнить в Supabase SQL Editor (один раз).
--
-- Каждый sync-роут (vost / hentaibaza / games) пишет сюда результат
-- последнего запуска через service_role (RLS-политик нет — прямой
-- доступ из браузера невозможен, чтение только через серверный
-- эндпоинт /api/admin/sync-status с проверкой роли admin).

CREATE TABLE IF NOT EXISTS sync_status (
  source TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_status TEXT NOT NULL DEFAULT 'ok',
  new_items INTEGER DEFAULT 0,
  updated_items INTEGER DEFAULT 0,
  details JSONB DEFAULT '{}'::jsonb,
  error TEXT
);

ALTER TABLE sync_status ENABLE ROW LEVEL SECURITY;

-- Политик НЕТ: service_role (сервер) обходит RLS, анонимные запросы
-- из браузера получают пустой результат — по дизайну.
