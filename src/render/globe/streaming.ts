/**
 * Tile streaming: the load state machine.
 *
 * Everything between "this tile needs content" and "this tile has content or
 * has provably given up". It owns the fetch scheduler, the worker pool and the
 * frontier of tiles currently in flight, and it is the only place that touches
 * a node's `*State`, `*Gen`, `*Attempts` and `*RequestKey` fields.
 *
 * Separated from the quadtree because the two fail in completely different
 * ways and the bugs here were all ownership bugs — a buffer transferred twice,
 * a request never withdrawn, a state left wedged at `loading` — which are
 * exactly the bugs that hide when the code that owns a resource is spread
 * across nine hundred lines of unrelated selection logic.
 *
 * ## The invariants
 *
 * 1. Every load path ends in exactly one `finish` call, including the aborted
 *    ones. A path that returns without settling leaves the node in `loading`
 *    for ever, consuming frontier budget and permanently unrefinable.
 * 2. Every started load bumps a generation, and writes nothing if it has been
 *    superseded. Without this, an abandoned load that resumes overwrites the
 *    state of the load that replaced it.
 * 3. Bytes handed out by the loader are shared between callers and are
 *    **never** transferred. `loadGeometry` copies before the worker sees them;
 *    `loadTexture` relies on `new Blob([...])` copying.
 * 4. Abandoning a node withdraws its loader requests. Aborting our own
 *    continuation does not free the loader's concurrency slot.
 */

import { TileLoader } from '@/tiles/loader';
import { TERRARIUM, type ImagerySource } from '@/tiles/sources';
import { TerrainWorkerPool } from '@/workers/pool';
import {
  ABANDON_AFTER_FRAMES,
  MAX_CONCURRENT_TILE_LOADS,
  MAX_LOAD_ATTEMPTS,
  RETRY_BASE_FRAMES,
} from './constants';
import { priorityOf } from './metrics';
import { loadGeometry, loadTexture, type LoadContext, type StreamerOptions } from './tileFetch';
import type { TileNode } from './tileNode';

export type { StreamerOptions } from './tileFetch';

/**
 * Refinement candidates gathered during selection, as whole quads.
 *
 * Quads and not tiles: `Globe.visit` refuses to refine until all four children
 * are ready, so funding three of four buys nothing at all. See `flush`.
 */
export type LoadFrontier = { pending: TileNode[]; error: number }[];

export class TileStreamer {
  private readonly loader = new TileLoader();
  private readonly workers = new TerrainWorkerPool();

  /** Nodes with a load in flight, so the frontier can be bounded. */
  private readonly loading = new Set<TileNode>();

  private imagery: ImagerySource;
  private frame = 0;
  private maxAnisotropy = 8;

  constructor(
    imagery: ImagerySource,
    private options: StreamerOptions,
  ) {
    this.imagery = imagery;
  }

  /**
   * Everything the two loaders need, rebuilt per call.
   *
   * Cheap (one object literal) and correct: `frame` and `imagery` both change
   * under it, and a context cached at construction would hand every load the
   * frame number and the imagery layer that were current when the globe was
   * built.
   */
  private context(): LoadContext {
    return {
      loader: this.loader,
      workers: this.workers,
      imagery: this.imagery,
      options: this.options,
      maxAnisotropy: this.maxAnisotropy,
      frame: this.frame,
      finish: (node, kind, gen, outcome) => this.finish(node, kind, gen, outcome),
    };
  }

  /** Tiles currently waiting on the network or a worker. */
  get loadingCount(): number {
    return this.loading.size;
  }

  get loaderStats(): { queued: number; inFlight: number } {
    const s = this.loader.getStats();
    return { queued: s.queued, inFlight: s.inFlight };
  }

  /** Called once per globe update, before any `ensureContent`. */
  beginFrame(frame: number): void {
    this.frame = frame;
  }

  setOptions(options: StreamerOptions): void {
    this.options = options;
  }

  setAnisotropy(max: number): void {
    this.maxAnisotropy = Math.max(1, Math.floor(max));
  }

  /** Re-open the loader's throttle after the connection profile changed. */
  retune(): void {
    this.loader.retune();
  }

  /**
   * Switch imagery layer.
   *
   * The node-side half of this (dropping textures, resetting state) is the
   * globe's, because it owns the tree; what belongs here is superseding the
   * loads in flight for the layer being left behind.
   */
  setImagery(source: ImagerySource): void {
    this.imagery = source;
  }

