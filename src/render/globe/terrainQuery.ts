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

import { DEG2RAD, MERCATOR_MAX_LAT, clamp, latToMercatorY, lonToMercatorX, tileKey, wrapTileX } from '@/core/math/geo';
import { PREFETCH_PRIORITY, PREFETCH_QUEUE_LIMIT, ROOT_ZOOM } from './constants';
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
 * Rule 6, and the single most effective trick in the whole system: by the
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
