/**
 * AP-баланс: внутренняя валюта платформы (1 AP = 1 ₽) + промо-коды.
 *
 * АРХИТЕКТУРА LEDGER (журнал):
 *   user_balance           — текущий баланс (денормализация для быстрого чтения)
 *   balance_transactions   — журнал операций (append-only): каждая операция —
 *                            строка с amount_ap (±) и balance_after. Баланс
 *                            можно восстановить суммой журнала; «потерять»
 *                            деньги багом невозможно — строку не удалить.
 *
 * АТОМАРНОСТЬ: все изменения идут через SQL-RPC ap_credit / ap_debit /
 * ap_redeem (SECURITY DEFINER, SECURITY: execute только у service_role —
 * см. scripts/create-balance-tables.sql). Гонки «двойное списание» исключены
 * на уровне СУБД: UPDATE ... WHERE balance_ap >= p_amount.
 *
 * КУРС: 1 AP = 1 ₽ (фиксированный). Тарифы: plans.ts (цена в ₽ = цена в AP).
 *
 * ПРОМО-КОДЫ: формат AP-XXXXX-XXXXX (Crockford base32, 10 символов ≈ 2^50 —
 * перебор невозможен). Админ генерирует пачку; код активируется юзером в
 * профиле → AP падают на баланс. Ограничения: max_uses, expires_at,
 * один redeem на юзера (UNIQUE(code, user_id)).
 */
import crypto from 'crypto';
import { getDb } from '@/lib/db';

// ─── Константы ───────────────────────────────────────────────────────────

export const AP_PER_RUB = 1;                 // курс: 1 AP = 1 ₽
export const TOPUP_MIN_AP = 50;              // минимум пополнения
export const TOPUP_MAX_AP = 10000;           // максимум пополнения
export const PROMO_CODE_PREFIX = 'AP';

/** Лимиты генерации промо-кодов для админа. */
export const PROMO_GEN_MAX_COUNT = 200;
export const PROMO_GEN_MAX_AMOUNT = 50000;
export const PROMO_GEN_MAX_USES = 1000;
export const PROMO_GEN_MAX_EXPIRY_DAYS = 365;

// ─── Валидация / нормализация ────────────────────────────────────────────

/** Сумма пополнения AP: целое в допустимом диапазоне или null. */
export function validateTopupAmount(input: unknown): number | null {
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < TOPUP_MIN_AP || n > TOPUP_MAX_AP) return null;
  return n;
}

/** Нормализация промо-кода: AP-XXXXX-XXXXX → верхний регистр, без пробелов. */
export function normalizePromoCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (!/^AP[0-9A-Z]{10}$/.test(code)) return null;
  return code;
}

/** Код в человекочитаемом виде: AP-XXXXX-XXXXX. */
export function formatPromoCode(code: string): string {
  const c = code.replace(/[\s-]/g, '').toUpperCase();
  return `${c.slice(0, 2)}-${c.slice(2, 7)}-${c.slice(7, 12)}`;
}

/**
 * Генерация криптостойкого кода AP-XXXXX-XXXXX.
 * Алфавит Crockford base32 (без I, L, O, U — чтобы не путались при вводе).
 */
export function generatePromoCode(): string {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = crypto.randomBytes(10);
  let body = '';
  for (let i = 0; i < 10; i++) body += ALPHABET[bytes[i] % ALPHABET.length];
  return `${PROMO_CODE_PREFIX}${body}`;
}

/** Парсинг label пополнения вида topup_<userId>_<ts> (uuid без подчёркиваний). */
export function parseTopupLabel(label: string): { userId: string } | null {
  const parts = label.split('_');
  if (parts.length !== 3 || parts[0] !== 'topup') return null;
  const userId = parts[1];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return null;
  return { userId };
}

// ─── Баланс: чтение ──────────────────────────────────────────────────────

export interface BalanceTx {
  id: number;
  kind: 'topup' | 'redeem' | 'spend' | 'admin';
  amountAp: number;      // ±
  balanceAfter: number;
  meta: Record<string, unknown>;
  createdAt: string;
}

export async function getBalance(userId: string): Promise<number> {
  const db = getDb();
  const { data } = await db.from('user_balance').select('balance_ap').eq('user_id', userId).maybeSingle();
  return data?.balance_ap ?? 0;
}

export async function getHistory(userId: string, limit = 20): Promise<BalanceTx[]> {
  const db = getDb();
  const { data } = await db
    .from('balance_transactions')
    .select('id, kind, amount_ap, balance_after, meta, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  return (data || []).map(r => ({
    id: r.id,
    kind: r.kind,
    amountAp: r.amount_ap,
    balanceAfter: r.balance_after,
    meta: (r.meta || {}) as Record<string, unknown>,
    createdAt: r.created_at,
  }));
}

// ─── Баланс: операции (атомарные RPC) ────────────────────────────────────

