import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/with-rate-limit';
import { checkAdultAccess } from '@/lib/adult-access';
import { authFromRequest } from '@/lib/db';

/**
 * GET /api/llm-check — диагностика живого ИИ (только для админа, 18+).
 *
 * Возвращает: настроены ли env-переменные, статус тестового запроса к
 * провайдеру и (при 200) список доступных моделей. Используется при
 * подключении/смене LLM-провайдера, чтобы не гадать с именами моделей.
 */
async function llmCheckHandler(_req: NextRequest) {
  const access = await checkAdultAccess(_req, '/api/llm-check');
  if (!access.ok) return access.response;

  const user = await authFromRequest(_req);
  if (user?.role !== 'admin') {
    return NextResponse.json({ error: 'Только админ' }, { status: 403 });
  }

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ configured: false, note: 'LLM_API_KEY не задана — работает встроенный движок' });
  }
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';

  const out: Record<string, unknown> = { configured: true, baseUrl, model };

  // 1) Список моделей провайдера
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    out.modelsStatus = r.status;
    if (r.ok) {
      const d = await r.json();
      const ids: string[] = (d?.data || []).map((m: { id: string }) => m.id).filter(Boolean);
      out.models = ids.slice(0, 60);
      out.currentModelExists = ids.includes(model);
    } else {
      out.modelsError = (await r.text()).slice(0, 300);
    }
  } catch (e) {
    out.modelsError = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }

  // 2) Пробный запрос с текущей моделью
  const c2 = new AbortController();
  const t2 = setTimeout(() => c2.abort(), 12000);
  try {
    const r2 = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Ответь одним словом: пинг' }],
        max_tokens: 64, // gpt-oss тратит часть лимита на рассуждения — 10 мало
        ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
      }),
      signal: c2.signal,
    });
    out.completionStatus = r2.status;
    const txt = await r2.text();
    if (r2.ok) {
      const d2 = JSON.parse(txt) as { choices?: Array<{ message?: { content?: string } }> };
      out.completionReply = d2?.choices?.[0]?.message?.content || '';
    } else {
      out.completionError = txt.slice(0, 400);
    }
  } catch (e) {
    out.completionError = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(t2);
  }

  return NextResponse.json(out);
}

export const GET = withRateLimit(llmCheckHandler, '/api/chat');
