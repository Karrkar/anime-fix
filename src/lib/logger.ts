/**
 * Структурированное событийное логирование (батч 3: логирование).
 *
 * Каждое событие — одна JSON-строка в stdout/stderr. Vercel собирает их
 * в Runtime Logs (дашборд → проект → Logs), где их можно фильтровать по
 * полю `event`. Формат:
 *   {"t":"2026-09-03T19:00:00.000Z","lvl":"warn","event":"login_failed","email":"us***@mail.ru","ip":"1.2.3.4"}
 *
 * События безопасности: login_ok / login_failed / user_registered / logout /
 * rate_limited / cron_denied / ssrf_blocked / age_gate_denied /
 * webhook_invalid_hash / webhook_amount_mismatch / webhook_activated.
 */

export type LogLevel = 'info' | 'warn' | 'error';

/** Маскируем email: "username@domain.ru" -> "us*****@domain.ru" */
export function maskEmail(email: string | undefined | null): string {
  if (!email || typeof email !== 'string') return '—';
  const at = email.indexOf('@');
  if (at <= 0) return '—';
  const user = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = user.slice(0, Math.min(2, user.length));
  const masked = '*'.repeat(Math.max(1, Math.min(user.length - head.length, 8)));
  return `${head}${masked}@${domain}`;
}

export function logEvent(
  event: string,
  fields?: Record<string, unknown>,
  level: LogLevel = 'info',
): void {
  const entry = {
    t: new Date().toISOString(),
    lvl: level,
    event,
    ...(fields || {}),
  };
  let line: string;
  try {
    line = JSON.stringify(entry, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  } catch {
    line = JSON.stringify({ t: entry.t, lvl: level, event, note: 'unserializable fields' });
  }
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