/** Начислить AP. Возвращает новый баланс. */
export async function creditBalance(
  userId: string,
  amountAp: number,
  kind: 'topup' | 'redeem' | 'admin',
  meta: Record<string, unknown> = {},
): Promise<number> {
  if (!Number.isInteger(amountAp) || amountAp <= 0) throw new Error('creditBalance: amount must be positive integer');
  const db = getDb();
  const { data, error } = await db.rpc('ap_credit', {
    p_user: userId, p_amount: amountAp, p_kind: kind, p_meta: meta,
  });
  if (error) throw new Error(`ap_credit failed: ${error.message}`);
  return data as number;
}

/**
 * Списать AP. Возвращает новый баланс или null, если средств недостаточно
 * (или RPC недоступен). Атомарно: WHERE balance_ap >= p_amount.
 */
export async function debitBalance(
  userId: string,
  amountAp: number,
  kind: 'spend' | 'admin',
  meta: Record<string, unknown> = {},
): Promise<number | null> {
  if (!Number.isInteger(amountAp) || amountAp <= 0) throw new Error('debitBalance: amount must be positive integer');
  const db = getDb();
  const { data, error } = await db.rpc('ap_debit', {
    p_user: userId, p_amount: amountAp, p_kind: kind, p_meta: meta,
  });
  if (error) return null; // функция отсутствует (миграция не применена) или ошибка
  return (data === null || data === undefined) ? null : (data as number);
}

/**
 * Активировать промо-код. Атомарная RPC ap_redeem.
 * Возврат: { ok, amountAp, balance } | { ok:false, reason }.
 * reason: 'invalid' — не найден/истёк/исчерпан; 'already' — юзер уже активировал.
 */
export async function redeemCode(
  userId: string,
  rawCode: string,
): Promise<{ ok: boolean; amountAp?: number; balance?: number; reason?: string }> {
  const code = normalizePromoCode(rawCode);
  if (!code) return { ok: false, reason: 'invalid' };
  const db = getDb();
  const { data, error } = await db.rpc('ap_redeem', { p_code: code, p_user: userId });
  if (error) {
    // RPC нет (миграция не применена) или ошибка БД
    return { ok: false, reason: 'invalid' };
  }
  const result = data as number;
  if (result === -1) return { ok: false, reason: 'invalid' };
  if (result === -2) return { ok: false, reason: 'already' };
  if (result <= 0) return { ok: false, reason: 'invalid' };
  return { ok: true, amountAp: result, balance: await getBalance(userId) };
}

// ─── Админ: генерация и листинг промо-кодов ──────────────────────────────

export interface PromoCodeRow {
  code: string;
  amountAp: number;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  isActive: boolean;
  note: string | null;
  createdAt: string;
}

export interface GeneratePromoOptions {
  amountAp: number;
  count: number;
  maxUses?: number;
  expiresInDays?: number | null;
  note?: string;
}

/** Сгенерировать пачку промо-кодов. Возвращает человекочитаемые коды. */
export async function generatePromoCodes(opts: GeneratePromoOptions): Promise<string[]> {
  const amountAp = Math.round(opts.amountAp);
  const count = Math.round(opts.count);
  const maxUses = Math.max(1, Math.round(opts.maxUses ?? 1));
  if (amountAp < 1 || amountAp > PROMO_GEN_MAX_AMOUNT) throw new Error('Недопустимая сумма кода');
  if (count < 1 || count > PROMO_GEN_MAX_COUNT) throw new Error('Недопустимое количество кодов');
  if (maxUses > PROMO_GEN_MAX_USES) throw new Error('Недопустимый лимит активаций');

  const expiresAt = opts.expiresInDays && opts.expiresInDays > 0
    ? new Date(Date.now() + opts.expiresInDays * 86400000).toISOString()
    : null;

  const rows = Array.from({ length: count }, () => ({
    code: generatePromoCode(),
    amount_ap: amountAp,
    max_uses: maxUses,
    expires_at: expiresAt,
    note: opts.note?.slice(0, 200) || null,
  }));

  const db = getDb();
  const { error } = await db.from('promo_codes').insert(rows);
  if (error) throw new Error(`insert promo_codes failed: ${error.message}`);
  return rows.map(r => formatPromoCode(r.code));
}

/** Последние промо-коды с использованием (для админки). */
export async function listPromoCodes(limit = 50): Promise<PromoCodeRow[]> {
  const db = getDb();
  const { data } = await db
    .from('promo_codes')
    .select('code, amount_ap, max_uses, used_count, expires_at, is_active, note, created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  return (data || []).map(r => ({
    code: formatPromoCode(r.code),
    amountAp: r.amount_ap,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    expiresAt: r.expires_at,
    isActive: r.is_active,
    note: r.note,
    createdAt: r.created_at,
  }));
}

/** Деактивировать промо-код (админ). */
export async function deactivatePromoCode(formattedCode: string): Promise<boolean> {
  const code = normalizePromoCode(formattedCode);
  if (!code) return false;
  const db = getDb();
  const { error } = await db.from('promo_codes').update({ is_active: false }).eq('code', code);
  return !error;
}
