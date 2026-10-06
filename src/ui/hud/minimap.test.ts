import { describe, expect, it } from 'vitest';

import { autoZoom, coverTiles, mercator, metresPerPixel } from './minimap';

describe('mercator', () => {
  it('puts null island in the middle of the world', () => {
    expect(mercator(0, 0)).toEqual([0.5, 0.5]);
  });

  it('agrees with the slippy-map tile of a known place', () => {
    // Paris, zoom 10: tile 518/352.
    const [x, y] = mercator(48.8566, 2.3522);
    expect(Math.floor(x * 1024)).toBe(518);
    expect(Math.floor(y * 1024)).toBe(352);
  });
});

describe('coverTiles', () => {
  it('covers the whole window with tiles that meet edge to edge', () => {
    const tiles = coverTiles(mercator(48.72, 2.38), 11.4, 236, 164, 1, 19);
    expect(tiles.every((t) => t.z === 12)).toBe(true);
    const lefts = [...new Set(tiles.map((t) => t.left))].sort((a, b) => a - b);
    const tops = [...new Set(tiles.map((t) => t.top))].sort((a, b) => a - b);
    expect(lefts[0]).toBeLessThanOrEqual(0);
    expect(tops[0]).toBeLessThanOrEqual(0);
    for (const t of tiles) {
      const right = tiles.find((u) => u.y === t.y && u.left === t.left + t.size);
      if (t.left + t.size < 236) expect(right).toBeDefined();
    }
    const last = tiles.reduce((a, b) => (b.left + b.size > a.left + a.size ? b : a));
    expect(last.left + last.size).toBeGreaterThanOrEqual(236);
  });

  it('never asks deeper than the source serves, enlarging instead', () => {
    const tiles = coverTiles(mercator(10, 10), 15.5, 200, 200, 1, 14);
    expect(tiles.every((t) => t.z === 14)).toBe(true);
    expect(tiles[0]!.size).toBeGreaterThan(256);
  });

  it('wraps across the antimeridian', () => {
    const tiles = coverTiles(mercator(0, 179.99), 4, 300, 100, 0, 19);
    expect(tiles.some((t) => t.x === 0)).toBe(true);
    expect(tiles.some((t) => t.x === 15)).toBe(true);
    expect(new Set(tiles.map((t) => t.key)).size).toBe(tiles.length);
  });
});

describe('autoZoom', () => {
  const span = (altFt: number): number => (metresPerPixel(autoZoom(altFt, 45, 240), 45) * 240) / 1000;

  it('shows the airport on the ground and a wide area from cruise', () => {
    expect(span(0)).toBeCloseTo(3, 0);
    expect(span(35000)).toBeGreaterThan(120);
    expect(span(35000)).toBeLessThan(200);
  });

  it('widens steadily with altitude', () => {
    expect(span(1000)).toBeLessThan(span(5000));
    expect(span(5000)).toBeLessThan(span(20000));
  });

  it('takes the visitor’s adjustment in whole zoom levels', () => {
    expect(autoZoom(3000, 45, 240, 1) - autoZoom(3000, 45, 240)).toBeCloseTo(1, 6);
  });
});
