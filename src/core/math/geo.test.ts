import { describe, expect, it } from 'vitest';
import {
  ecefToGeodetic,
  geodeticToEcef,
  geodeticSurfaceNormal,
  haversineMetres,
  initialBearingDeg,
  destinationPoint,
  latToMercatorY,
  lonToMercatorX,
  mercatorYToLat,
  metresPerDegree,
  tileBounds,
  tileCenterLatLon,
  tileForLonLat,
  angleDeltaDeg,
  wrapLongitude,
  WGS84_A,
  WGS84_B,
} from './geo';

describe('geodetic <-> ECEF', () => {
  it('places the equator/prime-meridian point on the +X axis', () => {
    const [x, y, z] = geodeticToEcef(0, 0, 0);
    expect(x).toBeCloseTo(WGS84_A, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it('places the north pole on the +Z axis at the polar radius', () => {
    const [x, y, z] = geodeticToEcef(90, 0, 0);
    expect(Math.hypot(x, y)).toBeLessThan(1e-6);
    expect(z).toBeCloseTo(WGS84_B, 6);
  });

  it('round-trips a spread of positions to sub-millimetre accuracy', () => {
    const cases: Array<[number, number, number]> = [
      [48.8584, 2.2945, 330],       // Eiffel Tower
      [-33.8568, 151.2153, 5],      // Sydney
      [64.1466, -21.9426, 61],      // Reykjavik
      [-89.9, 179.9, 2800],         // near the south pole
      [0.0001, -179.9999, 11000],   // near the antimeridian, cruise altitude
      [27.9881, 86.925, 8849],      // Everest
    ];

    for (const [lat, lon, h] of cases) {
      const [x, y, z] = geodeticToEcef(lat, lon, h);
      const back = ecefToGeodetic(x, y, z);
      expect(back.lat).toBeCloseTo(lat, 9);
      expect(wrapLongitude(back.lon - lon)).toBeCloseTo(0, 9);
      expect(back.height).toBeCloseTo(h, 3);
    }
  });

  it('gives a surface normal that is not the normalised position vector', () => {
    // On an ellipsoid these differ everywhere except the equator and poles;
    // using the wrong one tilts the horizon in the cockpit view.
    const lat = 45;
    const normal = geodeticSurfaceNormal(lat, 0);
    const p = geodeticToEcef(lat, 0, 0);
    const len = Math.hypot(p[0], p[1], p[2]);
    const radial: [number, number, number] = [p[0] / len, p[1] / len, p[2] / len];

    const dot = normal[0] * radial[0] + normal[1] * radial[1] + normal[2] * radial[2];
    const angleDeg = (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
    // The classic maximum deviation is ~0.19 degrees at 45 degrees latitude.
    expect(angleDeg).toBeGreaterThan(0.15);
    expect(angleDeg).toBeLessThan(0.25);
  });

  it('keeps the normal a unit vector', () => {
    for (const lat of [-90, -45, 0, 33.3, 89.99]) {
      const n = geodeticSurfaceNormal(lat, 12.5);
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 12);
    }
  });
});

describe('great-circle helpers', () => {
  it('measures a known distance', () => {
    // Paris CDG -> New York JFK, ~5837 km.
    const d = haversineMetres(49.0097, 2.5479, 40.6413, -73.7781);
    expect(d / 1000).toBeGreaterThan(5800);
    expect(d / 1000).toBeLessThan(5880);
  });

  it('returns zero for identical points', () => {
    expect(haversineMetres(10, 20, 10, 20)).toBeCloseTo(0, 6);
  });

  it('bears due east along the equator', () => {
    expect(initialBearingDeg(0, 0, 0, 10)).toBeCloseTo(90, 6);
  });

  it('bears due north along a meridian', () => {
    expect(initialBearingDeg(10, 5, 20, 5)).toBeCloseTo(0, 6);
  });

  it('round-trips destination against distance and bearing', () => {
    const start = { lat: 51.5, lon: -0.12 };
    const dest = destinationPoint(start.lat, start.lon, 73, 250_000);
    expect(haversineMetres(start.lat, start.lon, dest.lat, dest.lon)).toBeCloseTo(250_000, 0);
    expect(initialBearingDeg(start.lat, start.lon, dest.lat, dest.lon)).toBeCloseTo(73, 4);
  });

  it('crosses the antimeridian without a discontinuity', () => {
    const d = haversineMetres(0, 179.9, 0, -179.9);
    // 0.2 degrees at the equator is ~22 km, not most of the way round the world.
    expect(d).toBeLessThan(25_000);
  });
});

describe('web mercator', () => {
  it('maps the corners of the world to the unit square', () => {
    expect(lonToMercatorX(-180)).toBeCloseTo(0, 12);
    expect(lonToMercatorX(180)).toBeCloseTo(1, 12);
    expect(latToMercatorY(85.051128779806604)).toBeCloseTo(0, 9);
    expect(latToMercatorY(-85.051128779806604)).toBeCloseTo(1, 9);
    expect(latToMercatorY(0)).toBeCloseTo(0.5, 12);
  });

  it('round-trips latitude through the projection', () => {
    for (const lat of [-84, -45.5, -0.001, 0, 17.3, 60, 85]) {
      expect(mercatorYToLat(latToMercatorY(lat))).toBeCloseTo(lat, 9);
    }
  });

  it('clamps beyond the mercator limit instead of producing infinity', () => {
    expect(Number.isFinite(latToMercatorY(90))).toBe(true);
    expect(Number.isFinite(latToMercatorY(-90))).toBe(true);
  });

  it('selects the tile that contains the point', () => {
    const z = 12;
    const lat = 48.8584;
    const lon = 2.2945;
    const t = tileForLonLat(lon, lat, z);
    const b = tileBounds(t.z, t.x, t.y);

    expect(lon).toBeGreaterThanOrEqual(b.west);
    expect(lon).toBeLessThanOrEqual(b.east);
    expect(lat).toBeGreaterThanOrEqual(b.south);
    expect(lat).toBeLessThanOrEqual(b.north);
  });

  it('keeps tile indices in range at the extremes', () => {
    for (const z of [0, 1, 8, 15]) {
      const n = 1 << z;
      for (const [lon, lat] of [[-180, 90], [180, -90], [179.999, -89.999]] as const) {
        const t = tileForLonLat(lon, lat, z);
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.x).toBeLessThan(n);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeLessThan(n);
      }
    }
  });

  it('tiles the world exactly at zoom 1', () => {
    const nw = tileBounds(1, 0, 0);
    const se = tileBounds(1, 1, 1);
    expect(nw.west).toBeCloseTo(-180, 9);
    expect(nw.east).toBeCloseTo(0, 9);
    expect(se.east).toBeCloseTo(180, 9);
    expect(nw.south).toBeCloseTo(0, 9);
    expect(se.north).toBeCloseTo(0, 9);
  });
});

describe('metresPerDegree', () => {
  it('gives ~111 km per degree of latitude everywhere', () => {
    for (const lat of [0, 30, 60, 85]) {
      const per = metresPerDegree(lat);
      expect(per.lat).toBeGreaterThan(110_000);
      expect(per.lat).toBeLessThan(112_000);
    }
  });

  it('shrinks longitude spacing with the cosine of latitude', () => {
    const eq = metresPerDegree(0).lon;
    const mid = metresPerDegree(60).lon;
    expect(mid / eq).toBeCloseTo(0.5, 2);
  });
});

describe('angle wrapping', () => {
  it('takes the short way around north', () => {
    expect(angleDeltaDeg(350, 10)).toBeCloseTo(20, 9);
    expect(angleDeltaDeg(10, 350)).toBeCloseTo(-20, 9);
    expect(angleDeltaDeg(0, 180)).toBeCloseTo(180, 9);
  });

  it('wraps longitude into [-180, 180)', () => {
    expect(wrapLongitude(190)).toBeCloseTo(-170, 9);
    expect(wrapLongitude(-190)).toBeCloseTo(170, 9);
    expect(wrapLongitude(540)).toBeCloseTo(180 - 360, 9);
  });
});

/**
 * The tile centre is shared between the terrain worker, which builds every
 * vertex relative to it, and the main thread, which places the finished mesh
 * at it. When the two disagreed the mesh was drawn somewhere the geometry was
 * never computed for — 856 km out on the z2 fallback ring that sits under
 * everything else.
 */
describe('tileCenterLatLon', () => {
  it('is the Mercator midpoint, not the mean of the edge latitudes', () => {
    const b = tileBounds(2, 1, 1);
    const c = tileCenterLatLon(2, 1, 1);
    const arithmetic = (b.north + b.south) / 2;

    expect(c.lat).toBeCloseTo(mercatorYToLat(0.375), 9);
    // The two really do differ — this is the bug, quantified.
    expect(Math.abs(c.lat - arithmetic)).toBeGreaterThan(5);
  });

  it('agrees with the tile it belongs to at every zoom', () => {
    for (const [z, x, y] of [
      [0, 0, 0],
      [1, 1, 0],
      [4, 9, 5],
      [10, 511, 340],
      [16, 33000, 22000],
    ] as const) {
      const b = tileBounds(z, x, y);
      const c = tileCenterLatLon(z, x, y);
      expect(c.lat).toBeLessThanOrEqual(b.north + 1e-9);
      expect(c.lat).toBeGreaterThanOrEqual(b.south - 1e-9);
      expect(c.lon).toBeCloseTo((b.west + b.east) / 2, 9);
    }
  });

  /** Longitude is linear in Mercator x, so only latitude can disagree. */
  it('converges on the arithmetic mean as tiles get small', () => {
    const b = tileBounds(14, 8000, 5400);
    const c = tileCenterLatLon(14, 8000, 5400);
    // Within a millionth of a degree — a few centimetres on the ground.
    expect(c.lat).toBeCloseTo((b.north + b.south) / 2, 5);
  });
});
