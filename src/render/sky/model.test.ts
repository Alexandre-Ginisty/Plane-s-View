/**
 * The atmosphere, from the viewpoints that matter.
 *
 * The shaders only read what this model computes — the sky table, and a
 * closed-form transmittance transcribed line for line — so this is where the
 * sky and the haze are pinned. Each case is a real view from the app rather
 * than an abstract distance: the thing being defended is "does it look right
 * from there".
 */

import { describe, expect, it } from 'vitest';

import {
  LUT_HALF,
  LUT_HEIGHT,
  LUT_WIDTH,
  buildSkyLut,
  chapmanColumn,
  column,
  expose,
  exposureFor,
  grade,
  hazeForVisibility,
  horizonDip,
  integrateView,
  lutElevation,
  lutU,
  lutV,
  sceneLight,
  sunTransmittance,
  surfaceTransmittance,
  EARTH_RADIUS_M,
  RAYLEIGH_H,
  type Rgb,
  type SkyConditions,
} from './model';

const CRUISE_M = 10_700; // FL350
const HORIZON_FROM_CRUISE_M = 370_000;

const luminance = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const opacity = (t: Rgb): number => 1 - luminance(t);

/** What the screen shows for one view direction. */
function shown(conditions: SkyConditions, elevationDeg: number, azimuthDeg: number): Rgb {
  const s = integrateView(conditions, (elevationDeg * Math.PI) / 180, (azimuthDeg * Math.PI) / 180);
  const ex = exposureFor(conditions.sunElevationDeg);
  return grade(s.radiance.map((L) => expose(L, ex)) as Rgb);
}

const noon = (altitudeM = 100): SkyConditions => ({ altitudeM, sunElevationDeg: 55, haze: 1 });

