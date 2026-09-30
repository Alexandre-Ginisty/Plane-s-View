/**
 * The flight model in the sandbox: every aircraft in the hangar gets one that
 * flies, the globe adapter keeps the aircraft where it is as the local world
 * moves under it, the ground it lands on is the globe's, and the wind is the
 * one measured.
 */

import { describe, expect, it } from 'vitest';

import { MS_TO_KT } from '@/flight/config';
import { shapeFor } from '@/render/aircraft/shapes';
import { clearanceFor } from '@/render/ground';
import { airframeFor } from './airframes';
import { SANDBOX_AIRCRAFT, sandboxAircraft } from './catalog';
import { GlobeFlight, type FlightStart, type GroundAt } from './realFlight';
import { WindField } from './wind';

const NONE = new Set<string>();
const START: FlightStart = { lat: 48.85, lon: 2.35, altM: 1600, headingDeg: 90 };

function globeFlight(id: string, start = START, wind = new WindField()): GlobeFlight {
  const a = sandboxAircraft(id);
  const shape = shapeFor(a.type, 'A3');
  const cfg = airframeFor(a, shape.length);
  if (!cfg) throw new Error(`${id} has no flight model`);
  return new GlobeFlight(cfg, start, { hex: 'sandbox', type: a.type, callsign: 'TEST', category: 'A3' }, clearanceFor(shape), wind);
}

function run(f: GlobeFlight, seconds: number, ground: GroundAt, keys: ReadonlySet<string> = NONE, each?: () => void): void {
  for (let t = 0; t < seconds && !f.crashed; t += 1 / 60) {
    f.advance(1 / 60, keys, [], ground);
    each?.();
  }
}

const sea: GroundAt = () => 0;

describe('the hangar', () => {
  const fixedWing = SANDBOX_AIRCRAFT.filter((a) => !a.flight.heli);

  it('gives every fixed-wing aircraft a flight model, and helicopters none', () => {
    for (const a of SANDBOX_AIRCRAFT) {
      const cfg = airframeFor(a, shapeFor(a.type, 'A3').length);
      expect(cfg === null).toBe(a.flight.heli);
    }
  });

  for (const a of fixedWing) {
    it(`flies the ${a.name} hands-off from its spawn`, () => {
      const f = globeFlight(a.id);
      let finite = true;
      run(f, 20, sea, NONE, () => {
        const s = f.toSample();
        if (![s.lat, s.lon, s.altFt, s.headingDeg, s.pitchDeg, s.rollDeg].every(Number.isFinite)) finite = false;
      });
      expect(finite).toBe(true);
      expect(f.crashed).toBe(false);
      expect(Math.abs(f.altM - START.altM)).toBeLessThan(120);
      expect(Math.abs(f.state.derived.rollDeg)).toBeLessThan(8);
    });
  }
});

