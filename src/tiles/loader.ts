/**
 * Tile fetch scheduler.
 *
 * Bandwidth is not the scarce resource — *ordering* is. At 250 m/s the tile
 * the camera is about to fly over must arrive before the one behind it, and
 * the queue is continuously re-sorted as the camera moves, because a tile that
 * was urgent two seconds ago may now be behind the aircraft and worthless.
 *
 * Three behaviours matter for the no-loading feel:
 *
 *  1. **Re-prioritisation.** Queued requests keep their place by priority, not
 *     by arrival. The quadtree updates priorities every frame it re-evaluates.
 *  2. **Cancellation.** A tile that leaves the frustum is dropped from the
 *     queue outright, and aborted if already in flight, so it never competes
 *     with a tile that is actually needed.
 *  3. **Source fallback.** Each request carries an ordered list of URLs. A
 *     404 (common over ocean at deep zoom) or an outage silently falls through
 *     to the next provider rather than leaving a hole in the globe.
 */

import { fetchWithRetry, HttpError, TimeoutError } from '@/data/http';
import { RequestQueue, attachCaller, type QueueEntry, type TileBytes } from './requestQueue';
import { NetworkMonitor, networkMonitor } from '@/net/quality';
import { tileDiskCache, type TileDiskCache } from './cache';

export type { TileBytes } from './requestQueue';

export interface LoaderStats {
  queued: number;
  inFlight: number;
  completed: number;
  failed: number;
  fromDisk: number;
  fromNetwork: number;
  bytesDownloaded: number;
}

/**
 * Concurrency is measured, not chosen.
 *
 * The right limit is a function of the connection — roughly its bandwidth-
 * delay product divided by the size of a tile — so it comes from the network
 * monitor rather than from a constant here. See the table in
 * `@/net/quality/profile`: past the point where the pipe is full, extra
 * requests buy no throughput at all and cost every tile its latency.
 *
 * `NetworkMonitor` is the authority; this is only the value used before it has
 * measured anything, and when a caller (a test) pins the limit explicitly. It
 * matches the neutral `good` profile the monitor also starts from.
 */
const FALLBACK_CONCURRENCY = 20;

export class TileLoader {
  private readonly queue = new RequestQueue();
  private readonly active = new Map<string, QueueEntry>();

  private readonly stats: LoaderStats = {
    queued: 0,
    inFlight: 0,
    completed: 0,
    failed: 0,
    fromDisk: 0,
    fromNetwork: 0,
    bytesDownloaded: 0,
  };

  /**
   * @param maxConcurrent Pinned limit, or `null` to follow the network monitor.
   */
  constructor(
    private readonly maxConcurrent: number | null = null,
    private readonly disk: TileDiskCache = tileDiskCache,
    private readonly monitor: NetworkMonitor = networkMonitor,
  ) {}

  /** In-flight ceiling for right now. */
  get concurrency(): number {
    return this.maxConcurrent ?? this.monitor.profile.concurrency ?? FALLBACK_CONCURRENCY;
  }

  /**
   * Re-open the throttle after the profile changed.
   *
   * Raising the limit is inert on its own: `pump` only runs when a request
   * arrives or one completes, so a queue that is already full and a pipe that
   * just got faster would sit there until something else happened.
   */
  retune(): void {
    this.pump();
  }

  getStats(): Readonly<LoaderStats> {
    this.stats.queued = this.queue.size;
    this.stats.inFlight = this.active.size;
    return this.stats;
  }

  /**
   * Request a tile. Repeated requests for the same key share one fetch and one
   * promise; the priority is lowered to the most urgent caller's.
   */
  request(key: string, urls: string[], priority: number): Promise<TileBytes> {
    const active = this.active.get(key);
    if (active) {
      active.refs++;
      return attachCaller(active);
    }

    const queued = this.queue.get(key);
    if (queued) {
      this.queue.share(queued, priority);
      return attachCaller(queued);
    }

    return new Promise<TileBytes>((resolve, reject) => {
      this.queue.add({
        key,
        priority,
        urls,
        resolve,
        reject,
        controller: new AbortController(),
        refs: 1,
      });
      this.pump();
    });
  }

