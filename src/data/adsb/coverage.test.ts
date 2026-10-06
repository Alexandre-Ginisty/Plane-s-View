import { describe, expect, it } from 'vitest';

import { haversineMetres, METRES_TO_NM } from '@/core/math/geo';
import { Coverage, planCells, shareableQuery } from './coverage';

/** Roughly the map, zoomed out over all of Africa. */
const africa = {
  lat: 2,
  lon: 20,
  radiusNm: 2600,
  bounds: { south: -35, west: -20, north: 37, east: 55 },
};

describe('planCells', () => {
  it('uses one circle, about the view radius, when the view fits in one', () => {
    const cells = planCells({ lat: 48.8, lon: 2.3, radiusNm: 90, bounds: { south: 47, west: 0, north: 50, east: 5 } }, 250, 36);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.radiusNm).toBe(120);
  });

  it('tiles a continental view instead of asking only for the centre', () => {
    const cells = planCells(africa, 250, 36);
    expect(cells).toHaveLength(36);
    // Nearest first: the first cell is the one under the centre of the screen.
    const first = cells[0]!;
    expect(haversineMetres(first.lat, first.lon, africa.lat, africa.lon) * METRES_TO_NM).toBeLessThan(250);
    for (const c of cells) expect(c.radiusNm).toBe(250);
  });

  it('asks every visitor of the same region for the same circles', () => {
    const a = planCells({ ...africa, lat: 2.03, lon: 19.96 }, 250, 500);
    const b = planCells({ ...africa, lat: 1.98, lon: 20.04 }, 250, 500);
    expect(new Set(a.map((c) => `${c.lat}/${c.lon}`))).toEqual(new Set(b.map((c) => `${c.lat}/${c.lon}`)));
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

describe('shareableQuery', () => {
  it('lands two nearby views on the same URL', () => {
    const a = shareableQuery({ lat: 48.8566, lon: 2.3522, radiusNm: 70 }, 250);
    const b = shareableQuery({ lat: 48.8412, lon: 2.3687, radiusNm: 72 }, 250);
    expect(a).toEqual(b);
  });

  it('always contains the circle it replaces', () => {
    for (let i = 0; i < 2000; i++) {
      const q = {
        lat: -80 + ((i * 37.17) % 160),
        lon: -180 + ((i * 91.31) % 360),
        radiusNm: 1 + ((i * 13.7) % 230),
      };
      const s = shareableQuery(q, 250);
      const moved = haversineMetres(q.lat, q.lon, s.lat, s.lon) * METRES_TO_NM;
      expect(moved + q.radiusNm, JSON.stringify(q)).toBeLessThanOrEqual(s.radiusNm + 1e-6);
      expect(s.radiusNm).toBeLessThanOrEqual(250);
    }
  });

  it('respects a lower cap from a weak link', () => {
    expect(shareableQuery({ lat: 10, lon: 10, radiusNm: 30 }, 40).radiusNm).toBeLessThanOrEqual(40);
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
    expect(coverage.next()).toEqual(planCells(africa, 250, 9)[0]);
  });

  it('restarts at the centre when the view moves, not when it is re-sent unchanged', () => {
    const coverage = new Coverage(africa, 250, 9);
    const first = coverage.next();
    coverage.next();
    coverage.setView({ ...africa });
    expect(coverage.next()).not.toEqual(first);

    const moved = { ...africa, lat: 10, bounds: { ...africa.bounds, south: -27, north: 45 } };
    coverage.setView(moved);
    expect(coverage.next()).toEqual(planCells(moved, 250, 9)[0]);
  });
});
