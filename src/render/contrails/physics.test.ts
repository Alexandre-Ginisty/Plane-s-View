import { describe, expect, it } from 'vitest';

import { airAt, contrailThresholdC, isaPressureHpa, isaTemperatureC, satIcePa, satWaterPa, trailFor, type AirAt, type TrailVerdict } from './physics';

const air = (): AirAt => ({ pressureHpa: 0, tempC: 0, rhWater: 0 });
const verdict = (): TrailVerdict => ({ density: 0, lifeS: 0, persistent: false });

describe('contrail physics', () => {
  it('has the standard atmosphere and saturation pressures right', () => {
    expect(isaPressureHpa(0)).toBeCloseTo(1013.25, 1);
    expect(isaTemperatureC(11_000)).toBeCloseTo(-56.5, 1);
    expect(isaPressureHpa(10_668)).toBeCloseTo(238.4, 0); // FL350
    expect(satWaterPa(0)).toBeCloseTo(611.2, 0);
    expect(satIcePa(0)).toBeCloseTo(611.2, 0);
    // Water's saturation pressure well above ice's in the cold.
    expect(satWaterPa(-50) / satIcePa(-50)).toBeGreaterThan(1.5);
  });

  it('puts the Schmidt–Appleman threshold near −40 °C at cruise, colder when dry', () => {
    const wet = contrailThresholdC(240, 1);
    const dry = contrailThresholdC(240, 0);
    expect(wet).toBeGreaterThan(-44);
    expect(wet).toBeLessThan(-37);
    expect(dry).toBeLessThan(wet);
    expect(wet - dry).toBeLessThan(12); // Appleman: about −40 °C saturated, −50 °C dry at 250 hPa
    // Lower down (higher pressure) the threshold is warmer.
    expect(contrailThresholdC(400, 0.5)).toBeGreaterThan(contrailThresholdC(200, 0.5));
  });

  it('leaves a persistent trail in cold, ice-supersaturated air and none in warm air', () => {
    const cold = trailFor(10_668, airAt(10_668, -55, [{ hPa: 250, tempC: -52, rhPct: 70 }], air()), verdict());
    expect(cold.density).toBeGreaterThan(0.5);
    expect(cold.persistent).toBe(true);

    const warm = trailFor(10_668, airAt(10_668, -30, null, air()), verdict());
    expect(warm.density).toBe(0);

    const low = trailFor(3000, airAt(3000, -60, null, air()), verdict());
    expect(low.density).toBe(0);
  });

  it('gives a short trail in dry air', () => {
    const v = trailFor(11_000, airAt(11_000, -58, [{ hPa: 250, tempC: -55, rhPct: 15 }], air()), verdict());
    expect(v.density).toBeGreaterThan(0);
    expect(v.persistent).toBe(false);
    expect(v.lifeS).toBeLessThan(10);
  });

  it('prefers the measured temperature and interpolates the profile', () => {
    const profile = [
      { hPa: 300, tempC: -40, rhPct: 40 },
      { hPa: 200, tempC: -60, rhPct: 80 },
    ];
    const a = airAt(11_000, null, profile, air());
    expect(a.tempC).toBeLessThan(-40);
    expect(a.tempC).toBeGreaterThan(-60);
    expect(a.rhWater).toBeGreaterThan(0.4);
    expect(a.rhWater).toBeLessThan(0.8);
    expect(airAt(11_000, -47, profile, air()).tempC).toBe(-47);
  });
});