  /** Re-rank a queued tile. No effect once it is in flight. */
  setPriority(key: string, priority: number): void {
    this.queue.setPriority(key, priority);
  }

  /**
   * Withdraw one caller's interest. The request is only dropped when the last
   * interested caller withdraws, so two visible tiles sharing an ancestor
   * texture do not cancel each other.
   */
  cancel(key: string): void {
    const dropped = this.queue.withdraw(key);
    if (dropped) {
      dropped.reject(new DOMException('Tile no longer needed', 'AbortError'));
      return;
    }
    if (this.queue.get(key)) return; // still wanted by someone else

    const active = this.active.get(key);
    if (active) {
      active.refs--;
      if (active.refs <= 0) active.controller.abort();
    }
  }

  /** Drop every queued request. In-flight ones are left to finish. */
  cancelAllQueued(): void {
    this.queue.clear(new DOMException('Loader flushed', 'AbortError'));
  }

  private pump(): void {
    const limit = this.concurrency;
    while (this.active.size < limit) {
      const entry = this.queue.take();
      if (!entry) break;
      this.active.set(entry.key, entry);
      void this.run(entry);
    }
    // The monitor cannot tell a slow link from an idle app by looking at
    // transfer samples — both produce one small slow request at a time. Only
    // the queue knows, so it says.
    this.monitor.setDemand(this.active.size, this.queue.size);
  }

  private async run(entry: QueueEntry): Promise<void> {
    try {
      const bytes = await this.load(entry);
      this.stats.completed++;
      entry.resolve(bytes);
    } catch (err) {
      this.stats.failed++;
      entry.reject(err);
    } finally {
      this.active.delete(entry.key);
      this.pump();
    }
  }

  private async load(entry: QueueEntry): Promise<TileBytes> {
    const cached = await this.disk.get(entry.key);
    if (cached) {
      this.stats.fromDisk++;
      return { key: entry.key, data: cached, sourceIndex: 0, fromDisk: true };
    }

    let lastError: unknown;
    for (let i = 0; i < entry.urls.length; i++) {
      const url = entry.urls[i]!;
      // Timed here rather than inside `fetchWithRetry`, so the measurement
      // covers reading the body too. A link that delivers headers promptly and
      // then dribbles the payload is slow, and a first-byte time would call it
      // fast.
      const started = performance.now();
      try {
        const res = await fetchWithRetry(url, {
          // Patience, not retries. A weak link needs a longer window for the
          // same tile; asking again only doubles the traffic it is already
          // failing to carry.
          timeoutMs: this.monitor.profile.timeoutMs,
          // The fallback chain is the retry. Retrying a dead host wastes a slot
          // that a different provider could have used.
          retries: 0,
          signal: entry.controller.signal,
          headers: { Accept: 'image/*' },
        });

        const data = await res.arrayBuffer();
        // A zero-length body is a failure dressed up as a success.
        if (data.byteLength === 0) throw new Error(`Empty tile body from ${url}`);

        this.stats.fromNetwork++;
        this.stats.bytesDownloaded += data.byteLength;
        this.monitor.record({
          ms: performance.now() - started,
          bytes: data.byteLength,
          ok: true,
        });
        // Fire and forget: the render path must not wait on IndexedDB.
        void this.disk.put(entry.key, data.slice(0));

        return { key: entry.key, data, sourceIndex: i, fromDisk: false };
      } catch (err) {
        if (entry.controller.signal.aborted) throw err;
        lastError = err;

        // A 404 is coverage, not connectivity: open ocean at deep zoom returns
        // one routinely, and feeding it to the monitor would make a flight over
        // the Atlantic look like a failing connection and throttle the link
        // that is working perfectly well.
        const isCoverage = err instanceof HttpError && err.status === 404;
        if (!isCoverage) {
          this.monitor.record({
            ms: performance.now() - started,
            bytes: 0,
            ok: false,
            timedOut: err instanceof TimeoutError,
          });
        }

        // 4xx means this provider has no coverage here; try the next one.
        // Anything else is worth trying elsewhere too.
        if (err instanceof HttpError && err.status >= 400 && err.status < 500) continue;
      }
    }

    throw lastError ?? new Error(`No source served ${entry.key}`);
  }
}
