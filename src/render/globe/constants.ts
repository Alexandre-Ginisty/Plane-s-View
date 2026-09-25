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

export const ROOT_ZOOM = 2;

/** Cross-fade for "own texture replaces inherited", seconds. */
export const TEXTURE_FADE_SEC = 0.9;
/** Fade-in for a tile entering the render set, seconds. */
export const TILE_FADE_SEC = 0.3;

/**
 * How much relief the terrain is built with; `boosted` is what the detail
 * switch turns on.
 *
 * ## Resolution is free detail, and most of it was being thrown away
 *
 * A Terrarium tile is 256x256 samples, and a 64-quad mesh keeps 65x65 of those
 * 65 536 elevations — six percent of a PNG already downloaded and decoded.
 * Raising the near grid to 128 keeps a quarter of them, for no bandwidth at
 * all: the single biggest gain available anywhere in the terrain.
 *
 * ## Exaggeration is not free, and is deliberate
 *
 * 1.45x vertical is a lie about the shape of the Earth, and every terrain
 * viewer tells it, because true scale is genuinely flat from the altitudes
 * this app spends its time at: from FL350 a 2 km alp subtends a third of a
 * degree against a hundred kilometres of ground.
 *
 * It is safe only because it is applied in *one* place. The worker bakes it
 * into the heights it returns, and those same heights are what `sampleHeight`
 * reports to everything else — where an aircraft sits on the ground, how far
 * the camera must be lifted to clear a hillside, when the undercarriage comes
 * down. Exaggerating in the shader instead would have broken all three.
 */
export type ReliefDetail = 'standard' | 'boosted';

export interface ReliefSettings {
  baseResolution: number;
  nearResolution: number;
  exaggeration: number;
  /** Shadow floor in the terrain shader; lower makes slopes read harder. */
  ambient: number;
}

export const RELIEF: Record<ReliefDetail, ReliefSettings> = {
  standard: { baseResolution: 32, nearResolution: 64, exaggeration: 1, ambient: 0.45 },
  boosted: { baseResolution: 48, nearResolution: 128, exaggeration: 1.45, ambient: 0.3 },
};

/** Highest terrain on Earth plus margin; used for conservative bounds. */
export const MAX_TERRAIN_M = 9000;
export const MIN_TERRAIN_M = -500;

/**
 * Maximum tiles allowed to be loading at once.
 *
 * Without a cap the quadtree explodes breadth-first: every tile wanting
 * refinement asks for four children, each asks for four more, and since a
 * parent only refines once *all four* exist, none of it completes. Measured,
 * the queue grew past 1 300 requests while the deepest rendered zoom stayed
 * pinned at 11 — the renderer starved by its own requests.
 *
 * The cap protects the *ordering*, not the network: `flushLoads` re-ranks by
 * screen-space error every frame and a tile already in flight cannot be
 * re-ranked. It sits comfortably above the loader's own concurrency so the
 * loader, not this, is what meters the link.
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
 * Floor for skirt depth, as a fraction of the tile's own diagonal.
 *
 * The worker sizes the real skirt from the tile's relief; this only guarantees
 * a minimum on flat terrain, where a hairline crack would otherwise show at an
 * LOD boundary.
 *
 * It used to be a flat 60 m, and a constant is the wrong shape for this: a
 * skirt bridges the height disagreement with a neighbour one level coarser,
 * and that scales with the tile. 60 m suits a z12 tile 15 km across and gives
 * a z19 tile 30 m across a wall twice its own width — the dark cliffs at the
 * tile joins when standing on a runway. 1/64 of the diagonal is one grid cell
 * of the near mesh, the largest step two adjacent levels can produce.
 */
const SKIRT_SPAN_FRACTION = 1 / 64;

/** Hard bounds on the skirt floor, metres. */
export const MIN_SKIRT_M = 1.5;
export const MAX_SKIRT_FLOOR_M = 120;

export function skirtFloorFor(spanMetres: number): number {
  const scaled = spanMetres * SKIRT_SPAN_FRACTION;
  return Math.min(MAX_SKIRT_FLOOR_M, Math.max(MIN_SKIRT_M, scaled));
}

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
 * Prefetched tiles are the one kind of request nothing withdraws: the quadtree
 * does not own them, so `abandonStaleLoads` never sees them. On a link that
 * cannot keep up that is unbounded growth — observed live, the queue climbing
 * 311 → 686 over forty seconds and still rising.
 *
 * Nothing is lost by skipping it: the tiles are requested for real when the
 * aircraft arrives, which is the behaviour prefetching optimises, not a
 * prerequisite for it.
 */
export const PREFETCH_QUEUE_LIMIT = 200;

/**
 * The yardstick the refinement test measures against: imagery texels.
 *
 * This used to be the *mesh* resolution — 32 quads a side — and that was the
 * most expensive mistake in the renderer. The mesh grid says how finely the
 * surface is approximated; the texture says how much picture a tile carries,
 * and what the viewer sees is almost entirely the second.
 *
 * Measured against the 32-cell grid with a 2.2 px target, the cockpit at FL360
 * demanded z17 directly below it. A z17 tile subtends 27 screen pixels at that
 * range, so its 256 texels were squeezed into a tenth of a pixel each —
 * sixty-four times the tiles for a picture identical to z14's. That is the
 * whole of "the ground never finishes loading".
 *
 * Divided against texels, the error reads as *screen pixels per imagery
 * texel*, so a target of 1 means "stop once the texture is at native
 * resolution". The √2 is because `spanMetres` is the diagonal while the 256
 * texels run along the side.
 */
export const REFINE_TEXELS = Math.round(256 * Math.SQRT2);

/**
 * Priority for the tiles seeded by the near-ground descent.
 *
 * Behind every live tile (`priorityOf` tops out around 18 000) and far ahead
 * of the speculative path prefetch at `PREFETCH_PRIORITY`. Within the descent
 * the shallower level goes first, because that is the order the quadtree walk
 * will ask for them in.
 */
export const DESCENT_PRIORITY = 100_000;

/**
 * Height above the terrain below which the level-by-level descent is too slow
 * to be acceptable, metres.
 *
 * The quadtree refines one level per round trip, so reaching zoom 17 from the
 * root costs fifteen *sequential* round trips. From altitude that is invisible
 * — the needed zoom is around 12 and the tree is already there. Near the ground
 * it is the whole experience: a tower view sat in an empty grey void with the
 * tree still at zoom 2 after several seconds.
 *
 * 4 km covers every approach, every circuit and everything on the ground,
 * without firing during cruise.
 */
export const DESCENT_TRIGGER_M = 4000;
