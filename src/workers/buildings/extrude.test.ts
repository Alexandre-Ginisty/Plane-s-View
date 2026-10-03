import { describe, expect, it } from 'vitest';

import { extrudeBuildings } from './extrude';
import type { Footprint } from './mvt';

const square = (x: number, y: number, w: number, h: number): Float64Array => Float64Array.from([x, y, x + w, y, x + w, y + h, x, y + h]);
const foot = (rings: Float64Array[], height: number): Footprint => ({ rings, height, minHeight: 0, colour: null });

describe('extrudeBuildings', () => {
  it('gives houses pitched roofs that stay within their height', () => {
    // A street of them: the roof is not applied to every one, but to most.
    const houses = Array.from({ length: 30 }, (_, i) => foot([square(200 + (i % 6) * 120, 200 + Math.floor(i / 6) * 120, 40, 24)], 9));
    const b = extrudeBuildings(houses, 4096, 14, 8000, 5000);
    let top = -Infinity;
    let sloped = 0;
    for (let i = 0; i < b.positions.length / 3; i++) {
      top = Math.max(top, b.positions[i * 3 + 2]!);
      const nz = b.normals[i * 3 + 2]!;
      if (nz > 20 && nz < 120) sloped++;
    }
    expect(sloped).toBeGreaterThan(30 * 4);
    expect(top).toBeLessThanOrEqual(9.001);
    for (const i of b.indices) expect(i).toBeLessThan(b.positions.length / 3);
  });

  it('keeps a tall building flat-roofed', () => {
    const b = extrudeBuildings([foot([square(2000, 2000, 60, 60)], 60)], 4096, 14, 8000, 5000);
    for (let i = 0; i < b.positions.length / 3; i++) {
      const nz = b.normals[i * 3 + 2]!;
      expect(nz === 0 || nz === 127).toBe(true);
    }
  });

  it('draws no wall along the margin of the tile', () => {
    const inner = extrudeBuildings([foot([square(-60, 1000, 160, 60)], 20)], 4096, 14, 8000, 5000);
    // The part past x = 0 is clipped away: nothing is left west of the tile.
    const xs = Array.from({ length: inner.positions.length / 3 }, (_, i) => inner.positions[i * 3]!);
    const west = Math.min(...xs);
    const east = Math.max(...xs);
    expect(east - west).toBeLessThan(160 * 0.37);
  });
});
