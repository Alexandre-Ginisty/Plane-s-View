/**
 * Persistent tile cache.
 *
 * Two levels:
 *  - a memory LRU of decoded `ImageBitmap`s / `Float32Array` heightmaps, which
 *    is what the renderer actually binds;
 *  - an IndexedDB store of the *encoded* bytes, which survives reload and is
 *    what makes a revisited area appear instantly instead of re-downloading.
 *
 * ## Why not `idb-keyval` for this store
 *
 * LRU eviction needs to find the least recently used key without reading every
 * tile's pixel data. That requires an index, which a pure key-value wrapper
 * does not expose. So the blobs live in one object store and small
 * `{key, size, lastAccess}` records live in a second store with an index on
 * `lastAccess`; eviction walks that index and touches no image bytes at all.
 *
 * ## Degradation
 *
 * Every path here is best-effort. Private browsing, disabled storage, a full
 * disk and Safari's eviction all surface as ordinary failures, and each one
 * falls back to "memory only" rather than breaking the globe.
 */

const DB_NAME = 'planesview';
const DB_VERSION = 1;
const BLOB_STORE = 'blobs';
const INDEX_STORE = 'index';

/**
 * On-disk budget: about 1800 satellite tiles on a computer, 600 on a phone.
 *
 * Enough for the ground of a session and the next visit to the same place to
 * open instantly; not so much that the site becomes the biggest thing in a
 * phone's storage. A visitor's disk is theirs, not the app's.
 */
const DESKTOP_BUDGET_BYTES = 120 * 1024 * 1024;
const PHONE_BUDGET_BYTES = 40 * 1024 * 1024;
const DEFAULT_BUDGET_BYTES =
  typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches
    ? PHONE_BUDGET_BYTES
    : DESKTOP_BUDGET_BYTES;

/**
 * Tiles not looked at for this long are deleted when the app next opens:
 * whatever was seen a week ago is not worth keeping on someone's disk on the
 * chance they come back to exactly that place.
 */
const MAX_AGE_MS = 5 * 24 * 3600 * 1000;

/** Never fill more than this share of the origin's quota. */
const QUOTA_SHARE = 0.4;

interface IndexRecord {
  key: string;
  size: number;
  lastAccess: number;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/** How long opening the database may take before the cache is skipped. */
const OPEN_TIMEOUT_MS = 2500;
/** How long one read may take before the tile is fetched instead. */
const READ_TIMEOUT_MS = 600;

/** The promise's value, or undefined once `ms` have passed. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class TileDiskCache {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase | null> | null = null;
  private available = true;

  private totalBytes = 0;
  private budgetBytes = DEFAULT_BUDGET_BYTES;

  /**
   * Access-time updates are batched. Writing one record per tile read would
   * put an IndexedDB transaction on the critical path of every frame that
   * scrolls a new tile into view.
   */
  private readonly pendingTouches = new Map<string, number>();
  private touchTimer: number | null = null;

