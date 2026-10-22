/**
 * Лёгкие утилиты преобразования (патч F-08 из аудита).
 *
 * Раньше mapToCamel жил внутри src/lib/data.ts (6.1 МБ статических данных).
 * Каждый API-роут, которому нужна была лишь конвертация camelCase, статически
 * импортировал весь файл -> 6.1 МБ парсились при холодном старте каждой
 * serverless-функции. Теперь утилиты вынесены в маленький модуль, а тяжёлые
 * статические массивы загружаются лениво (await import('@/lib/data')) только
 * когда действительно нужен статический fallback.
 */

export function toCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const camel = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null) {
      out[camel] = (v as Record<string, unknown>[]).map(toCamel);
    } else {
      out[camel] = v;
    }
  }
  return out;
}

export function mapToCamel<T>(items: T[]): T[] {
  return items.map(i => toCamel(i as Record<string, unknown>)) as T[];
}

/**
 * Русскоязычный приоритет названий (запрос пользователя: «названия аниме
 * должны быть на русском»).
 *
 * В БД (и статике) title — оригинальное название (часто английское),
 * title_russian — русское. На карточках/в плеере/поиске основным должно быть
 * РУССКОЕ название, оригинал — мелким подзаголовком.
 *
 * Возвращает { title, title_russian } для спреда в маппингах API:
 *   title        = русское название (если есть и отличается от оригинала)
 *   title_russian= оригинал для подзаголовка; null, если русский вариант
 *                  отсутствует или повторяет оригинал (чтобы не показывать
 *                  одно и то же название дважды).
 */
export function preferRussianTitle(row: Record<string, unknown>): { title: string; title_russian: string | null } {
  const orig = String(row.title || '').trim();
  const ru = String(row.title_russian || '').trim();
  const hasCyrillic = (s: string) => /[а-яё]/i.test(s);
  // Определяем «русское» название по кириллице, а не по имени поля: парсер
  // hentaibaza иногда встречает формат alt-текста «Eng / Рус» и пишет поля
  // наоборот (в БД title='Кроличий рай', title_russian='Bunny paradise').
  let russian = ru;
  let other = orig;
  if (!hasCyrillic(ru) && hasCyrillic(orig)) {
    russian = orig;
    other = ru;
  }
  if (!russian) return { title: orig, title_russian: null };
  if (!other || other.toLowerCase() === russian.toLowerCase()) {
    return { title: russian, title_russian: null };
  }
  return { title: russian, title_russian: other };
}