  /** Supersede any texture load in flight for this node and withdraw it. */
  cancelTexture(node: TileNode): void {
    node.textureGen++;
    if (node.textureRequestKey !== null) {
      this.loader.cancel(node.textureRequestKey);
      node.textureRequestKey = null;
    }
  }

  flushQueue(): void {
    this.loader.cancelAllQueued();
  }

  /** Tiles waiting on the network right now. */
  get queueDepth(): number {
    return this.loader.getStats().queued;
  }

  /** Warm the cache for one tile, behind every live request. See `Globe`. */
  prefetchTile(z: number, x: number, y: number, priority: number): void {
    void this.loader
      .request(`${this.imagery.id}/${z}/${x}/${y}`, [this.imagery.url(z, x, y)], priority)
      .catch(() => undefined);

    // Terrarium stops at zoom 15, so a deeper tile wants its z15 ancestor —
    // the same heightmap `elevationRequest` will ask for when the tile is
    // really built. Asking for `terrarium/17/...` instead just 404s, and
    // before the descent prefetch existed nothing ever called this past z12
    // so the ceiling was never hit.
    const ez = Math.min(z, TERRARIUM.maxZoom);
    const shift = z - ez;
    const ex = x >> shift;
    const ey = y >> shift;
    void this.loader
      .request(`terrarium/${ez}/${ex}/${ey}`, [TERRARIUM.url(ez, ex, ey)], priority)
      .catch(() => undefined);
  }

  forget(node: TileNode): void {
    this.loading.delete(node);
  }

  dispose(): void {
    this.workers.dispose();
    this.loader.cancelAllQueued();
  }

  /**
   * Spend the frame's load budget on the quads that look worst right now.
   *
   * Two rules, both learned the hard way from a cockpit at FL420:
   *
   * Worst-first, not nearest-first. Nearest-first sounds right — load what the
   * viewer is closest to — but under a moving aircraft the nearest tiles churn
   * continuously, so they take the whole budget every frame and the mid-field
   * never gets any. The symptom is a sharp corridor of detail directly below
   * the aircraft with stretched, blurry z8 either side of it. Screen-space
   * error ranks by how wrong the picture actually looks instead, which is the
   * thing we are trying to fix.
   *
   * Whole quads, never partial. `visit` refuses to refine until all four
   * children are ready (rule 3 — holes are worse than blur), so a quad with
   * three of four funded renders exactly as it did before: the budget spent on
   * it bought nothing. Skipping a quad that does not fit, rather than part-
   * funding it, leaves that budget for a smaller quad behind it in the queue.
   */
  flush(frontier: LoadFrontier): void {
    let budget = MAX_CONCURRENT_TILE_LOADS - this.loading.size;
    if (budget <= 0 || frontier.length === 0) return;

    frontier.sort((a, b) => b.error - a.error);

    for (const quad of frontier) {
      if (quad.pending.length > budget) continue;

      // Count what actually started: a child already in flight is in `pending`
      // (it is not ready yet) but costs nothing to re-request.
      const before = this.loading.size;
      for (const child of quad.pending) this.ensureContent(child);
      budget -= this.loading.size - before;

      if (budget <= 0) return;
    }
  }

  /**
   * Re-rank every outstanding request against where the camera is *now*.
   *
   * `TileLoader` has always documented this — "the quadtree updates priorities
   * every frame it re-evaluates" — and nothing ever called `setPriority`. A
   * request was ranked once, by the view at the instant the tile was first
   * wanted, and kept that rank until it was served. At 250 m/s the ordering is
   * stale within a couple of seconds, so the queue steadily fills with tiles
   * ranked for airspace already behind the aircraft, served ahead of the ground
   * coming up.
   *
   * Bounded by the frontier, not by the tree: only nodes with a load actually
   * in flight are here, and a queue entry the loader has already started is
   * left alone because it cannot be re-ordered anyway.
   */
  reprioritise(): void {
    if (this.loading.size === 0) return;
    for (const node of this.loading) {
      // Nodes selection did not look at this frame keep the error they last
      // scored, and `priorityOf` drops them into the off-screen band on the
      // strength of `onScreenFrame`.
      const priority = priorityOf(node, this.frame);
      node.priority = priority;
      if (node.geometryRequestKey !== null) {
        this.loader.setPriority(node.geometryRequestKey, priority);
      }
      if (node.textureRequestKey !== null) {
        this.loader.setPriority(node.textureRequestKey, priority);
      }
    }
  }