  private async open(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    if (!this.available) return null;
    if (this.opening) return this.opening;

    this.opening = (async () => {
      if (typeof indexedDB === 'undefined') {
        this.available = false;
        return null;
      }

      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        // Blocked by another tab holding an older version open, an open never
        // settles — and every tile read waited on it, so the ground never
        // loaded at all. Past this long the cache is off for the session and
        // tiles come from the network, which is what it is a shortcut for.
        req.onblocked = () => undefined;
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(BLOB_STORE)) {
            db.createObjectStore(BLOB_STORE);
          }
          if (!db.objectStoreNames.contains(INDEX_STORE)) {
            const idx = db.createObjectStore(INDEX_STORE, { keyPath: 'key' });
            idx.createIndex('lastAccess', 'lastAccess', { unique: false });
          }
        };

        const db = await withTimeout(promisify(req), OPEN_TIMEOUT_MS);
        if (!db) {
          // If it does open after all, let it go.
          req.onsuccess = () => req.result.close();
          this.available = false;
          return null;
        }
        db.onversionchange = () => {
          // Another tab is upgrading; let go rather than block it.
          db.close();
          this.db = null;
        };
        this.db = db;

        // Sized in the background: reading every index record of a full cache
        // is not something the first tile should wait for.
        void this.computeBudget()
          .then(() => this.expire(Date.now() - MAX_AGE_MS))
          .then(() => this.recomputeTotal())
          .then(() => this.evict());
        return db;
      } catch {
        this.available = false;
        return null;
      }
    })();

    return this.opening;
  }

  /** Size the cache against the origin's actual quota, not a guess. */
  private async computeBudget(): Promise<void> {
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.quota) {
        this.budgetBytes = Math.min(DEFAULT_BUDGET_BYTES, estimate.quota * QUOTA_SHARE);
      }
    } catch {
      // Keep the default.
    }
  }

  private async recomputeTotal(): Promise<void> {
    const db = this.db;
    if (!db) return;
    try {
      const tx = db.transaction(INDEX_STORE, 'readonly');
      const records = await promisify(
        tx.objectStore(INDEX_STORE).getAll() as IDBRequest<IndexRecord[]>,
      );
      this.totalBytes = records.reduce((sum, r) => sum + (r.size || 0), 0);
    } catch {
      this.totalBytes = 0;
    }
  }

  get diskBytes(): number {
    return this.totalBytes;
  }

  get budget(): number {
    return this.budgetBytes;
  }

  get enabled(): boolean {
    return this.available;
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const db = await this.open();
    if (!db) return null;

    try {
      const tx = db.transaction(BLOB_STORE, 'readonly');
      // A read slower than the network is not a cache: give up and fetch.
      const value = await withTimeout(
        promisify(tx.objectStore(BLOB_STORE).get(key) as IDBRequest<ArrayBuffer | undefined>),
        READ_TIMEOUT_MS,
      );
      if (!value) return null;
      this.touch(key);
      return value;
    } catch {
      return null;
    }
  }

  async put(key: string, data: ArrayBuffer): Promise<void> {
    const db = await this.open();
    if (!db) return;

    try {
      const tx = db.transaction([BLOB_STORE, INDEX_STORE], 'readwrite');
      tx.objectStore(BLOB_STORE).put(data, key);
      tx.objectStore(INDEX_STORE).put({
        key,
        size: data.byteLength,
        lastAccess: Date.now(),
      } satisfies IndexRecord);
      await txDone(tx);

      this.totalBytes += data.byteLength;
      if (this.totalBytes > this.budgetBytes) void this.evict();
    } catch (err) {
      // A quota error means the budget estimate was optimistic. Free space and
      // lower the ceiling rather than failing every subsequent write.
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        this.budgetBytes = Math.max(16 * 1024 * 1024, this.totalBytes * 0.6);
        void this.evict();
      }
    }
  }

  private touch(key: string): void {
    this.pendingTouches.set(key, Date.now());
    if (this.touchTimer !== null) return;
    this.touchTimer = self.setTimeout(() => {
      this.touchTimer = null;
      void this.flushTouches();
    }, 5000);
  }

  private async flushTouches(): Promise<void> {
    const db = await this.open();
    if (!db || this.pendingTouches.size === 0) return;

    const batch = [...this.pendingTouches];
    this.pendingTouches.clear();

    try {
      const tx = db.transaction(INDEX_STORE, 'readwrite');
      const store = tx.objectStore(INDEX_STORE);
      for (const [key, at] of batch) {
        const existing = await promisify(store.get(key) as IDBRequest<IndexRecord | undefined>);
        if (existing) store.put({ ...existing, lastAccess: at });
      }
      await txDone(tx);
    } catch {
      // Losing access times only degrades eviction order.
    }
  }

  /** Delete every tile last used before `before` (ms since the epoch). */
  private async expire(before: number): Promise<void> {
    const db = this.db;
    if (!db) return;
    try {
      const tx = db.transaction([BLOB_STORE, INDEX_STORE], 'readwrite');
      const blobs = tx.objectStore(BLOB_STORE);
      const records = tx.objectStore(INDEX_STORE);
      const cursorReq = records.index('lastAccess').openCursor(IDBKeyRange.upperBound(before));
      await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return resolve();
          const key = (cursor.value as IndexRecord).key;
          blobs.delete(key);
          records.delete(key);
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
      await txDone(tx);
    } catch {
      // Expiry is housekeeping: the size budget still holds without it.
    }
  }

  /** Evict least-recently-used tiles until comfortably under budget. */
  async evict(target = this.budgetBytes * 0.8): Promise<number> {
    const db = await this.open();
    if (!db || this.totalBytes <= target) return 0;

    let freed = 0;
    try {
      const tx = db.transaction([BLOB_STORE, INDEX_STORE], 'readwrite');
      const index = tx.objectStore(INDEX_STORE).index('lastAccess');
      const blobs = tx.objectStore(BLOB_STORE);
      const records = tx.objectStore(INDEX_STORE);

      // Oldest first.
      const cursorReq = index.openCursor(null, 'next');
      await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || this.totalBytes - freed <= target) return resolve();
          const record = cursor.value as IndexRecord;
          blobs.delete(record.key);
          records.delete(record.key);
          freed += record.size || 0;
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });

      await txDone(tx);
      this.totalBytes = Math.max(0, this.totalBytes - freed);
    } catch {
      // Leave the total alone; the next put will try again.
    }
    return freed;
  }

  async clear(): Promise<void> {
    const db = await this.open();
    if (!db) return;
    try {
      const tx = db.transaction([BLOB_STORE, INDEX_STORE], 'readwrite');
      tx.objectStore(BLOB_STORE).clear();
      tx.objectStore(INDEX_STORE).clear();
      await txDone(tx);
      this.totalBytes = 0;
    } catch {
      // Nothing useful to do.
    }
  }
}

/** One cache per document. */
export const tileDiskCache = new TileDiskCache();
