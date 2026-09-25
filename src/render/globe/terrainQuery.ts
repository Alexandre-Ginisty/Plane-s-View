/**
 * Reading the terrain, and getting ahead of it.
 *
 * Two operations that use the tile tree without changing it: sampling a height
 * from whatever is currently resident, and speculatively warming tiles the
 * aircraft is about to fly over.
 *
 * `sampleTerrainHeight` returning 0 for unloaded ground is a deliberate
 * choice, not a fallback: the camera controller uses it to stay above terrain,
 * and sea level is the right guess almost everywhere on Earth. Returning
 * `null` and making every caller handle it would trade a rare small error for
 * a common awkward one.
 */

import {
  DEG2RAD,
  MERCATOR_MAX_LAT,
  clamp,
  ecefToGeodetic,
  latToMercatorY,
  lonToMercatorX,
  tileKey,
  wrapTileX,
  type Vec3,
} from '@/core/math/geo';
import {
  DESCENT_PRIORITY,
  PREFETCH_PRIORITY,
  PREFETCH_QUEUE_LIMIT,
  ROOT_ZOOM,
} from './constants';
import type { TileMap } from './eviction';
import type { TileStreamer } from './streaming';
import type { TileNode } from './tileNode';

/**
 * Terrain height at a geodetic position, from the deepest resident tile.
 *
 * Used to keep the camera above the ground and to place the horizon. Returns
 * 0 (sea level) when nothing is loaded there yet, which is the right answer
 * far more often than not.
 */
