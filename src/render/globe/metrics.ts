/**
 * Quadtree metrics.
 *
 * Every geometric judgement the globe makes about a tile — how far away it is,
 * whether it can be seen, how wrong it currently looks, which heightmap covers
 * it, how urgently it is wanted. All pure, all free functions.
 *
 * They were methods on `Globe` and that was the problem: each one is a small
 * piece of arithmetic with a subtle sign or axis convention that is easy to get
 * plausibly wrong (the obliquity floor, the horizon dot product, the Terrarium
 * sub-rectangle), and none of them was reachable from a test while it lived
 * behind a class that needs a WebGL context and a worker pool to construct.
 * Out here they are the most heavily tested part of the renderer.
 */

import { Frustum, Sphere } from 'three';

import type { Vec3 } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import { TERRARIUM } from '@/tiles/sources';
import { MIN_OBLIQUITY } from './constants';
import type { TileNode } from './tileNode';

/** The sub-rectangle of a heightmap a tile occupies, in [0,1] tile space. */
export interface SampleRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ElevationRequest {
  z: number;
  x: number;
  y: number;
  rect: SampleRect;
}

/**
 * Straight-line distance from the camera to a tile's surface, metres.
 *
 * Measured against `lodRadius`, the tile's sea-level footprint — not
 * `boundingRadius`, which is inflated by the planet's full terrain envelope so
 * that culling never clips a mountain. Subtracting 9.5 km of hypothetical
 * Himalaya from an 11 km cruise altitude is what made every tile report itself
 * five times closer than it was.
 */
export function distanceTo(node: TileNode, camEcef: Vec3): number {
  const dx = camEcef[0] - node.centerEcef[0];
  const dy = camEcef[1] - node.centerEcef[1];
  const dz = camEcef[2] - node.centerEcef[2];
  return Math.max(1, Math.hypot(dx, dy, dz) - node.lodRadius);
}

/**
 * Screen-space error: how many screen pixels one of this tile's texels covers.
 *
 * Returned rather than compared, because the same number does two jobs — it
 * decides whether to refine, and it ranks the load frontier. A tile drawn in
 * place of its children *is* the error the viewer is looking at.
 *
 * `resolution` is what the tile's content is measured in, and it must be the
 * imagery texel count (`REFINE_TEXELS`), not the mesh grid. Passing the grid
 * made the number read as pixels per *terrain quad*, which is eight times
 * finer and sent the quadtree chasing three levels of detail the screen
 * cannot resolve. See `REFINE_TEXELS`.
 *
 * So 1 means "each texel covers one pixel" — native resolution, the point
 * past which refining is invisible. Above 1 the imagery is being magnified
 * and the tile genuinely looks soft.
 */
export function screenSpaceError(
  node: TileNode,
  camEcef: Vec3,
  sseScale: number,
  resolution: number,
): number {
  const dx = camEcef[0] - node.centerEcef[0];
  const dy = camEcef[1] - node.centerEcef[1];
  const dz = camEcef[2] - node.centerEcef[2];
  const distance = distanceTo(node, camEcef);

  // Ground size of one unit of the tile's content — one texel.
  const geometricError = node.spanMetres / resolution;

  // Obliquity. Distance alone says a tile near the horizon needs as much
  // detail as the one directly below at the same range, which is false: seen
  // almost edge-on it is foreshortened into a handful of vertical pixels.
  // From a cockpit at FL420 that mistake is most of the bill — the whole
  // ground plane out to the horizon refines to full depth to produce a band
  // of pixels a thumbnail could cover.
  //
  // `centerEcef` normalised is the *geocentric* normal, not the geodetic one
  // WGS84 would give; they differ by at most ~0.19deg. That matters when
  // placing geometry and not at all when weighting a cosine, so it is not
  // worth the extra trig here.
  const len = Math.hypot(dx, dy, dz) || 1;
  const nl = Math.hypot(node.centerEcef[0], node.centerEcef[1], node.centerEcef[2]) || 1;
  const cosIncidence = Math.abs(
    (dx * node.centerEcef[0] + dy * node.centerEcef[1] + dz * node.centerEcef[2]) /
      (len * nl),
  );

  // Floored, not raw: a grazing tile still carries detail *across* the view
  // even when it carries almost none up it, and a factor that reaches zero
  // would freeze the horizon at z2 forever.
  const obliquity = Math.max(cosIncidence, MIN_OBLIQUITY);

  return (geometricError * sseScale * obliquity) / distance;
}

/**
 * Elevation request for a tile.
 *
 * Terrarium stops at zoom 15. Deeper tiles reuse their z15 ancestor's
 * heightmap and sample the sub-rectangle they occupy within it, which keeps
 * the terrain continuous across the boundary instead of flattening abruptly.
 */
