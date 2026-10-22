import crypto from 'crypto';
import { logEvent } from './logger';

/**
 * ЗАЩИТА CRON-ЭНДПОИНТОВ (патч F-01 из аудита; усилено в батче 6).
 *
 * ИСТОРИЯ УЯЗВИМОСТИ: раньше путь №1 доверял ЛЮБОМУ запросу с заголовком
 * x-vercel-cron («Vercel якобы срезает его на границе у внешних клиентов»).
 * Прод-проба батча 6 это опровергла: внешний запрос с подделанным
 * x-vercel-cron доходил до sync-роута и запускал парсер (200). Открытый
 * из интернета парсер — абьюз/DoS-вектор и несанкционированная запись в БД.
 *
 * Теперь допускаются только два способа, оба требуют ЗНАНИЯ СЕКРЕТА:
 *
 *  1) Vercel Cron Scheduler: при заданной env-переменной CRON_SECRET
 *     планировщик Vercel САМ добавляет к каждому запуску крона заголовок
 *     Authorization: Bearer <CRON_SECRET> (документированное поведение
 *     платформы). CRON_SECRET в проекте задан — этого достаточно.
 *
 *  2) Ручной запуск: Bearer CRON_SECRET или ?secret=<SYNC_SECRET|CRON_SECRET>
 *     (совместимость со scripts/check-sync.ts). Если ни одна из переменных
 *     не задана — ручной доступ закрыт (fail-closed).
 *
 * Заголовок x-vercel-cron БОЛЬШЕ НЕ ДАЁТ ДОСТУПА сам по себе; его наличие
 * в неавторизованном запросе логируется отдельно как спуф-попытка.
 */

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Не утекаем длину секрета по времени: всё равно делаем сравнение
    crypto.timingSafeEqual(bb, bb);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function isCronAuthorized(request: Request): boolean {
  const path = new URL(request.url).pathname;

  // Заголовок платформенного крона: сам по себе доступ НЕ даёт (спуфится
  // снаружи — подтверждено прод-пробой), но фиксируется в логе отказа.
  const spoofedCronHeader = Boolean(request.headers.get('x-vercel-cron'));

  // 1) Bearer CRON_SECRET (авто-инъекция планировщика Vercel или ручной запуск)
  const cronSecret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization') || '';
  if (cronSecret && auth.startsWith('Bearer ')) {
    if (timingSafeEqual(auth.slice(7), cronSecret)) return true;
  }

  // 2) Старый способ: ?secret=... (SYNC_SECRET или CRON_SECRET)
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');
  if (secret) {
    const expected = process.env.SYNC_SECRET || process.env.CRON_SECRET;
    if (expected && timingSafeEqual(secret, expected)) return true;
  }

  // Батч 3 (логирование): отказ виден в Runtime Logs как отдельное событие.
  // Батч 6: спуф x-vercel-cron помечается специальным флагом.
  logEvent('cron_denied', {
    path,
    hadAuthHeader: auth.length > 0,
    hadSecretParam: Boolean(secret),
    spoofedCronHeader,
    ua: (request.headers.get('user-agent') || '').slice(0, 80),
  }, 'warn');
  return false;
}
