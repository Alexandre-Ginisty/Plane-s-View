import { describe, expect, it } from 'vitest';

import { GROUND_LEVELS, groundAerowayAreaRgb, groundAerowayStyle, groundRoadStyle, roofColour } from './ground';
import { makeProjector } from './project';

describe('ground roads', () => {
  it('draws wider roads wider and later, so a motorway lies over a lane', () => {
    const motorway = groundRoadStyle('motorway')!;
    const minor = groundRoadStyle('minor')!;
    const service = groundRoadStyle('service')!;
    expect(motorway.widthM).toBeGreaterThan(minor.widthM);
    expect(minor.widthM).toBeGreaterThan(service.widthM);
    expect(motorway.rank).toBeGreaterThan(minor.rank);
    expect(minor.rank).toBeGreaterThan(service.rank);
  });

  it('leaves out what is not built or not a road', () => {
    expect(groundRoadStyle('motorway_construction')).toBeNull();
    expect(groundRoadStyle('primary_proposed')).toBeNull();
    expect(groundRoadStyle('path')).toBeNull();
    expect(groundRoadStyle('')).toBeNull();
  });

  it('draws a runway wider and later than any road', () => {
    const runway = groundAerowayStyle('runway')!;
    expect(runway.widthM).toBeGreaterThan(groundRoadStyle('motorway')!.widthM);
    expect(runway.rank).toBeGreaterThan(groundRoadStyle('motorway')!.rank);
    expect(groundAerowayStyle('gate')).toBeNull();
  });

  it('paints aprons and helipads, and nothing else on the airfield', () => {
    expect(groundAerowayAreaRgb('apron')).not.toBeNull();
    expect(groundAerowayAreaRgb('helipad')).not.toBeNull();
    expect(groundAerowayAreaRgb('terminal')).toBeNull();
  });
});

describe('roof colour', () => {
  it('is the same every time for the same building', () => {
    expect(roofColour(12345)).toEqual(roofColour(12345));
  });

  it('varies from one building to the next', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(roofColour(i * 7919).join(','));
    expect(seen.size).toBeGreaterThan(3);
  });

  it('is a valid colour for a negative or fractional seed', () => {
    for (const seed of [-1, -123456.7, 0.5, 2 ** 40]) {
      for (const c of roofColour(seed)) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('ground levels', () => {
  it('go from coarse and wide to fine and narrow', () => {
    for (let i = 1; i < GROUND_LEVELS.length; i++) {
      expect(GROUND_LEVELS[i]!.spanKm).toBeLessThan(GROUND_LEVELS[i - 1]!.spanKm);
      expect(GROUND_LEVELS[i]!.maxAglM).toBeLessThanOrEqual(GROUND_LEVELS[i - 1]!.maxAglM);
    }
  });

  it('draw buildings only from a vector zoom that has them', () => {
    for (const level of GROUND_LEVELS) if (level.footprints) expect(level.zoom).toBeGreaterThanOrEqual(14);
  });
});

describe('projector', () => {
  const bounds = { south: 0, north: 1, west: 0, east: 1 };

  it('puts the corners of the square on the corners of the canvas', () => {
    // Tile 0/0/0 spans the whole world; with extent 4096, tile units 0..4096 are lon -180..180.
    const p = makeProjector(4096, 0, { x: 0, y: 0 }, { south: -85, north: 85, west: -180, east: 180 }, 1000);
    const [x0, y0, x1, y1] = p.toPx(Float64Array.of(0, 0, 4096, 4096));
    expect(x0).toBeCloseTo(0, 5);
    expect(x1).toBeCloseTo(1000, 5);
    expect(y0).toBeLessThan(y1!);
  });

  it('knows whether a path touches the canvas', () => {
    const p = makeProjector(4096, 0, { x: 0, y: 0 }, bounds, 100);
    expect(p.visible([10, 10, 20, 20])).toBe(true);
    expect(p.visible([-50, 10, -10, 20])).toBe(false);
    expect(p.visible([-50, 10, 150, 20])).toBe(true);
  });
});