  /**
   * Drop loads for tiles the camera has left behind. Without this the frontier
   * stays saturated with work for airspace that is already kilometres astern.
   */
  abandonStale(): void {
    if (this.loading.size === 0) return;
    for (const node of this.loading) {
      if (this.frame - node.lastUsedFrame < ABANDON_AFTER_FRAMES) continue;
      this.withdraw(node);
      node.abort?.abort();
      node.abort = null;
      // Bump the generations: the abandoned continuations must not write their
      // outcome over whatever starts next for this node.
      if (node.geometryState === 'loading') {
        node.geometryGen++;
        node.geometryState = 'idle';
      }
      if (node.textureState === 'loading') {
        node.textureGen++;
        node.textureState = 'idle';
      }
      this.loading.delete(node);
    }
  }

  /**
   * Hand back this node's place in the loader queue.
   *
   * `node.abort` only stops *our* continuation. The loader holds its own
   * controller per request, so a tile the camera left behind minutes ago went
   * on downloading and went on occupying one of the loader's concurrency
   * slots. With a few hundred tiles a minute falling off the back of a moving
   * aircraft, that is the whole pipe — the ground ahead was queued behind
   * ground that no longer existed on screen.
   */
  withdraw(node: TileNode): void {
    if (node.geometryRequestKey !== null) {
      this.loader.cancel(node.geometryRequestKey);
      node.geometryRequestKey = null;
    }
    if (node.textureRequestKey !== null) {
      this.loader.cancel(node.textureRequestKey);
      node.textureRequestKey = null;
    }
  }







  /**
   * Start whatever this node still needs.
   *
   * A `failed` load is retried after a backoff rather than left alone for
   * ever. Tile hosts 500 and time out routinely, and the old code turned one
   * such blip into a tile that could never be refined into again — a blurry
   * patch that stayed blurry for the rest of the session however long the
   * aircraft circled over it.
   */
  ensureContent(node: TileNode): void {
    const wantGeometry =
      node.geometryState === 'idle' ||
      (node.geometryState === 'failed' && this.frame >= node.geometryRetryFrame);
    const wantTexture =
      node.textureState === 'idle' ||
      (node.textureState === 'failed' && this.frame >= node.textureRetryFrame);

    if (!wantGeometry && !wantTexture) return;

    // Added before the loads start, never after: `loadTexture` can finish
    // synchronously (a tile past the layer's max zoom resolves without ever
    // awaiting), and an add that lands after its `settle` would leave the node
    // in the frontier for ever, silently eating budget.
    this.loading.add(node);
    if (wantGeometry) void loadGeometry(node, this.context());
    if (wantTexture) void loadTexture(node, this.context());
    this.settle(node);
  }

  /**
   * Record the outcome of a load, unless a newer one has taken over.
   *
   * Every exit path goes through here, including the aborted ones. The old
   * code returned early on `signal.aborted` without settling, which left the
   * node in `this.loading` with its state wedged at `loading` — permanently
   * consuming frontier budget, and permanently unrefinable, because
   * `ensureContent` only ever restarts an `idle` load.
   */
  private finish(
    node: TileNode,
    kind: 'geometry' | 'texture',
    gen: number,
    outcome: 'ready' | 'aborted' | 'failed' | 'exhausted',
  ): void {
    if (kind === 'geometry') {
      if (node.geometryGen !== gen) return;
      if (outcome === 'failed') {
        node.geometryAttempts++;
        if (node.geometryAttempts >= MAX_LOAD_ATTEMPTS) node.geometryState = 'exhausted';
        else {
          node.geometryState = 'failed';
          node.geometryRetryFrame = this.frame + RETRY_BASE_FRAMES * 2 ** node.geometryAttempts;
        }
      } else {
        node.geometryState = outcome === 'aborted' ? 'idle' : outcome;
        if (outcome === 'ready') node.geometryAttempts = 0;
      }
    } else {
      if (node.textureGen !== gen) return;
      if (outcome === 'failed') {
        node.textureAttempts++;
        if (node.textureAttempts >= MAX_LOAD_ATTEMPTS) node.textureState = 'exhausted';
        else {
          node.textureState = 'failed';
          node.textureRetryFrame = this.frame + RETRY_BASE_FRAMES * 2 ** node.textureAttempts;
        }
      } else {
        node.textureState = outcome === 'aborted' ? 'idle' : outcome;
        if (outcome === 'ready') node.textureAttempts = 0;
      }
    }
    this.settle(node);
  }

  /** Leave the loading set once neither resource is still in flight. */
  settle(node: TileNode): void {
    if (node.geometryState !== 'loading' && node.textureState !== 'loading') {
      this.loading.delete(node);
    }
  }



}
