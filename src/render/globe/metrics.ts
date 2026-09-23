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
 * Loader priority: shallower first, and a tile wanted *this* frame ahead of
 * one merely queued for later. Lower wins.
 *
 * Shallow-first is not an accident of the formula — it is the rule that makes
 * refinement possible at all. A z14 tile cannot be drawn until its z13 ancestor
 * exists to inherit a texture from, so funding depth before breadth produces a
 * queue full of tiles that cannot be used yet.
 */
export function priorityOf(node: TileNode, frame: number): number {
  return node.z * 1000 - (node.lastUsedFrame === frame ? 500 : 0);
}