describe('the globe', () => {
  it('moves smoothly across re-anchoring, at the speed it flies', () => {
    const f = globeFlight('viper');
    let prev = f.toSample();
    let prevLat = prev.lat;
    let prevLon = prev.lon;
    let worst = 0;
    run(f, 60, sea, NONE, () => {
      const s = f.toSample();
      const d = Math.hypot((s.lat - prevLat) * 111_320, (s.lon - prevLon) * 111_320 * Math.cos((s.lat * Math.PI) / 180));
      worst = Math.max(worst, d);
      prevLat = s.lat;
      prevLon = s.lon;
      prev = s;
    });
    const speed = f.speedMps;
    // One frame's travel, never a jump.
    expect(worst).toBeLessThan((speed / 60) * 1.2);
    // Due east: the longitude grew by the distance flown.
    const flown = (prev.lon - START.lon) * 111_320 * Math.cos((START.lat * Math.PI) / 180);
    expect(flown).toBeGreaterThan(speed * 60 * 0.85);
    expect(Math.abs(prev.lat - START.lat) * 111_320).toBeLessThan(1500);
  });

  it('lands on the globe’s ground, not at sea level', () => {
    const f = globeFlight('c172');
    const field: GroundAt = () => 400;
    // On a trimmed 3° final, 40 m above a field 400 m up, hands off.
    f.placeAt({ ...START, altM: 440 }, { iasKt: 65, flightPathDeg: -3, flapsNotch: 2, gearDown: true });
    let landed = null;
    for (let t = 0; t < 60 && !f.crashed && !landed; t += 1 / 60) landed = f.advance(1 / 60, NONE, [], field).touchdown;
    expect(f.crashed).toBe(false);
    expect(landed?.verticalSpeedFpm).toBeGreaterThan(-600);
    expect(f.altM).toBeGreaterThan(400);
    expect(f.altM).toBeLessThan(403);
    expect(f.toSample().latest.onGround).toBe(true);
  });

  it('has no ground where no terrain has loaded, not a floor at sea level', () => {
    // Trimmed below sea level (the Dead Sea is at −430 m): a floor at 0 would crash it.
    const f = globeFlight('c172', { ...START, altM: -300 });
    run(f, 5, () => Number.NaN);
    expect(f.crashed).toBe(false);
  });

  it('crashes into a mountain it can see', () => {
    const f = globeFlight('viper', { ...START, altM: 1600 });
    const ridge: GroundAt = (_lat, lon) => (lon > START.lon + 0.02 ? 2500 : 300);
    run(f, 30, ridge);
    expect(f.crashed).toBe(true);
    expect(f.crashReason).toMatch(/terrain/i);
  });
});

describe('hands off', () => {
  for (const id of ['c172', 'viper', 'warthog', 'a320', 'a388']) {
    it(`levels a ${id} left in a steep diving turn while the kill cam has the camera`, () => {
      const f = globeFlight(id);
      run(f, 5, sea, new Set(['ArrowRight']));
      const upset = Math.abs(f.state.derived.rollDeg);
      f.autopilot = true;
      run(f, 30, sea);
      expect(upset).toBeGreaterThan(20);
      expect(f.crashed).toBe(false);
      expect(Math.abs(f.state.derived.rollDeg)).toBeLessThan(8);
      expect(Math.abs(f.readout().verticalFpm)).toBeLessThan(1500);
    });
  }
});

describe('the wind', () => {
  it('is the surface wind grown with height, blended into the winds reported aloft', () => {
    const w = new WindField();
    w.setSurface(270, 10);
    const out = { east: 0, north: 0 };
    // From the west: the air moves east.
    expect(w.at(10, 10, out).east).toBeCloseTo(10, 6);
    expect(w.at(200, 200, out).east).toBeGreaterThan(14);
    w.observe(
      [
        { lat: 48.9, lon: 2.4, altFt: 35_000, latest: { windDirectionDeg: 0, windSpeedKt: 80 } },
        { lat: 48.8, lon: 2.3, altFt: 35_300, latest: { windDirectionDeg: 0, windSpeedKt: 60 } },
        { lat: 10, lon: 10, altFt: 35_000, latest: { windDirectionDeg: 90, windSpeedKt: 200 } },
      ],
      48.85,
      2.35,
    );
    expect(w.layerCount).toBe(1);
    // FL350 from the north at 70 kt: the air moves south.
    const aloft = w.at(10_700, 10_500, out);
    expect(aloft.north).toBeCloseTo(-70 * 0.514_444, 3);
    expect(Math.abs(aloft.east)).toBeLessThan(1e-9);
  });

  it('carries the aircraft: ground speed differs from airspeed by the wind', () => {
    const wind = new WindField();
    wind.setSurface(270, 15); // a westerly: a tailwind for an aircraft heading east
    const f = globeFlight('c172', START, wind);
    run(f, 20, sea);
    const tas = f.state.derived.tas * MS_TO_KT;
    const gs = f.state.derived.groundSpeed * MS_TO_KT;
    expect(gs - tas).toBeGreaterThan(15 * 1.94 * 0.9);
  });
});
