/**
 * The tuning numbers that are functions rather than constants.
 *
 * `skirtFloorFor` is the only one, and it earns a test because the value it
 * replaced was a constant and the bug was the constant-ness itself: a skirt
 * depth that does not scale with the tile is either useless at low zoom or
 * grotesque at high zoom, and 60 m managed to be the second.
 */

import { describe, expect, it } from 'vitest';

import { MAX_SKIRT_FLOOR_M, MIN_SKIRT_M, skirtFloorFor } from './constants';

/** Diagonal span of a tile at this zoom, near the equator, metres. */
const spanAt = (z: number): number => (40_075_017 / (1 << z)) * Math.SQRT2;

describe('skirtFloorFor', () => {
  it('gives a runway-scale tile a runway-scale skirt', () => {
    // A zoom-19 tile is about 30 m across. The old flat 60 m floor hung a wall
    // twice the tile's own width off every edge, and standing on the ground is
    // exactly where you see it: the coarser neighbour is slightly higher, so
    // its surface is what shows, with this tile's skirt as a cliff beside it.
    const floor = skirtFloorFor(spanAt(19));
    expect(floor).toBeLessThan(5);
    expect(floor).toBeGreaterThanOrEqual(MIN_SKIRT_M);
  });

  it('still gives a continent-scale tile enough to bridge an LOD step', () => {
    // The other end. A zoom-8 tile is 150 km across and its neighbour one
    // level coarser can disagree with it by tens of metres, so the floor has
    // to stay large there — which is what the flat 60 m was right about.
    expect(skirtFloorFor(spanAt(8))).toBe(MAX_SKIRT_FLOOR_M);
  });

  it('grows monotonically with the tile', () => {
    for (let z = 19; z > 2; z--) {
      expect(skirtFloorFor(spanAt(z))).toBeLessThanOrEqual(skirtFloorFor(spanAt(z - 1)));
    }
  });

  it('never returns zero, whatever it is handed', () => {
    // A zero skirt is a hairline crack straight through to the sky at every
    // LOD boundary, and a degenerate span is reachable at the poles.
    expect(skirtFloorFor(0)).toBeGreaterThan(0);
    expect(skirtFloorFor(-1)).toBeGreaterThan(0);
  });
});
