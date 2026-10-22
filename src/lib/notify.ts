/**
 * Telegram-уведомления о результатах кронов (мониторинг парсеров).
 *
 * Конфигурируется двумя env-переменными (задаются в Vercel Dashboard):
 *   TELEGRAM_BOT_TOKEN — токен бота (@BotFather)
 *   TELEGRAM_CHAT_ID   — ID чата (личка/группа; узнать через @userinfobot)
 *
 * Если переменные не заданы — функция тихо но-опится: кроны продолжают
 * работать, просто без уведомлений. Отправка с таймаутом 8с, ошибки
 * не поднимаются наверх (упавшая отправка не должна валить синк).
 */

export async function notifyTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 3500),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Экранирование для HTML-parse mode */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
