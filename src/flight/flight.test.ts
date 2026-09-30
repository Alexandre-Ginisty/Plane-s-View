/**
 * The flight model against the numbers it was calibrated to.
 *
 * Not the source project's full calibration suite — a spot check of each
 * mechanism the port touched: the lift curve and stall, the engines, trim
 * and hands-off stability, fly-by-wire, the ground (landing and crashing), and
 * the similarity scaling this project adds.
 */

import { describe, expect, it } from 'vitest';

import { createTrimmedState, defaultControls, step } from './aircraft';
import { liftCoefficient } from './aero';
import { airDensity } from './atmosphere';
import { A10, B747, C172, F16, KT_TO_MS, MS_TO_KT, SIM, scaleAirframe, type AircraftConfig, type FlightConfig } from './config';
import { engineThrust } from './engine';
import { solveTrim } from './trim';
import type { AircraftState, Controls, Environment } from './types';

const flat = (h = 0): Environment => ({ groundHeight: () => h, surfaceAt: () => 'asphalt', waterLevel: () => null });
const cfgOf = (aircraft: AircraftConfig): FlightConfig => ({ sim: SIM, aircraft });
const C = cfgOf(C172);

function fly(state: AircraftState, controls: Controls, seconds: number, cfg: FlightConfig, env = flat(), each?: (s: AircraftState) => void) {
  let s = state;
  const n = Math.round(seconds / SIM.fixedDt);
  for (let i = 0; i < n && s.phase !== 'crashed'; i++) {
    s = step(s, controls, SIM.fixedDt, env, cfg);
    each?.(s);
  }
  return s;
}

/** 1-g stall speed from the lift curve, KIAS. */
function stallKias(cfg: FlightConfig, flapsDeg: number): number {
  let clMax = 0;
  for (let a = 0; a < 0.8; a += 0.001) clMax = Math.max(clMax, liftCoefficient(a, flapsDeg, cfg));
  const ac = cfg.aircraft;
  return Math.sqrt((2 * ac.mass * SIM.gravity) / (SIM.seaLevelDensity * ac.wingArea * clMax)) * MS_TO_KT;
}

describe('aerodynamics', () => {
  it('stalls the Cessna where the POH says', () => {
    expect(stallKias(C, 0)).toBeGreaterThan(46);
    expect(stallKias(C, 0)).toBeLessThan(53);
    expect(stallKias(C, 30)).toBeLessThan(stallKias(C, 0) - 4);
  });

  it('stalls the light 747 near 138 KIAS clean', () => {
    const s = stallKias(cfgOf(B747), 0);
    expect(s).toBeGreaterThan(130);
    expect(s).toBeLessThan(146);
  });
});

describe('engines', () => {
  it('makes the F110 thrust at sea level', () => {
    expect(engineThrust(1, 0, 1.225, 0, cfgOf(F16))).toBeCloseTo(76_300, -2);
  });

  it('lights the afterburner only past the detent, once the core has spooled', () => {
    const cfg = cfgOf(F16);
    const { state, controls } = createTrimmedState({ altitudeM: 3000, iasKt: 350, gearDown: false }, flat(), cfg);
    const full = { ...controls, throttle: 1 };
    let sawAbEarly = false;
    const after = fly(state, full, 8, cfg, flat(), (s) => {
      if (s.time < 0.3 && (s.engine.afterburner ?? 0) > 0) sawAbEarly = true;
    });
    expect(sawAbEarly).toBe(false);
    expect(after.engine.afterburner).toBeGreaterThan(0.95);
  });
});

describe('trim and stability', () => {
  it('holds a trimmed Cessna hands-off', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 1600, iasKt: 110, gearDown: false }, flat(), C);
    expect(solveTrim({ altitudeM: 1600, iasKt: 110, gearDown: false }, C).converged).toBe(true);
    const after = fly(state, controls, 30, C);
    expect(after.phase).toBe('airborne');
    expect(Math.abs(after.position.y - 1600)).toBeLessThan(40);
    expect(Math.abs(after.derived.rollDeg)).toBeLessThan(3);
    expect(after.derived.ias * MS_TO_KT).toBeGreaterThan(100);
  });

  for (const ac of [F16, A10, B747]) {
    it(`holds a trimmed ${ac.name} hands-off`, () => {
      const cfg = cfgOf(ac);
      const { state, controls } = createTrimmedState({ altitudeM: 2000, iasKt: ac.limits.cruiseKt, gearDown: false }, flat(), cfg);
      const after = fly(state, controls, 20, cfg);
      expect(after.phase).toBe('airborne');
      expect(Math.abs(after.position.y - 2000)).toBeLessThan(80);
      expect(Math.abs(after.derived.rollDeg)).toBeLessThan(5);
    });
  }
});

