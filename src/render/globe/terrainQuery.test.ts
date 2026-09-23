/**
 * The descent is the difference between "the ground arrives" and "the ground
 * never arrives".
 *
 * `selectTiles` refines one level per round trip, so a camera near the ground
 * needing zoom 17 waits on fifteen of them in series. Measured from a tower
 * view on a tethered link, the globe was still at zoom 2 with an empty horizon
 * after several seconds. These tests pin the two properties that make the
 * shortcut worth having: it asks for every level at once, and it refuses to
 * do so when that would take bandwidth away from the visible ground.
 */

import { describe, expect, it } from 'vitest';

import { geodeticToEcef, tileKey, type Vec3 } from '@/core/math/geo';
import { DESCENT_PRIORITY, PREFETCH_QUEUE_LIMIT, ROOT_ZOOM } from './constants';
import { aimPoint, prefetchDescent } from './terrainQuery';
import type { TileMap } from './eviction';
import type { TileStreamer } from './streaming';

interface Ask {
  z: number;
  x: number;
  y: number;
  priority: number;
}

function fakeStreamer(queueDepth: number): { streamer: TileStreamer; asks: Ask[] } {
  const asks: Ask[] = [];
  const streamer = {
    queueDepth,
    prefetchTile(z: number, x: number, y: number, priority: number) {
      asks.push({ z, x, y, priority });
    },
  } as unknown as TileStreamer;
  return { streamer, asks };
}

/** Somewhere over the South Downs, where the spikes were found. */
const LAT = 50.8977;
const LON = -0.652;

describe('prefetchDescent', () => {
  it('asks for every level at once instead of one per round trip', () => {
    const { streamer, asks } = fakeStreamer(0);
    const seeded = prefetchDescent(streamer, new Map() as TileMap, LAT, LON, 17);

    // Every level below the root, in one call — that is the whole point.
    expect(seeded).toBe(17 - ROOT_ZOOM);
    expect(asks.map((a) => a.z)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('nests each level inside the one above it', () => {
    const { streamer, asks } = fakeStreamer(0);
    prefetchDescent(streamer, new Map() as TileMap, LAT, LON, 14);

    // A chain that does not nest is a chain pointing at the wrong ground.
    for (let i = 1; i < asks.length; i++) {
      const parent = asks[i - 1]!;
      const child = asks[i]!;
      expect(child.z, 'levels are consecutive').toBe(parent.z + 1);
      expect(child.x >> 1, `x at z${child.z}`).toBe(parent.x);
      expect(child.y >> 1, `y at z${child.z}`).toBe(parent.y);
    }
  });

  it('ranks shallower levels first, because that is the order the walk needs', () => {
    const { streamer, asks } = fakeStreamer(0);
    prefetchDescent(streamer, new Map() as TileMap, LAT, LON, 12);

    for (let i = 1; i < asks.length; i++) {
      expect(asks[i]!.priority).toBeGreaterThan(asks[i - 1]!.priority);
    }
    // And the whole chain sits behind every live tile, which tops out at
    // 19 999 out of `priorityOf` (two bands of 10 000).
    expect(asks[0]!.priority).toBeGreaterThan(DESCENT_PRIORITY);
  });

  it('skips levels already resident, so a second call is nearly free', () => {
    const nodes = new Map() as TileMap;
    const { streamer: first, asks: firstAsks } = fakeStreamer(0);
    prefetchDescent(first, nodes, LAT, LON, 12);

    // Everything it asked for has now arrived.
    for (const ask of firstAsks) {
      nodes.set(tileKey(ask.z, ask.x, ask.y), { contentReady: true } as never);
    }

    const { streamer: second, asks: secondAsks } = fakeStreamer(0);
    expect(prefetchDescent(second, nodes, LAT, LON, 12)).toBe(0);
    expect(secondAsks).toEqual([]);
  });

  it('refuses to speculate into a backlog', () => {
    // On a weak link every seeded tile is one the ground being looked at did
    // not get. Same rule the path prefetch follows.
    const { streamer, asks } = fakeStreamer(PREFETCH_QUEUE_LIMIT + 1);
    expect(prefetchDescent(streamer, new Map() as TileMap, LAT, LON, 17)).toBe(0);
    expect(asks).toEqual([]);
  });
});

describe('aimPoint', () => {
  /** Unit vector from the camera towards a geodetic point. */
  function towards(from: Vec3, lat: number, lon: number, h: number): Vec3 {
    const to = geodeticToEcef(lat, lon, h);
    const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    return [d[0] / len, d[1] / len, d[2] / len];
  }

  it('lands ahead of the camera, not underneath it', () => {
    // The whole point: on final approach the tile under the wheels is a few
    // pixels at the bottom of the screen and the ground being looked at is a
    // kilometre ahead. Seeding only the column underneath warmed the one
    // place nobody was looking.
    const cam = geodeticToEcef(51.47, -0.45, 200);
    const forward = towards(cam, 51.49, -0.45, 0); // north and down
    const aim = aimPoint(cam, { x: forward[0], y: forward[1], z: forward[2] }, 200);

    expect(aim).not.toBeNull();
    expect(aim!.lat).toBeGreaterThan(51.47);
  });

  it('clamps a level view to a usable range instead of the horizon', () => {
    // A ray parallel to the ground meets the plane at infinity. Unclamped
    // that seeds a column on the far side of the planet, which is both
    // useless and a wrap-around bug waiting to happen.
    const cam = geodeticToEcef(51.47, -0.45, 50);
    const north = towards(cam, 51.48, -0.45, 50); // level, due north
    const aim = aimPoint(cam, { x: north[0], y: north[1], z: north[2] }, 50);

    expect(aim).not.toBeNull();
    // 8 km at this latitude is well under a tenth of a degree of latitude.
    expect(Math.abs(aim!.lat - 51.47)).toBeLessThan(0.08);
    expect(aim!.lat).toBeGreaterThan(51.47);
  });

  it('still aims somewhere sensible from a standstill on the ground', () => {
    // Height above ground is zero on a runway, so the plane intersection is
    // at the camera itself. The floor is what keeps the seed useful there.
    const cam = geodeticToEcef(51.47, -0.45, 2);
    const north = towards(cam, 51.48, -0.45, 2);
    const aim = aimPoint(cam, { x: north[0], y: north[1], z: north[2] }, 0);

    expect(aim).not.toBeNull();
    expect(aim!.lat).toBeGreaterThan(51.47);
  });
});
