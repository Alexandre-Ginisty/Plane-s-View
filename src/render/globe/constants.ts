/**
 * Quadtree tuning.
 *
 * Every number the globe's behaviour depends on, in one file, each with the
 * measurement or the failure that set it. They are gathered here rather than
 * left beside the code that reads them because most of them interact: the
 * frontier cap only makes sense against the loader's concurrency, the retry
 * backoff only against the attempt cap, the prefetch priority only against
 * what `priorityOf` returns for a live tile. Scattered through nine hundred
 * lines, those relationships were invisible and were broken twice.
 */

/** Zoom level of the root ring. */
export const ROOT_ZOOM = 2;

/** Cross-fade duration for "own texture replaces inherited", seconds. */
export const TEXTURE_FADE_SEC = 0.45;
/** Fade-in for a tile entering the render set, seconds. */
export const TILE_FADE_SEC = 0.3;

/** Highest terrain on Earth plus margin; used for conservative bounds. */
export const MAX_TERRAIN_M = 9000;
export const MIN_TERRAIN_M = -500;

/**
 * Maximum tiles allowed to be loading at once.
 *
 * Without a cap the quadtree explodes breadth-first: every visible tile that
 * wants refining asks for four children, each of which asks for four more, and
 * because a parent only refines once *all four* children exist, none of it
 * ever completes. Measured, the queue grew past 1 300 requests while the
 * deepest rendered zoom stayed pinned at 11 — the renderer was starved by its
 * own requests.
 *
 * Bounding the frontier and spending it worst-first means the tiles the viewer
 * is actually squinting at finish, the level refines, and the next ring
 * becomes reachable.
 *
 * The cap protects the *ordering*, not the network — `flushLoads` re-ranks by
 * screen-space error every frame, and a tile that is already in flight cannot
 * be re-ranked. Too high and we are back to committing the whole budget to
 * whatever looked worst several seconds ago; too low and the pipe sits idle.
 * This sits comfortably above the loader's own concurrency so the loader, not
 * this, is what meters the network.
 */
export const MAX_CONCURRENT_TILE_LOADS = 512;

/**
 * Floor on the obliquity term in the screen-space error.
 *
 * 1/6 caps the saving at six levels' worth of refinement for a tile seen
 * exactly edge-on. Lower starts stripping detail from terrain that is merely
 * ahead rather than truly at the horizon.
 */
export const MIN_OBLIQUITY = 1 / 6;

/**
 * Frames a tile may go unused before an in-flight load for it is abandoned.
 * A few seconds at 60 fps — long enough to survive a camera wobble, short
 * enough that flying away from an area stops paying for it.
 */
export const ABANDON_AFTER_FRAMES = 180;

/**
 * Floor for skirt depth, metres. The worker sizes the real skirt from the
 * tile's relief; this only guarantees a minimum on perfectly flat terrain,
 * where a hairline crack would otherwise show at an LOD boundary.
 */
export const MIN_SKIRT_M = 60;

export interface GlobeOptions {
  /** Target screen-space error in pixels. Lower is sharper and costlier. */
  maxScreenSpaceError?: number;
  /** Deepest zoom to refine to. Esri serves imagery to 19. */
  maxZoom?: number;
  /** Quads per tile side, far and near. */
  baseResolution?: number;
  nearResolution?: number;
  /** Vertical exaggeration; 1 is true scale. */
  exaggeration?: number;
  /** Upper bound on resident tiles. */
  maxResidentTiles?: number;
}

/**
 * `failed` is transient and retried with backoff; `exhausted` is terminal.
 *
 * Collapsing the two is what made a single 500 from a tile host leave a
 * permanent smear on the globe: nothing ever asked for that tile again.
 */
export type NodeState = 'idle' | 'loading' | 'ready' | 'failed' | 'exhausted';

/** Attempts before a tile's imagery or elevation is given up on for good. */
export const MAX_LOAD_ATTEMPTS = 4;

/** First retry delay after a failed load, frames; doubles per attempt. */
export const RETRY_BASE_FRAMES = 45;

/**
 * Priority handed to prefetch requests.
 *
 * Must be worse than any live tile's. `priorityOf` returns `z * 1000`, so the
 * old value of ~10 000 outranked everything from z11 up — every request for
 * the ground *under* the aircraft queued behind speculative tiles for airspace
 * a minute ahead. That inversion is most of what "the ground loads slowly"
 * was.
 */
export const PREFETCH_PRIORITY = 1_000_000;

/**
 * Queue depth past which speculation is abandoned for this cycle.
 *
 * Prefetched tiles are the one kind of request nothing ever withdraws: the
 * quadtree does not own them, so `abandonStaleLoads` never sees them and they
 * sit in the queue until they are served. On a link that cannot keep up that
 * is unbounded growth — observed live, the queue climbing 311 → 686 over forty
 * seconds and still rising, every one of those entries a guess about airspace
 * the aircraft may never reach.
 *
 * Speculative work has no business queueing behind a backlog of real work, so
 * past this depth the prefetch simply does not happen. Nothing is lost: the
 * tiles are requested for real when the aircraft arrives, which is the
 * behaviour prefetching was an optimisation of, not a prerequisite for.
 */
export const PREFETCH_QUEUE_LIMIT = 200;

/**
 * The yardstick the refinement test measures against: imagery texels.
 *
 * This used to be the *mesh* resolution — `baseResolution`, 32 quads a side —
 * and that was the single most expensive mistake in the renderer. The two
 * numbers answer different questions. The mesh grid says how finely the
 * terrain surface is approximated; the texture says how much picture a tile
 * actually carries. What the viewer sees is almost entirely the second.
 *
 * Measured against the 32-cell grid with a 2.2 px target, the cockpit at
 * FL360 demanded z17 directly below it. A z17 tile is 305 m across and
 * subtends 27 screen pixels at that range, so its 256 texels were being
 * squeezed into a tenth of a pixel each — eight times finer in each axis than
 * anything the screen could show, which is sixty-four times the tiles for a
 * picture identical to z14's. That is the whole of "the ground never finishes
 * loading": the quadtree was chasing a level of detail that is invisible by
 * construction, and spent the entire link never reaching the levels that
 * aren't.
 *
 * Divided against texels instead, the error reads directly as *screen pixels
 * per imagery texel*, so a target of 1 means "stop once the texture is at
 * native resolution" — the point past which refining changes nothing on
 * screen. The √2 is because `spanMetres` is the tile's diagonal while the 256
 * texels run along its side.
 */
export const REFINE_TEXELS = Math.round(256 * Math.SQRT2);
