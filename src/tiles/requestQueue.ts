/**
 * The priority queue behind the tile loader.
 *
 * Bandwidth is not the scarce resource — *ordering* is. At 250 m/s the tile
 * the camera is about to fly over must arrive before the one behind it, and
 * the queue is continuously re-sorted as the camera moves, because a tile that
 * was urgent two seconds ago may now be behind the aircraft and worthless.
 *
 * Three behaviours matter, and all three are about ordering rather than speed:
 *
 *  1. **Re-prioritisation.** Queued requests keep their place by priority, not
 *     by arrival. The quadtree updates priorities every frame it re-evaluates.
 *  2. **Reference counting.** Two visible tiles can share one heightmap, so a
 *     request is only dropped when the *last* interested caller withdraws.
 *     Cancelling on the first withdrawal would have one tile repeatedly
 *     cancelling the request its neighbour is waiting on.
 *  3. **Chained continuations.** A second caller for a key in flight gets the
 *     same bytes rather than a second fetch — which is exactly why those bytes
 *     are shared and must never be transferred. See `tileFetch.ts`.
 *
 * An array re-sorted on change, not a heap: there are a few hundred entries at
 * most, the sort only runs when something actually changed, and a heap cannot
 * be re-prioritised in place without an index map that costs more than the
 * sort it saves.
 */

export interface QueueEntry {
  key: string;
  priority: number;
  urls: string[];
  resolve: (value: TileBytes) => void;
  reject: (reason: unknown) => void;
  controller: AbortController;
  /** Callers sharing this request; the entry is cancelled when all withdraw. */
  refs: number;
}

export interface TileBytes {
  key: string;
  data: ArrayBuffer;
  /** Index into the request's URL list that actually served the tile. */
  sourceIndex: number;
  /** True when it came from IndexedDB rather than the network. */
  fromDisk: boolean;
}

export class RequestQueue {
  private readonly queued = new Map<string, QueueEntry>();
  private sorted: QueueEntry[] = [];
  private dirty = false;

  get size(): number {
    return this.queued.size;
  }

  get(key: string): QueueEntry | undefined {
    return this.queued.get(key);
  }

  add(entry: QueueEntry): void {
    this.queued.set(entry.key, entry);
    this.dirty = true;
  }

  /**
   * Attach another caller to a queued request.
   *
   * The priority is lowered to the most urgent caller's, never raised: a tile
   * that some other node considers urgent does not become less urgent because
   * a distant one also wants it.
   */
  share(entry: QueueEntry, priority: number): void {
    entry.refs++;
    if (priority < entry.priority) {
      entry.priority = priority;
      this.dirty = true;
    }
  }

  setPriority(key: string, priority: number): void {
    const entry = this.queued.get(key);
    if (entry && entry.priority !== priority) {
      entry.priority = priority;
      this.dirty = true;
    }
  }

  /** Withdraw one caller. Returns the entry if it was actually dropped. */
  withdraw(key: string): QueueEntry | null {
    const entry = this.queued.get(key);
    if (!entry) return null;
    entry.refs--;
    if (entry.refs > 0) return null;
    this.queued.delete(key);
    this.dirty = true;
    return entry;
  }

  /** The most urgent entry, removed from the queue. */
  take(): QueueEntry | undefined {
    if (this.queued.size === 0) return undefined;

    if (this.dirty || this.sorted.length !== this.queued.size) {
      this.sorted = [...this.queued.values()].sort((a, b) => a.priority - b.priority);
      this.dirty = false;
    }

    const entry = this.sorted.shift();
    if (!entry) return undefined;
    this.queued.delete(entry.key);
    return entry;
  }

  /** Drop everything, rejecting each waiting caller. */
  clear(reason: unknown): void {
    for (const entry of this.queued.values()) entry.reject(reason);
    this.queued.clear();
    this.sorted = [];
    this.dirty = false;
  }
}

/**
 * Chain a new caller's settlement onto an existing request.
 *
 * Both callers must be settled, in order, from one outcome — so the entry's
 * own `resolve`/`reject` are replaced by a pair that calls the previous one
 * first. Returning a promise that merely `.then`s the original would lose the
 * cancellation semantics, because the original is what `refs` is counting.
 */
export function attachCaller(entry: QueueEntry): Promise<TileBytes> {
  return new Promise<TileBytes>((resolve, reject) => {
    const prevResolve = entry.resolve;
    const prevReject = entry.reject;
    entry.resolve = (v) => {
      prevResolve(v);
      resolve(v);
    };
    entry.reject = (e) => {
      prevReject(e);
      reject(e);
    };
  });
}
