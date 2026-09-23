/**
 * Terrain worker pool.
 *
 * Dispatches to the least-loaded worker rather than round-robin: tile build
 * cost varies by an order of magnitude (a 32-quad ocean patch with no
 * heightmap against a 64-quad alpine tile), so round-robin reliably parks the
 * urgent tile behind the expensive one.
 */

import type { BuildTileRequest, BuiltTile, WorkerResponse } from './protocol';

interface Pending {
  resolve: (tile: BuiltTile) => void;
  reject: (reason: unknown) => void;
  workerIndex: number;
}

/**
 * Worker count. One per core saturates the machine and starves the render
 * loop, which is the thing we are protecting; leaving headroom is the point.
 */
function defaultWorkerCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  // Measured render cost is ~2 ms of a 16.7 ms budget, so the main thread is
  // not the constraint — tile supply is. Leave one core for the render loop
  // and give the rest to geometry.
  return Math.max(2, Math.min(8, cores - 1));
}

/**
 * How many times one slot may be respawned before it is written off.
 *
 * A worker that dies on a transient fault deserves a replacement; one that
 * dies on every message is a crash loop, and respawning it forever would burn
 * a core re-running the same failure. After this many attempts the slot is
 * retired and the remaining workers carry the pool.
 */
const MAX_RESPAWNS = 3;

export class TerrainWorkerPool {
  private readonly workers: (Worker | null)[] = [];
  private readonly loads: number[] = [];
  private readonly respawns: number[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;

  constructor(size = defaultWorkerCount()) {
    for (let i = 0; i < size; i++) {
      this.workers.push(null);
      this.loads.push(0);
      this.respawns.push(0);
      this.spawn(i);
    }
  }

  private spawn(index: number): void {
    const worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), {
      type: 'module',
      name: `planesview-terrain-${index}`,
    });
    worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) =>
      this.onMessage(e.data),
    );
    worker.addEventListener('error', (e) => this.onWorkerError(index, e));
    this.workers[index] = worker;
    this.loads[index] = 0;
  }

  /** Live workers — a retired slot is not capacity and must not be counted. */
  get size(): number {
    let n = 0;
    for (const w of this.workers) if (w) n++;
    return n;
  }

  /** Builds currently queued or running, across all workers. */
  get busy(): number {
    return this.pending.size;
  }

  /**
   * Least-loaded *live* worker, or -1 if the pool is empty.
   *
   * The liveness test is not decoration. A dead slot has a load of zero and
   * never climbs, so a pool that skipped it would still elect it every single
   * time — one dead worker would swallow every build in the app.
   */
  private leastLoaded(): number {
    let best = -1;
    for (let i = 0; i < this.loads.length; i++) {
      if (!this.workers[i]) continue;
      if (best === -1 || this.loads[i]! < this.loads[best]!) best = i;
    }
    return best;
  }

  private onMessage(msg: WorkerResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return; // cancelled while in flight
    this.pending.delete(msg.id);
    this.loads[entry.workerIndex] = Math.max(0, this.loads[entry.workerIndex]! - 1);

    if (msg.type === 'built') entry.resolve(msg);
    else entry.reject(new Error(msg.message));
  }

  private onWorkerError(index: number, event: ErrorEvent): void {
    // A worker that died takes its in-flight builds with it. Fail them
    // explicitly so the quadtree retries instead of waiting forever.
    for (const [id, entry] of this.pending) {
      if (entry.workerIndex !== index) continue;
      this.pending.delete(id);
      entry.reject(new Error(`Terrain worker failed: ${event.message}`));
    }
    this.loads[index] = 0;

    // Replace it. Zeroing the load without replacing the worker left a slot
    // that looked permanently idle to `leastLoaded`, so every subsequent
    // build was dispatched to a dead worker and the quadtree burned through
    // its retry budget instead of using the healthy ones.
    this.workers[index]?.terminate();
    this.workers[index] = null;
    if (this.disposed) return;

    if (this.respawns[index]! < MAX_RESPAWNS) {
      this.respawns[index]!++;
      this.spawn(index);
    }
  }

  build(
    request: Omit<BuildTileRequest, 'id' | 'type'>,
    signal?: AbortSignal,
  ): Promise<BuiltTile> {
    if (this.disposed) return Promise.reject(new Error('Worker pool disposed'));

    const id = this.nextId++;
    const index = this.leastLoaded();
    if (index === -1) {
      return Promise.reject(new Error('No terrain worker available'));
    }
    const worker = this.workers[index]!;

    return new Promise<BuiltTile>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }

      this.pending.set(id, { resolve, reject, workerIndex: index });
      this.loads[index] = this.loads[index]! + 1;

      signal?.addEventListener(
        'abort',
        () => {
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          this.loads[entry.workerIndex] = Math.max(0, this.loads[entry.workerIndex]! - 1);
          // The build itself cannot be interrupted; its result is simply
          // dropped when it arrives.
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );

      const message: BuildTileRequest = { ...request, type: 'build', id };
      // The encoded PNG is transferred, not copied.
      worker.postMessage(message, message.bytes ? [message.bytes] : []);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.pending.values()) {
      entry.reject(new Error('Worker pool disposed'));
    }
    this.pending.clear();
    for (const w of this.workers) w?.terminate();
    this.workers.length = 0;
    this.loads.length = 0;
    this.respawns.length = 0;
  }
}
