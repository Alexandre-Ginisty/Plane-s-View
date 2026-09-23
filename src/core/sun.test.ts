import { describe, expect, it } from 'vitest';
import { subsolarPoint, sunElevation } from './sun';

describe('solar position', () => {
  it('puts the subsolar point near the Tropic of Cancer at the June solstice', () => {
    const p = subsolarPoint(new Date('2025-06-21T12:00:00Z'));
    expect(p.lat).toBeGreaterThan(23.0);
    expect(p.lat).toBeLessThan(23.6);
  });

  it('puts it near the Tropic of Capricorn at the December solstice', () => {
    const p = subsolarPoint(new Date('2025-12-21T12:00:00Z'));
    expect(p.lat).toBeLessThan(-23.0);
    expect(p.lat).toBeGreaterThan(-23.6);
  });

  it('crosses the equator at the equinoxes', () => {
    for (const d of ['2025-03-20T12:00:00Z', '2025-09-22T12:00:00Z']) {
      expect(Math.abs(subsolarPoint(new Date(d)).lat)).toBeLessThan(0.6);
    }
  });

  it('tracks the subsolar longitude westward at 15 degrees per hour', () => {
    const a = subsolarPoint(new Date('2025-06-21T00:00:00Z'));
    const b = subsolarPoint(new Date('2025-06-21T06:00:00Z'));
    let delta = b.lon - a.lon;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    expect(delta).toBeCloseTo(-90, 0);
  });

  it('places the sun overhead at the subsolar point', () => {
    const when = new Date('2025-06-21T12:00:00Z');
    const p = subsolarPoint(when);
    expect(sunElevation(p.lat, p.lon, when)).toBeGreaterThan(89.5);
  });

  it('reports night on the opposite side of the planet', () => {
    const when = new Date('2025-06-21T12:00:00Z');
    const p = subsolarPoint(when);
    const antipodeLon = p.lon > 0 ? p.lon - 180 : p.lon + 180;
    expect(sunElevation(-p.lat, antipodeLon, when)).toBeLessThan(-89);
  });

  it('has the sun up at midday and down at midnight in London', () => {
    expect(sunElevation(51.5, -0.12, new Date('2025-06-21T12:00:00Z'))).toBeGreaterThan(50);
    expect(sunElevation(51.5, -0.12, new Date('2025-12-21T00:00:00Z'))).toBeLessThan(-40);
  });
});
