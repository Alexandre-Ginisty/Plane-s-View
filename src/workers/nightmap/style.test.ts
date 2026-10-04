import { describe, expect, it } from 'vitest';

import { coveringTiles, levelBounds, NIGHT_LEVELS } from './levels';
import { aerowayStyle, landuseStyle, pointsAlong, roadStyle, thinLineGain } from './style';

describe('what is lit', () => {
  it('lights roads by class, brightest for the main ones', () => {
    expect(roadStyle('motorway')!.warm).toBeGreaterThan(roadStyle('minor')!.warm);
    expect(roadStyle('primary')!.widthM).toBeGreaterThan(roadStyle('service')!.widthM);
  });

  it('leaves paths, tracks, rail and unbuilt roads dark', () => {
    for (const kind of ['path', 'track', 'rail', 'motorway_construction', 'primary_proposed', '']) {
      expect(roadStyle(kind), kind).toBeNull();
    }
  });

  it('makes runways the brightest, coolest light', () => {
    const runway = aerowayStyle('runway')!;
    expect(runway.cool).toBe(1);
    expect(runway.cool).toBeGreaterThan(roadStyle('motorway')!.cool);
    expect(aerowayStyle('aerodrome')).toBeNull();
  });

  it('lights built-up land but not parks, farmland or forest', () => {
    expect(landuseStyle('commercial')).not.toBeNull();
    expect(landuseStyle('industrial')!.cool).toBeGreaterThan(0);
    for (const kind of ['park', 'farmland', 'wood', 'cemetery', 'grass', '']) {
      expect(landuseStyle(kind), kind).toBeNull();
    }
  });
});

describe('thin lines', () => {
  it('draws a line as bright as it is wide, up to a full texel', () => {
    expect(thinLineGain(100, 10)).toBe(1);
    expect(thinLineGain(7, 100)).toBeLessThan(thinLineGain(7, 20));
    expect(thinLineGain(7, 100)).toBeGreaterThan(0.1);
  });
});

describe('pointsAlong', () => {
  it('spaces points evenly along a straight line', () => {
    const pts = pointsAlong([0, 0, 100, 0], 25);
    expect(pts.map((p) => p[0])).toEqual([12.5, 37.5, 62.5, 87.5]);
    expect(pts.every((p) => p[1] === 0)).toBe(true);
  });

  it('carries the spacing round a corner', () => {
    const pts = pointsAlong([0, 0, 30, 0, 30, 30], 20);
    // 10 along the first leg, 30 total to the corner, then 10 + 20 further.
    expect(pts[0]).toEqual([10, 0]);
    expect(pts[1]![0]).toBeCloseTo(30);
    expect(pts[1]![1]).toBeCloseTo(0, 5);
    expect(pts.length).toBeGreaterThanOrEqual(3);
  });

  it('gives nothing for a degenerate path', () => {
    expect(pointsAlong([5, 5], 10)).toEqual([]);
    expect(pointsAlong([5, 5, 5, 5], 10)).toEqual([]);
  });
});

describe('the levels', () => {
  it('get finer as they get smaller', () => {
    const texel = NIGHT_LEVELS.map((l) => (l.spanKm * 1000) / l.px);
    expect(texel).toEqual([...texel].sort((a, b) => b - a));
    expect(NIGHT_LEVELS.map((l) => l.zoom)).toEqual([...NIGHT_LEVELS.map((l) => l.zoom)].sort((a, b) => a - b));
  });

  it('are square on the ground at any latitude', () => {
    for (const lat of [0, 48.86, 70]) {
      const b = levelBounds(NIGHT_LEVELS[1]!, lat, 10);
      const northSouthKm = (b.north - b.south) * 111.32;
      const eastWestKm = (b.east - b.west) * 111.32 * Math.cos((lat * Math.PI) / 180);
      expect(eastWestKm / northSouthKm).toBeCloseTo(1, 1);
    }
  });

  it('never cross the antimeridian', () => {
    const b = levelBounds(NIGHT_LEVELS[0]!, 0, 179.9);
    expect(b.east).toBeLessThanOrEqual(180);
  });

  it('are covered by a handful of vector tiles, not hundreds', () => {
    for (const level of NIGHT_LEVELS) {
      const tiles = coveringTiles(levelBounds(level, 48.86, 2.34), level.zoom);
      expect(tiles.length, `z${level.zoom}`).toBeGreaterThan(0);
      expect(tiles.length, `z${level.zoom}`).toBeLessThanOrEqual(36);
    }
  });
});