export function elevationRequest(node: TileNode): ElevationRequest {
  if (node.z <= TERRARIUM.maxZoom) {
    return { z: node.z, x: node.x, y: node.y, rect: { x0: 0, y0: 0, x1: 1, y1: 1 } };
  }

  const f = 1 << (node.z - TERRARIUM.maxZoom);
  const ax = Math.floor(node.x / f);
  const ay = Math.floor(node.y / f);
  const scale = 1 / f;
  return {
    z: TERRARIUM.maxZoom,
    x: ax,
    y: ay,
    rect: {
      x0: node.x / f - ax,
      y0: node.y / f - ay,
      x1: node.x / f - ax + scale,
      y1: node.y / f - ay + scale,
    },
  };
}

/** Frustum plus horizon culling. */
export function isTileVisible(
  node: TileNode,
  camEcef: Vec3,
  frustum: Frustum,
  origin: FloatingOrigin,
  scratch: Sphere,
): boolean {
  scratch.center.set(
    node.centerEcef[0] - origin.current[0],
    node.centerEcef[1] - origin.current[1],
    node.centerEcef[2] - origin.current[2],
  );
  scratch.radius = node.boundingRadius;

  if (!frustum.intersectsSphere(scratch)) return false;

  // Horizon test: a tile on the far side of the planet is inside the frustum
  // but occluded by the Earth. Without this the whole back hemisphere is
  // selected, refined and downloaded — a very expensive invisible mistake.
  const dot =
    camEcef[0] * node.centerEcef[0] +
    camEcef[1] * node.centerEcef[1] +
    camEcef[2] * node.centerEcef[2];

  const tileRadiusSq =
    node.centerEcef[0] ** 2 + node.centerEcef[1] ** 2 + node.centerEcef[2] ** 2;
  const camLen = Math.hypot(camEcef[0], camEcef[1], camEcef[2]);

  return dot + node.boundingRadius * camLen >= tileRadiusSq;
}

/**
 * Loader priority: worst-looking tile first. Lower wins.
 *
 * ## Why this is not ranked by zoom
 *
 * It used to be `z * 1000`, on the reasoning that a z14 tile cannot be drawn
 * until its z13 ancestor exists to inherit a texture from, so breadth must be
 * funded before depth. The reasoning is sound and the implementation of it was
 * the single worst scheduling bug in the renderer, because **the walk already
 * enforces that ordering structurally**: `selectTiles` only creates and
 * requests a node's children once that node is `contentReady`. A child can
 * never be asked for before its parent has arrived, whatever the priority says.
 *
 * So ranking by zoom bought nothing and cost this: a z12 tile at the horizon
 * scored 12 000 and a z18 tile directly under the aircraft scored 18 000, so
 * **every tile of the distant ground outranked the ground being looked at**,
 * at every level, for as long as the horizon kept producing work — which it
 * always does. The near column had to wait out the entire breadth of the view
 * six times over to descend six levels. That is most of "it never loads when
 * I am close".
 *
 * ## What it ranks by instead
 *
 * The screen-space error the tile is currently showing: how wrong the picture
 * looks right now, in screen pixels per imagery texel. The same number that
 * decides whether to refine, which is the point — the most urgent tile is by
 * definition the one whose absence is most visible.
 *
 * This restores shallow-first *within a column* for free, and for the right
 * reason rather than by decree: a coarse tile covering nearby ground has an
 * enormous error (its texels are metres wide a hundred metres from the eye)
 * and a deep one has a small error by construction, since the walk stopped
 * refining when the error reached the target. Measured from 100 m AGL, the z14
 * tile underneath scores ~9 450 and the z19 tile underneath ~0.9, so the chain
 * is still funded from the top down — while the z12 tile at the horizon scores
 * ~0.06 and no longer jumps the queue ahead of either.
 */

/** Width of one priority band. Live tiles occupy [0, BAND), off-screen the next. */
const PRIORITY_BAND = 10_000;

/**
 * Screen error at which a tile is considered maximally urgent.
 *
 * Errors run from ~1 (at the refinement target) to several thousand for a root
 * tile seen from the ground, and the top of that range is not worth resolving:
 * everything above it is "unusably coarse" and the ordering between two such
 * tiles does not matter.
 */
const MAX_USEFUL_ERROR = 1_000;

export function priorityOf(node: TileNode, frame: number): number {
  const urgency = Math.min(Math.max(node.screenError, 0), MAX_USEFUL_ERROR) / MAX_USEFUL_ERROR;

  // Off-screen work sits in its own band below every live tile, rather than
  // competing with it on error: a tile the camera turned away from is not
  // urgent however wrong it looks, but it is still worth finishing before a
  // speculative prefetch.
  const band = node.onScreenFrame === frame ? 0 : PRIORITY_BAND;

  return band + Math.round((1 - urgency) * (PRIORITY_BAND - 1));
}