export function sampleTerrainHeight(
  nodes: TileMap,
  maxZoom: number,
  latDeg: number,
  lonDeg: number,
): number {
  const mx = lonToMercatorX(lonDeg);
  const my = latToMercatorY(latDeg);

  let best: TileNode | null = null;
  // Walk down from the root containing this point to the deepest tile that
  // has heights.
  for (let z = ROOT_ZOOM; z <= maxZoom; z++) {
    const n = 1 << z;
    const x = clamp(Math.floor(mx * n), 0, n - 1);
    const y = clamp(Math.floor(my * n), 0, n - 1);
    const node = nodes.get(tileKey(z, x, y));
    if (!node?.heights) break;
    best = node;
  }

  if (!best?.heights) return 0;

  const n = 1 << best.z;
  const u = clamp(mx * n - best.x, 0, 1);
  const v = clamp(my * n - best.y, 0, 1);

  const w = best.gridWidth;
  const fx = u * (w - 1);
  const fy = v * (w - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, w - 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const h = best.heights;
  const h00 = h[y0 * w + x0]!;
  const h10 = h[y0 * w + x1]!;
  const h01 = h[y1 * w + x0]!;
  const h11 = h[y1 * w + x1]!;

  return (
    (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty
  );
}

/**
 * Warm the cache along a predicted path.
 *
 * Rule 7, and the single most effective trick in the whole system: by the
 * time the aircraft reaches a tile, it was requested tens of seconds ago and
 * is already on disk. What the user perceives as "never loading" is mostly
 * this.
 */
export function prefetchAlongPath(
  streamer: TileStreamer,
  maxZoom: number,
  latDeg: number,
  lonDeg: number,
  headingDeg: number,
  groundSpeedMs: number,
  secondsAhead: number,
  zoom: number,
): void {
  // `secondsAhead` of 0 is the connection profile saying "do not speculate":
  // on a weak link every prefetched tile is one the ground under the
  // aircraft did not get.
  if (groundSpeedMs < 10 || secondsAhead <= 0) return;

  // And never speculate into a backlog. See PREFETCH_QUEUE_LIMIT.
  if (streamer.queueDepth > PREFETCH_QUEUE_LIMIT) return;

  const distance = groundSpeedMs * secondsAhead;
  const steps = 4;
  const z = Math.min(zoom, maxZoom);

  for (let i = 1; i <= steps; i++) {
    const d = (distance * i) / steps;
    const bearing = headingDeg * DEG2RAD;
    // Flat-Earth step is fine over a minute of flight and far cheaper than
    // a great-circle solution for something this approximate.
    const dLat = (d * Math.cos(bearing)) / 111_320;
    const dLon =
      (d * Math.sin(bearing)) /
      (111_320 * Math.max(0.05, Math.cos(latDeg * DEG2RAD)));

    const lat = clamp(latDeg + dLat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT);
    const lon = lonDeg + dLon;

    const n = 1 << z;
    const tx = wrapTileX(Math.floor(lonToMercatorX(lon) * n), z);
    const ty = clamp(Math.floor(latToMercatorY(lat) * n), 0, n - 1);

    // Strictly behind every live tile: see PREFETCH_PRIORITY.
    streamer.prefetchTile(z, tx, ty, PREFETCH_PRIORITY + i);
  }
}

/**
 * Seed the whole zoom chain under one point, in parallel.
 *
 * ## The problem this solves
 *
 * `selectTiles` refines strictly one level at a time, and it refines a node
 * only once that node's own content has arrived. Reaching zoom 17 from the
 * root is therefore fifteen *sequential* round trips — request, wait, decode,
 * build, then look at the children and request again. On a 130 ms link that is
 * two seconds before the first request for the tile you actually want is even
 * sent, and in practice much worse, because each level is four tiles and the
 * frame budget is shared.
 *
 * From altitude nobody notices: the needed zoom is around 12 and the tree is
 * already there from the previous position. Near the ground, and above all the
 * instant the camera teleports into an aircraft, the tree has nothing nearby
 * and has to climb the whole way. Measured from a tower view, the globe sat at
 * zoom 2 with an empty grey horizon for several seconds.
 *
 * ## What this does
 *
 * Asks for the tile containing one point at *every* level at once. The
 * quadtree walk is unchanged and still descends a level at a time — but each
 * level's bytes are already in flight or on disk when it gets there, so the
 * fifteen round trips collapse into one, plus the cost of the decode chain.
 *
 * Nothing here selects or renders anything. It only warms the loader, whose
 * request keys are shared, so a real request issued later joins the same
 * promise instead of opening a second connection.
 */
export function prefetchDescent(
  streamer: TileStreamer,
  nodes: TileMap,
  latDeg: number,
  lonDeg: number,
  targetZoom: number,
): number {
  // Never speculate into a backlog: on a weak link these would be tiles the
  // ground the user is looking at did not get. Same rule as the path prefetch.
  if (streamer.queueDepth > PREFETCH_QUEUE_LIMIT) return 0;

  const mx = lonToMercatorX(lonDeg);
  const my = latToMercatorY(clamp(latDeg, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT));

  let seeded = 0;
  for (let z = ROOT_ZOOM + 1; z <= targetZoom; z++) {
    const n = 1 << z;
    const x = wrapTileX(Math.floor(mx * n), z);
    const y = clamp(Math.floor(my * n), 0, n - 1);

    // Already here: the walk will not be waiting on the network for this one.
    if (nodes.get(tileKey(z, x, y))?.contentReady) continue;

    // Shallower first — that is the order the walk will ask in, and a deep
    // tile is useless until its ancestors have let the walk reach it.
    streamer.prefetchTile(z, x, y, DESCENT_PRIORITY + z * 1000);
    seeded++;
  }
  return seeded;
}

/**
 * Where the camera is looking at the ground, approximately.
 *
 * Used to aim the near-ground descent seed at what the viewer is actually
 * looking at rather than at the tile under the wheels. Approximate on purpose:
 * this picks which tiles to warm, so being a few hundred metres out costs
 * nothing, and an exact ray-terrain intersection would cost a march over
 * heightmaps every time the camera moved.
 *
 * The ray is intersected with the horizontal plane through the terrain under
 * the camera, then the range is clamped. The clamps do the real work:
 *
 *  - **The floor** covers a camera on the ground or pointing at the horizon,
 *    where the plane intersection is at zero or at infinity respectively.
 *  - **The ceiling** stops a shallow look-down angle from seeding a column
 *    ten kilometres away, which is far enough that the deep levels there are
 *    not wanted at all — the screen-space error would never ask for them.
 */
const AIM_RANGE_MIN_M = 400;
const AIM_RANGE_MAX_M = 8000;
/** Shallowest look-down angle treated as pointing at the ground, as a sine. */
const AIM_MIN_DEPRESSION = 0.05;

export function aimPoint(
  camEcef: Vec3,
  forward: { x: number; y: number; z: number },
  aglM: number,
): { lat: number; lon: number } | null {
  const camLen = Math.hypot(camEcef[0], camEcef[1], camEcef[2]);
  if (camLen === 0) return null;

  // Geocentric up. It differs from the geodetic normal by at most ~0.19deg,
  // which is irrelevant when the result is clamped to the nearest few hundred
  // metres.
  const ux = camEcef[0] / camLen;
  const uy = camEcef[1] / camLen;
  const uz = camEcef[2] / camLen;

  const depression = -(forward.x * ux + forward.y * uy + forward.z * uz);
  const range = clamp(
    Math.max(aglM, 0) / Math.max(depression, AIM_MIN_DEPRESSION),
    AIM_RANGE_MIN_M,
    AIM_RANGE_MAX_M,
  );

  return ecefToGeodetic(
    camEcef[0] + forward.x * range,
    camEcef[1] + forward.y * range,
    camEcef[2] + forward.z * range,
  );
}