describe('fly-by-wire', () => {
  it('pulls 9 g and no more at full aft stick', () => {
    const cfg = cfgOf(F16);
    const { state, controls } = createTrimmedState({ altitudeM: 3000, iasKt: 480, gearDown: false }, flat(), cfg);
    let peak = 0;
    fly(state, { ...controls, throttle: 1, elevator: 1 }, 2.5, cfg, flat(), (s) => (peak = Math.max(peak, s.derived.loadFactor)));
    expect(peak).toBeGreaterThan(8);
    expect(peak).toBeLessThan(9.6);
  });

  it('rolls fast and stops when the stick is released', () => {
    const cfg = cfgOf(F16);
    const { state, controls } = createTrimmedState({ altitudeM: 3000, iasKt: 350, gearDown: false }, flat(), cfg);
    const rolled = fly(state, { ...controls, aileron: 1 }, 0.3, cfg);
    const held = fly(rolled, controls, 3, cfg);
    expect(Math.abs(rolled.derived.rollDeg)).toBeGreaterThan(15);
    expect(Math.abs((held.derived.p * 180) / Math.PI)).toBeLessThan(3);
  });
});

describe('the ground', () => {
  it('lands a Cessna flown down a glide slope onto flat ground', () => {
    const env = flat(120);
    const { state, controls } = createTrimmedState(
      { altitudeM: 120 + 40, iasKt: 65, flightPathDeg: -3, flapsNotch: 2, gearDown: true },
      env,
      C,
    );
    const after = fly(state, { ...controls, throttle: controls.throttle * 0.8 }, 40, C, env);
    expect(after.phase).not.toBe('crashed');
    expect(after.touchdown).not.toBeNull();
    expect(after.onGround).toBe(true);
  });

  it('crashes a dive into the ground, with a reason', () => {
    const env = flat(0);
    const { state, controls } = createTrimmedState({ altitudeM: 150, iasKt: 110, flightPathDeg: -25, gearDown: false }, env, C);
    const after = fly(state, controls, 20, C, env);
    expect(after.phase).toBe('crashed');
    expect(after.crash?.reason).toMatch(/terrain|strike|landing/i);
  });

  it('breaks an airliner pulled far past its load limit', () => {
    const cfg = cfgOf(B747);
    const { state, controls } = createTrimmedState({ altitudeM: 3000, iasKt: 330, gearDown: false }, flat(), cfg);
    const after = fly(state, { ...controls, elevator: 1 }, 6, cfg);
    expect(after.crash?.reason).toMatch(/over-G/);
  });

  it('sits still on its wheels with the brakes on', () => {
    const cfg = C;
    const env = flat(50);
    const { state } = createTrimmedState({ altitudeM: 52, iasKt: 0.5, gearDown: true }, env, cfg);
    const resting: AircraftState = {
      ...state,
      velocity: { x: 0, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      position: { x: 0, y: 50 + 1.22 - 0.05, z: 0 },
      phase: 'ground',
      airborneTime: 0,
    };
    const after = fly(resting, { ...defaultControls(), brake: 1 }, 5, cfg, env);
    expect(after.phase).not.toBe('crashed');
    expect(after.onGround).toBe(true);
    expect(Math.hypot(after.velocity.x, after.velocity.z)).toBeLessThan(0.2);
  });
});

describe('similarity scaling', () => {
  it('keeps the handling and scales the speeds by the square root of the size', () => {
    const k = 37.6 / B747.geometry.length;
    const a320 = cfgOf(scaleAirframe(B747, { name: 'A320', lengthM: 37.6 }));
    expect(a320.aircraft.mass).toBeCloseTo(B747.mass * k ** 3, -2);
    expect(stallKias(a320, 0)).toBeCloseTo(stallKias(cfgOf(B747), 0) * Math.sqrt(k), 0);
    expect(a320.aircraft.limits.cruiseKt).toBeCloseTo(B747.limits.cruiseKt * Math.sqrt(k), 5);

    const { state, controls } = createTrimmedState({ altitudeM: 2000, iasKt: a320.aircraft.limits.cruiseKt, gearDown: false }, flat(), a320);
    const after = fly(state, controls, 20, a320);
    expect(after.phase).toBe('airborne');
    expect(Math.abs(after.position.y - 2000)).toBeLessThan(80);
  });

  it('rests a scaled airframe on its struts at the same fraction of their travel', () => {
    const big = scaleAirframe(C172, { name: 'x', lengthM: 20 });
    const k = 20 / C172.geometry.length;
    const staticCompression = (ac: AircraftConfig) => (ac.mass * SIM.gravity) / 3 / ac.ground.springMain / ac.geometry.strutTravel;
    expect(staticCompression(big)).toBeCloseTo(staticCompression(C172), 6);
    expect(big.geometry.leftMainWheel.y).toBeCloseTo(C172.geometry.leftMainWheel.y * k, 9);
  });
});

it('uses the ISA density', () => {
  expect(airDensity(0)).toBeCloseTo(1.225, 6);
  expect(airDensity(11_000)).toBeCloseTo(0.3639, 3);
  expect(KT_TO_MS * MS_TO_KT).toBeCloseTo(1, 12);
});
