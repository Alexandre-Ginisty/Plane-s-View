/**
 * Least-recently-used map.
 *
 * Backed by a plain `Map`, which iterates in insertion order — deleting and
 * re-inserting a key on access moves it to the end, so the oldest entry is
 * always the first key of the iterator. That makes both `get` and `set` O(1)
 * with no linked list to maintain.
 *
 * Entries may declare a size (bytes, texels, whatever the caller counts in) so
 * the same class can bound a texture cache by memory and a metadata cache by
 * entry count.
 */

export interface LruOptions<K, V> {
  /** Maximum number of entries. */
  maxEntries?: number;
  /** Maximum total size, in whatever unit `sizeOf` returns. */
  maxSize?: number;
  /** Size of one value. Defaults to 1, making `maxSize` an entry count. */
  sizeOf?: (value: V, key: K) => number;
  /** Called for every entry evicted or deleted — release GPU resources here. */
  onEvict?: (value: V, key: K) => void;
}

export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly sizes = new Map<K, number>();
  private totalSize = 0;

  private readonly maxEntries: number;
  private readonly maxSize: number;
  private readonly sizeOf: (value: V, key: K) => number;
  private readonly onEvict: ((value: V, key: K) => void) | undefined;

  constructor(options: LruOptions<K, V> = {}) {
    this.maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
    this.maxSize = options.maxSize ?? Number.POSITIVE_INFINITY;
    this.sizeOf = options.sizeOf ?? (() => 1);
    this.onEvict = options.onEvict;
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.totalSize;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Look up without promoting — for "is it resident?" checks. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // Re-insert to move to the most-recent end.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.totalSize -= this.sizes.get(key) ?? 0;
      this.map.delete(key);
      if (existing !== value) this.onEvict?.(existing, key);
    }

    const size = this.sizeOf(value, key);
    this.map.set(key, value);
    this.sizes.set(key, size);
    this.totalSize += size;

    this.trim();
  }

  delete(key: K): boolean {
    const value = this.map.get(key);
    if (value === undefined && !this.map.has(key)) return false;
    this.totalSize -= this.sizes.get(key) ?? 0;
    this.map.delete(key);
    this.sizes.delete(key);
    this.onEvict?.(value as V, key);
    return true;
  }

  clear(): void {
    for (const [k, v] of this.map) this.onEvict?.(v, k);
    this.map.clear();
    this.sizes.clear();
    this.totalSize = 0;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  /**
   * Evict until both limits are satisfied. `protect` lets a caller keep the
   * tiles currently on screen resident even if they are the least recently
   * touched — evicting a visible tile would cause exactly the pop we are
   * trying to eliminate.
   */
  trim(protect?: (key: K) => boolean): void {
    if (this.map.size <= this.maxEntries && this.totalSize <= this.maxSize) return;

    for (const key of [...this.map.keys()]) {
      if (this.map.size <= this.maxEntries && this.totalSize <= this.maxSize) break;
      if (protect?.(key)) continue;
      this.delete(key);
    }
  }
}