describe('the sky', () => {
  it('is blue overhead at midday', () => {
    const zenith = shown(noon(), 89, 180);
    expect(zenith[2]).toBeGreaterThan(zenith[1]);
    expect(zenith[1]).toBeGreaterThan(zenith[0]);
    expect(zenith[2] / zenith[0]).toBeGreaterThan(2);
  });

  it('pales towards the horizon', () => {
    // Looking through far more air, every colour is scattered in and the sky
    // whitens: the horizon is brighter and less saturated than the zenith.
    const zenith = shown(noon(), 89, 180);
    const horizon = shown(noon(), 1, 180);
    expect(luminance(horizon)).toBeGreaterThan(luminance(zenith) * 1.8);
    expect(horizon[2] / horizon[0]).toBeLessThan(zenith[2] / zenith[0]);
  });

  it('darkens overhead with altitude', () => {
    // From FL350 there is a quarter of the air above, and the zenith is a
    // deep blue a flat-colour sky never shows.
    const ground = luminance(shown(noon(100), 89, 180));
    const cruise = luminance(shown(noon(CRUISE_M), 89, 180));
    expect(cruise).toBeLessThan(ground * 0.75);
  });

  it('glows towards the sun', () => {
    const toward = luminance(shown(noon(), 20, 0));
    const away = luminance(shown(noon(), 20, 180));
    expect(toward).toBeGreaterThan(away);
  });

  it('turns orange at the horizon under the setting sun', () => {
    const sunset: SkyConditions = { altitudeM: 100, sunElevationDeg: 0.5, haze: 1 };
    const c = shown(sunset, 1, 0);
    expect(c[0]).toBeGreaterThan(c[1]);
    expect(c[1]).toBeGreaterThan(c[2] * 1.3);
  });

  it('keeps the twilight zenith blue, not grey', () => {
    const dusk: SkyConditions = { altitudeM: 100, sunElevationDeg: -2, haze: 1 };
    const c = shown(dusk, 89, 90);
    expect(c[2]).toBeGreaterThan(c[0]);
  });

  it('goes dark at night', () => {
    const night: SkyConditions = { altitudeM: 100, sunElevationDeg: -25, haze: 1 };
    expect(luminance(shown(night, 30, 0))).toBeLessThan(0.01);
  });

  it('is finite in every direction and condition', () => {
    for (const altitudeM of [0, 500, CRUISE_M, 40_000]) {
      for (const sunElevationDeg of [-30, -6, 0, 3, 45, 90]) {
        for (const e of [-89, -10, -1, 0, 1, 10, 89]) {
          for (const a of [0, 1, 90, 180]) {
            const c = shown({ altitudeM, sunElevationDeg, haze: 1 }, e, a);
            for (const v of c) {
              expect(Number.isFinite(v)).toBe(true);
              expect(v).toBeGreaterThanOrEqual(0);
              expect(v).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
  });
});

describe('sunlight', () => {
  it('reddens as the sun sinks', () => {
    const high = sunTransmittance(0, 60);
    const low = sunTransmittance(0, 3);
    expect(low[2] / low[0]).toBeLessThan(high[2] / high[0]);
    expect(low[0]).toBeLessThan(high[0]);
  });

  it('is gone once the sun is well below the horizon', () => {
    const t = sunTransmittance(0, -3);
    expect(Math.max(...t)).toBeLessThan(0.01);
  });

  it('still lights an aircraft at altitude after sunset on the ground', () => {
    // The last aircraft to catch the sun at dusk are the ones at cruise.
    const ground = sunTransmittance(0, -1);
    const cruise = sunTransmittance(CRUISE_M, -1);
    expect(cruise[0]).toBeGreaterThan(ground[0] + 0.2);
  });

  it('gives the models noon light at noon and none at night', () => {
    const day = sceneLight(noon(0));
    expect(day.sunStrength).toBeGreaterThan(0.95);
    expect(day.skyStrength).toBeGreaterThan(0.95);
    const night = sceneLight({ altitudeM: 0, sunElevationDeg: -20, haze: 1 });
    expect(night.sunStrength).toBe(0);
    expect(night.skyStrength).toBeLessThan(0.2);
  });
});

describe('haze on surfaces', () => {
  const hazeOver = (length: number, from: number, to: number): number =>
    opacity(surfaceTransmittance(length, from, to));

  it('leaves the runway in front of you crisp', () => {
    expect(hazeOver(1_000, 2, 2)).toBeLessThan(0.03);
  });

  it('hazes the far side of a large airfield, gently', () => {
    const h = hazeOver(5_000, 2, 2);
    expect(h).toBeGreaterThan(0.04);
    expect(h).toBeLessThan(0.2);
  });

  it('puts only a light veil on the ground directly below at cruise', () => {
    // Eleven kilometres of path, but most of it thin air: why the density
    // must follow the altitude.
    const h = hazeOver(CRUISE_M, CRUISE_M, 0);
    expect(h).toBeGreaterThan(0.04);
    expect(h).toBeLessThan(0.2);
  });

  it('leaves shapes visible a hundred kilometres ahead at cruise', () => {
    // Most of a cockpit view is that far away. Honest air makes it white;
    // this keeps it worth looking at, and still soft enough to hide the
    // imagery's change of dataset out there.
    const h = hazeOver(100_000, CRUISE_M, 0);
    expect(h).toBeGreaterThan(0.3);
    expect(h).toBeLessThan(0.6);
  });

  it('dissolves the horizon into the sky', () => {
    expect(hazeOver(HORIZON_FROM_CRUISE_M, CRUISE_M, 0)).toBeGreaterThan(0.9);
  });

  it('takes blue first, so distant ground turns blue before it turns to sky', () => {
    const t = surfaceTransmittance(60_000, 500, 200);
    expect(t[2]).toBeLessThan(t[1]);
    expect(t[1]).toBeLessThan(t[0]);
  });

  it('never gets thicker further up', () => {
    let previous = Infinity;
    for (const alt of [0, 2_000, 6_000, 12_000, 20_000]) {
      const h = hazeOver(50_000, alt, alt);
      expect(h).toBeLessThan(previous);
      previous = h;
    }
  });

  it('thickens with reported poor visibility, never thins below clear', () => {
    expect(hazeForVisibility(null)).toBe(1);
    expect(hazeForVisibility(24_000)).toBe(1);
    expect(hazeForVisibility(5_000)).toBeGreaterThan(2);
    const foggy = surfaceTransmittance(5_000, 2, 2, hazeForVisibility(3_000));
    expect(opacity(foggy)).toBeGreaterThan(0.6);
  });
});

describe('column', () => {
  it('is symmetric: looking down equals looking up', () => {
    expect(column(12_000, 12_000, 0, RAYLEIGH_H)).toBeCloseTo(column(12_000, 0, 12_000, RAYLEIGH_H), 6);
  });

  it('joins smoothly onto the level case', () => {
    // A seam here runs across any near-level view: most of a cockpit.
    const level = column(100_000, 3_000, 3_000, RAYLEIGH_H);
    const almost = column(100_000, 3_000, 3_002, RAYLEIGH_H);
    expect(almost / level).toBeCloseTo(1, 3);
  });

  it('treats ground below sea level as sea level, not denser air', () => {
    expect(column(10_000, 0, -400, RAYLEIGH_H)).toBeCloseTo(column(10_000, 0, 0, RAYLEIGH_H), 6);
  });
});

describe('chapmanColumn', () => {
  it('matches a brute-force integral along the ray', () => {
    const r = EARTH_RADIUS_M + 2_000;
    for (const cosChi of [1, 0.5, 0.1, 0, -0.02]) {
      const sinChi = Math.sqrt(1 - cosChi * cosChi);
      let sum = 0;
      const step = 20;
      for (let t = step / 2; t < 1_500_000; t += step) {
        const x = sinChi * t;
        const y = r + cosChi * t;
        const h = Math.hypot(x, y) - EARTH_RADIUS_M;
        if (h < 0) {
          sum = Infinity;
          break;
        }
        if (h > 150_000) break;
        sum += Math.exp(-h / RAYLEIGH_H) * step;
      }
      const approx = chapmanColumn(r, cosChi, RAYLEIGH_H);
      expect(Math.abs(approx - sum) / sum).toBeLessThan(0.03);
    }
  });

  it('blocks a sun below the horizon entirely without overflowing', () => {
    const c = chapmanColumn(EARTH_RADIUS_M + 10, -0.3, RAYLEIGH_H);
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeGreaterThan(1e8);
  });
});

describe('the table', () => {
  it('maps elevations round trip, with the true horizon at the middle', () => {
    for (const alt of [0, CRUISE_M]) {
      const dip = horizonDip(alt);
      expect(lutV(-dip, dip)).toBeCloseTo(0.5, 9);
      for (const v of [0.02, 0.3, 0.5, 0.51, 0.8, 0.98]) {
        expect(lutV(lutElevation(v, dip), dip)).toBeCloseTo(v, 9);
      }
    }
    expect(lutU(0)).toBe(0);
    expect(lutU(Math.PI)).toBe(1);
  });

  it('dips the horizon three degrees at cruise', () => {
    expect((horizonDip(CRUISE_M) * 180) / Math.PI).toBeCloseTo(3.3, 1);
    expect(horizonDip(0)).toBe(0);
  });

  it('fills every texel with a displayable colour', () => {
    const out = new Float32Array(LUT_WIDTH * LUT_HEIGHT * 4);
    buildSkyLut(noon(CRUISE_M), out);
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1.05);
    }
  });

  it('gives far terrain the colour of the sky just above the horizon', () => {
    // The seam the whole atmosphere exists to hide: the haze an object at
    // the horizon takes and the sky right behind it must be near-identical.
    const out = new Float32Array(LUT_WIDTH * LUT_HEIGHT * 4);
    for (const conditions of [noon(100), noon(CRUISE_M), { altitudeM: 3_000, sunElevationDeg: 4, haze: 1 }]) {
      buildSkyLut(conditions, out);
      const skyRow = LUT_HALF / 2; // first row above the horizon
      const hazeRow = LUT_HALF + LUT_HALF / 2 - 1; // last row below it
      for (const i of [0, LUT_WIDTH / 2, LUT_WIDTH - 1]) {
        const sky = (skyRow * LUT_WIDTH + i) * 4;
        const haze = (hazeRow * LUT_WIDTH + i) * 4;
        for (let c = 0; c < 3; c++) {
          expect(Math.abs(out[sky + c]! - out[haze + c]!)).toBeLessThan(0.08);
        }
      }
    }
  });

  it('draws no dark line along the horizon', () => {
    // The dome samples the sky rows at the horizon with a linear filter, so
    // the hidden rows just below it are blended into the view: rays that end
    // in the ground a kilometre away must not bleed their near-black in.
    const out = new Float32Array(LUT_WIDTH * LUT_HEIGHT * 4);
    for (const conditions of [noon(2), noon(CRUISE_M), { altitudeM: 1_500, sunElevationDeg: 3, haze: 1 }]) {
      buildSkyLut(conditions, out);
      const above = LUT_HALF / 2;
      for (const i of [0, LUT_WIDTH / 2, LUT_WIDTH - 1]) {
        const lum = (row: number) => {
          const k = (row * LUT_WIDTH + i) * 4;
          return 0.2126 * out[k]! + 0.7152 * out[k + 1]! + 0.0722 * out[k + 2]!;
        };
        expect(lum(above - 1)).toBeGreaterThanOrEqual(lum(above) * 0.97);
      }
    }
  });

  it('builds in a few milliseconds', () => {
    const out = new Float32Array(LUT_WIDTH * LUT_HEIGHT * 4);
    buildSkyLut(noon(), out);
    const start = performance.now();
    for (let i = 0; i < 5; i++) buildSkyLut(noon(1_000 + i * 100), out);
    expect((performance.now() - start) / 5).toBeLessThan(25);
  });
});
