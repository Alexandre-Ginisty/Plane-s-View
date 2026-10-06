import { describe, expect, it } from 'vitest';

import { RunwayMotion } from './runwayMotion';
import type { SampledAircraft } from '@/state/traffic';
import type { AircraftState } from '@/data/types';

const GROUND_M = 100;
const flat = (): number => GROUND_M;

function sample(over: Partial<SampledAircraft>, latest: Partial<AircraftState> = {}): SampledAircraft {
  return {
    hex: 'abc123',
    lat: 48,
    lon: 2,
    altFt: (GROUND_M + 300) * 3.28084,
    trackDeg: 90,
    headingDeg: 88,
    rollDeg: 0,
    pitchDeg: -3,
    groundSpeedKt: 140,
    verticalRateFpm: -700,
    ageSec: 0,
    stale: false,
    uncertaintyM: 10,
    latest: { hex: 'abc123', fixTime: 1000, onGround: false, category: 'A3', ...latest } as AircraftState,
    ...over,
  };
}

describe('RunwayMotion', () => {
  it('follows the feed while it is talking', () => {
    const m = new RunwayMotion();
    const s = sample({});
    const step = m.step(s, 'final', 1000, flat, 3, 0.1);
    expect(step.act).toBeNull();
    expect(step.flying).toBe(s);
  });

  it('lands a silent aircraft on final: flare, touchdown, roll, taxi, done', () => {
    const m = new RunwayMotion();
    m.step(sample({}), 'final', 1000, flat, 3, 0.1);
    const quiet = sample({ ageSec: 10 });
    let touched = -1;
    let maxFlarePitch = -90;
    let lastAlt = Infinity;
    let landed = false;
    for (let i = 0; i < 3000 && !landed; i++) {
      const step = m.step(quiet, 'final', Number.NaN, flat, 3, 0.05);
      expect(step.act).toBe('landing');
      const f = step.flying;
      expect(f.altFt).toBeLessThanOrEqual(lastAlt + 1e-6);
      lastAlt = f.altFt;
      if (!f.latest.onGround && f.altFt / 3.28084 < GROUND_M + 3 + 15) maxFlarePitch = Math.max(maxFlarePitch, f.pitchDeg);
      if (f.latest.onGround && touched < 0) {
        touched = i;
        // A landing, not an arrival from above: the sink rate is gentle.
        expect(f.groundSpeedKt).toBeGreaterThan(100);
      }
      landed = step.landed;
    }
    expect(touched).toBeGreaterThan(0);
    expect(maxFlarePitch).toBeGreaterThan(2);
    expect(landed).toBe(true);
  });

  it('takes off from a silent runway roll and climbs', () => {
    const m = new RunwayMotion();
    const rolling = sample({ altFt: GROUND_M * 3.28084, groundSpeedKt: 80, verticalRateFpm: 0, pitchDeg: 0 }, { onGround: true });
    m.step(rolling, 'takeoff', 0, flat, 3, 0.1);
    let airborne = false;
    let f: SampledAircraft = rolling;
    for (let i = 0; i < 2000; i++) {
      f = m.step({ ...rolling, ageSec: 6 }, 'takeoff', 0, flat, 3, 0.05).flying;
      if (!f.latest.onGround) airborne = true;
    }
    expect(airborne).toBe(true);
    expect(f.altFt / 3.28084).toBeGreaterThan(GROUND_M + 200);
    expect(f.pitchDeg).toBeGreaterThan(5);
  });

  it('blends back onto the feed when it returns, then lets go', () => {
    const m = new RunwayMotion();
    m.step(sample({}), 'final', 1000, flat, 3, 0.1);
    for (let i = 0; i < 40; i++) m.step(sample({ ageSec: 10 }), 'final', Number.NaN, flat, 3, 0.1);
    const back = sample({ ageSec: 0.5 }, { fixTime: 9000 });
    let step = m.step(back, 'final', 900, flat, 3, 0.1);
    expect(step.act).toBe('landing');
    for (let i = 0; i < 40; i++) step = m.step(back, 'final', 900, flat, 3, 0.1);
    expect(step.act).toBeNull();
    expect(step.flying).toBe(back);
  });
});
