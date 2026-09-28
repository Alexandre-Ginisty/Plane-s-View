import { describe, expect, it } from 'vitest';

import { haversineMetres, METRES_TO_NM } from '@/core/math/geo';
import { Coverage, planCells } from './coverage';

/** Roughly the map, zoomed out over all of Africa. */
const africa = {
  lat: 2,
  lon: 20,
  radiusNm: 2600,
  bounds: { south: -35, west: -20, north: 37, east: 55 },
};

describe('planCells', () => {
  it('uses one circle, at the view radius, when the view fits in one', () => {
    const cells = planCells({ lat: 48.8, lon: 2.3, radiusNm: 90, bounds: { south: 47, west: 0, north: 50, east: 5 } }, 250, 36);
    expect(cells).toEqual([{ lat: 48.8, lon: 2.3, radiusNm: 90 }]);
  });

  it('tiles a continental view instead of asking only for the centre', () => {
    const cells = planCells(africa, 250, 36);
    expect(cells).toHaveLength(36);
    // Nearest first: the first cell is the centre of the screen.
    expect(cells[0]).toMatchObject({ lat: 2, lon: 20 });
    for (const c of cells) expect(c.radiusNm).toBe(250);
  });

  it('leaves no gap between neighbouring circles', () => {
    const cells = planCells(
      { lat: 0, lon: 20, radiusNm: 700, bounds: { south: -8, west: 12, north: 8, east: 28 } },
      250,
      500,
    );
    // Any point in the view must fall inside at least one circle.
    for (let lat = -8; lat <= 8; lat += 0.5) {
      for (let lon = 12; lon <= 28; lon += 0.5) {
        const covered = cells.some(
          (c) => haversineMetres(lat, lon, c.lat, c.lon) * METRES_TO_NM <= c.radiusNm + 1,
        );
        expect(covered, `${lat},${lon}`).toBe(true);
      }
    }
  });

  it('keeps longitudes in range across the antimeridian', () => {
    const cells = planCells(
      { lat: -17, lon: 178, radiusNm: 900, bounds: { south: -30, west: 165, north: -5, east: 191 } },
      250,
      100,
    );
    for (const c of cells) {
      expect(c.lon).toBeGreaterThanOrEqual(-180);
      expect(c.lon).toBeLessThanOrEqual(180);
    }
  });
});

describe('Coverage', () => {
  it('walks every cell before repeating, starting at the centre', () => {
    const coverage = new Coverage(africa, 250, 9);
    const seen = new Set<string>();
    for (let i = 0; i < 9; i++) {
      const c = coverage.next();
      seen.add(`${c?.lat},${c?.lon}`);
    }
    expect(seen.size).toBe(9);
    expect(coverage.next()).toMatchObject({ lat: 2, lon: 20 });
  });

  it('restarts at the centre when the view moves, not when it is re-sent unchanged', () => {
    const coverage = new Coverage(africa, 250, 9);
    coverage.next();
    coverage.next();
    coverage.setView({ ...africa });
    expect(coverage.next()?.lat).not.toBe(2);

    coverage.setView({ ...africa, lat: 10, bounds: { ...africa.bounds, south: -27, north: 45 } });
    expect(coverage.next()).toMatchObject({ lat: 10, lon: 20 });
  });
});
