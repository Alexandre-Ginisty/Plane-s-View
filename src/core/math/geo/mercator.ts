/**
 * Web Mercator and the XYZ tile scheme.
 *
 * Every imagery and elevation source in this project is Web Mercator, which is
 * why the globe stops at ±85.05°: beyond that the projection runs to infinity
 * and there are no tiles to draw.
 *
 * Y runs **south** as it increases — the XYZ convention — while texture V runs
 * north. That single disagreement is the source of almost every "the terrain
 * is mirrored vertically" bug, which is why the flip lives in exactly one
 * place (`TileNode.uvInto`) and this module stays purely in tile space.
 */

import { DEG2RAD, MERCATOR_MAX_LAT, RAD2DEG, clamp, wrapLongitude } from './units';

// ---------------------------------------------------------------------------
// Web Mercator
// ---------------------------------------------------------------------------

/** Longitude -> normalised Mercator X in [0, 1]. */
export function lonToMercatorX(lonDeg: number): number {
  return (lonDeg + 180) / 360;
}

/** Latitude -> normalised Mercator Y in [0, 1], 0 at the north edge. */
export function latToMercatorY(latDeg: number): number {
  const lat = clamp(latDeg, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT) * DEG2RAD;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI);
}

export function mercatorXToLon(x: number): number {
  return x * 360 - 180;
}

export function mercatorYToLat(y: number): number {
  return (2 * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - Math.PI / 2) * RAD2DEG;
}

/** Tile key components. */
export interface TileCoord {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

/** Geographic extent of a tile, degrees. */
export interface TileBounds {
  readonly west: number;
  readonly east: number;
  readonly south: number;
  readonly north: number;
}

export function tileBounds(z: number, x: number, y: number): TileBounds {
  const n = 1 << z;
  return {
    west: mercatorXToLon(x / n),
    east: mercatorXToLon((x + 1) / n),
    north: mercatorYToLat(y / n),
    south: mercatorYToLat((y + 1) / n),
  };
}

/**
 * Geodetic centre of a tile.
 *
 * The centre in *Mercator* space, not the arithmetic mean of the tile's north
 * and south latitudes. Mercator stretches towards the poles, so the two
 * disagree by 2650 km at z1 and 856 km at z2, shrinking to metres past z10.
 *
 * This exists because the terrain worker builds every vertex relative to the
 * Mercator centre while the main thread used to place the resulting mesh at
 * the arithmetic one — the low-zoom fallback ring, drawn under everything
 * else, sat hundreds of kilometres from where its vertices were computed.
 * Both sides now call this, so they cannot drift apart again.
 */
export function tileCenterLatLon(z: number, x: number, y: number): { lat: number; lon: number } {
  const n = 1 << z;
  return {
    lat: mercatorYToLat((y + 0.5) / n),
    lon: mercatorXToLon((x + 0.5) / n),
  };
}

/** The tile containing a geodetic point at a given zoom. */
export function tileForLonLat(lonDeg: number, latDeg: number, z: number): TileCoord {
  const n = 1 << z;
  const x = clamp(Math.floor(lonToMercatorX(wrapLongitude(lonDeg)) * n), 0, n - 1);
  const y = clamp(Math.floor(latToMercatorY(latDeg) * n), 0, n - 1);
  return { z, x, y };
}

/** Stable string key for maps and IndexedDB. */
export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/**
 * Wrap a tile X index around the antimeridian. Tiles east of the last column
 * are the same imagery as column 0, which is what lets the globe be seamless.
 */
export function wrapTileX(x: number, z: number): number {
  const n = 1 << z;
  return ((x % n) + n) % n;
}
