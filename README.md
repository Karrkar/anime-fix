# anime-fix

Каталог аниме и 18+ контента на Next.js 16 (App Router) + Supabase + Vercel.
Подписка через ЮMoney, серверный гейт 18+, ежедневная синхронизация каталога.

## Стек

| Слой | Технология |
|---|---|
| Фреймворк | Next.js 16 (App Router, TypeScript, React 19) |
| Стили | Tailwind CSS 4 + tw-animate-css |
| БД | Supabase (PostgREST, service-ключ на сервере) |
| Платежи | ЮMoney quickpay + вебхук `p2p-incoming` |
| Хостинг | Vercel (Hobby), Node 24.x |
| Тесты | node:test (`npm test`) |

## Структура

```
src/app/               — маршруты App Router (страницы + api/роуты)
  api/subscription/    — регистрация/логин/подписка/confirm-payment
  api/yoomoney-notify/ — вебхук ЮMoney (активация подписки)
  api/sync-*/          — синхронизация каталога (кроны, см. vercel.json)
src/components/        — UI (pages/, cards/, adult/, layout/, shelves/)
src/lib/               — db.ts (Supabase-клиент, service-ключ), sources.ts
                        (реестр внешних хостов), adult-access.ts (гейт 18+)…
scripts/               — утилиты парсинга/диагностики (ключи читают из env!)
tests/                 — юнит-тесты (node:test)
supabase-anime-table.sql — БЕЗОПАСНАЯ схема БД (см. ниже)
vercel.json            — cron-расписание синхронизаций
```

## Переменные окружения

См. `.env.example`. Реальные значения — в Supabase Dashboard → Project
Settings → API и в кошельке ЮMoney. В Vercel они уже настроены
(Settings → Environment Variables); локально скопируйте `.env.example`
в `.env` и заполните.

**Важно:** `SUPABASE_SERVICE_ROLE_KEY` — полный доступ к БД в обход RLS.
Никогда не коммитить, не вставлять в scripts/ и не отправлять на клиент.

## Безопасность БД (RLS)

`supabase-anime-table.sql` — канонический, **идемпотентный** скрипт схемы
доступа. Модель:

- `anon` / `authenticated` → только `SELECT` на `anime_catalog`;
- `users`, `sessions`, `subscriptions`, `payments`, `favorites`,
  `history`, `rate_limits`, `sync_status` → для анонимов закрыты
  на двух уровнях (RLS без политик + `REVOKE`);
- `service_role` (серверные роуты приложения) — полный доступ, RLS
  не препятствует;
- RPC `check_rate_limit` / `cleanup_rate_limits` — `EXECUTE` только
  у `service_role`;
- будущие таблицы в `public` больше не получают авто-прав для `anon`.

Повторный запуск скрипта безопасен: он пересоздаёт политики через
`DROP POLICY IF EXISTS` и не открывает запись анонимам. Проверка текущего
состояния — финальные `SELECT` из `pg_tables`/`pg_policies` в конце скрипта.

## Локальная разработка

```bash
npm install
cp .env.example .env   # заполнить значения
npm run dev            # http://localhost:3000
```

Проверки (то же, что в CI):

```bash
npm run typecheck      # tsc --noEmit
npm test               # юнит-тесты
npm run build          # контрольная сборка
```

## CI/CD

`.github/workflows/ci.yml` — единый конвейер:

1. **job `ci`** (все push/PR): typecheck → тесты → `npm audit`
   (high+ по прод-зависимостям) → контрольная сборка.
2. **job `deploy`** (только push в `main`): `vercel pull` (тянет env из
   проекта Vercel — секреты не хранятся в репозитории) →
   `vercel build --prod` → `vercel deploy --prebuilt --prod`.

Для работы деплоя нужен один секрет репозитория:
**GitHub → Settings → Secrets and variables → Actions → `VERCEL_TOKEN`**
(создать: https://vercel.com/account/tokens, Scope — команда
`tsymaiwan-4591s-projects`, срок — по желанию).

Альтернатива: подключить репозиторий через Vercel Dashboard
(Project → Settings → Git → Connect Git Repository) — тогда Vercel
деплоит сам на каждый push, а workflow останется барьером качества.

## Деплой вручную (если нужно)

```bash
npm i -g vercel
vercel login
vercel link            # выбрать anime-fix в команде tsymaiwan-4591s-projects
vercel build --prod
vercel deploy --prebuilt --prod
```

## Кроны (vercel.json)

| Расписание | Роут | Назначение |
|---|---|---|
| 06:00 UTC | `/api/sync-anime?pages=2&ongoing=2&refresh=15` | каталог vost.pw |
| 06:00 UTC | `/api/sync-hentai?pages=1` | хентай-раздел |
| 06:30 UTC | `/api/sync-games` | игры 18+ |

## Известные особенности

- Ротация сервисного ключа: старое значение ранее хранилось в `scripts/`
  открытым текстом (вычищено в этом коммите). Рекомендуется сменить ключ
  в Supabase Dashboard → Settings → API → Rotate service_role key и
  обновить `SUPABASE_SERVICE_ROLE_KEY` в Vercel.
- Смена пароля администратора: логин/пароль админа также были захардкожены
  в диагностических скриптах (вычищено в `process.env.ADMIN_EMAIL` /
  `ADMIN_PASSWORD`). Рекомендуется сменить пароль админ-аккаунта через
  форму входа на сайте.
- Диагностические скрипты (`scripts/*.mjs`) перед запуском читают
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` из env.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` задан в env, но кодом не используется
  (клиент полностью опосредуется серверными роутами).
  CI test 18.09
