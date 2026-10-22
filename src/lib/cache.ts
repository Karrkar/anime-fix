/**
 * F-20 fix: ограниченный TTL-кэш с LRU-вытеснением.
 *
 * Раньше кэши контента в route-хендлерах были Map без границ: в лямбде
 * запись с истёкшим TTL не удалялась никогда (setInterval в serverless не
 * гарантирует исполнения), память росла -> утечки и холодные рестарты.
 *
 * Этот кэш:
 *  - отбрасывает записи старше ttlMs при обращении (лениво, без таймеров);
 *  - никогда не хранит больше maxEntries (LRU: вытесняется самая старая
 *    по использованию запись);
 *  - не использует ни таймеров, ни Node-API — работает и на Edge Runtime.
 */
export class BoundedTTLCache<K, V> {
  private map = new Map<K, { v: V; ts: number }>();

  constructor(private maxEntries: number, private ttlMs: number) {
    if (maxEntries < 1) this.maxEntries = 1;
  }

  /** Возвращает значение или null (нет/просрочено). Обновляет LRU-позицию. */
  get(key: K): V | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    // LRU refresh: перезапись в конец Map (порядок вставки = порядок использования)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.map.set(key, { v: value, ts: Date.now() });
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
