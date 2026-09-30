/**
 * Steady-flight trim: the angle of attack, engine power and elevator trim that
 * hold an indicated airspeed on a flight path hands-off (elevator 0, wings
 * level, no sideslip), with exactly the step's force model. Pure.
 *
 * Adapted from Tater's Flight Sim (MIT, Copyright (c) 2026 Jared Tate — see
 * ./LICENSE).
 */

import { KT_TO_MS, flapNotchDeg, type FlightConfig } from './config';
import { airDensity, speedOfSound } from './atmosphere';
import { computeAero, liftCoefficient } from './aero';
import { enginePowerTarget, engineThrottleForPower, engineThrust } from './engine';
import { quatFromEuler, worldToBody } from './frames';

const DEG = Math.PI / 180;
const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });

export interface TrimRequest {
  /** Altitude MSL, m. */
  altitudeM: number;
  iasKt: number;
  /** + climbing, deg. */
  flightPathDeg?: number;
  flapsNotch?: number;
  gearDown?: boolean;
  headingDeg?: number;
  x?: number;
  z?: number;
}

interface TrimResult {
  alpha: number;
  pitchDeg: number;
  /** m/s. */
  tas: number;
  density: number;
  power: number;
  /** Clamped 0..1. */
  throttle: number;
  /** Clamped -1..1. */
  elevatorTrim: number;
  flapsDeg: number;
  /** Exact, and within the throttle and trim ranges. */
  converged: boolean;
}

function det3(m: number[][]): number {
  const [a, b, c] = m as [number[], number[], number[]];
  return a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
}

/** Cramer's rule. */
function solve3(J: number[][], r: number[]): number[] | null {
  const det = det3(J);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const col = (k: number) => det3(J.map((row, i) => row.map((v, j) => (j === k ? r[i]! : v)))) / det;
  return [col(0), col(1), col(2)];
}

export function solveTrim(req: TrimRequest, cfg: FlightConfig): TrimResult {
  const ac = cfg.aircraft;
  const flapsDeg = flapNotchDeg(cfg, req.flapsNotch ?? 0);
  const gearPos = req.gearDown === false ? 0 : 1;
  const gamma = (req.flightPathDeg ?? 0) * DEG;
  const rho = airDensity(req.altitudeM);
  const V = req.iasKt * KT_TO_MS * Math.sqrt(cfg.sim.seaLevelDensity / rho);
  const W = ac.mass * cfg.sim.gravity;
  const qbar = 0.5 * rho * V * V;
  const scaleM = qbar * ac.wingArea * ac.meanChord;
  const mach = V / speedOfSound(req.altitudeM);

  const residual = (x: number[]): number[] => {
    const [alpha, power, trim] = x as [number, number, number];
    const vb = { x: 0, y: -V * Math.sin(alpha), z: -V * Math.cos(alpha) };
    const thrust = engineThrust(power, V * Math.cos(alpha), rho, mach, cfg);
    const a = computeAero(vb, ZERO, rho, flapsDeg, gearPos, { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: trim }, thrust, cfg, Infinity, { mach });
    const q = quatFromEuler(0, (gamma + alpha) / DEG, 0);
    const g = worldToBody(q, { x: 0, y: -W, z: 0 });
    return [(a.fy + g.y) / W, (a.fz + g.z) / W, a.tx / scaleM];
  };

  // Initial guess from the linear lift curve.
  const clNeed = (W * Math.cos(gamma)) / (qbar * ac.wingArea);
  const cl0 = liftCoefficient(0, flapsDeg, cfg);
  let x = [(clNeed - cl0) / ac.aero.clAlpha, 0.5, 0];
  let r = residual(x);
  const norm1 = (v: number[]) => Math.abs(v[0]!) + Math.abs(v[1]!) + Math.abs(v[2]!);
  for (let it = 0; it < 40; it++) {
    const norm = norm1(r);
    if (norm < 1e-12) break;
    const J: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let j = 0; j < 3; j++) {
      const xp = x.slice();
      xp[j]! += 1e-6;
      const rp = residual(xp);
      for (let i = 0; i < 3; i++) J[i]![j] = (rp[i]! - r[i]!) / 1e-6;
    }
    const dx = solve3(J, r);
    if (!dx) break;
    // Damped Newton step, keeping alpha on the attached part of the lift curve.
    let lambda = 1;
    let next = x;
    let rn = r;
    for (let k = 0; k < 8; k++) {
      next = [x[0]! - lambda * dx[0]!, x[1]! - lambda * dx[1]!, x[2]! - lambda * dx[2]!];
      next[0] = Math.max(-0.3, Math.min(0.35, next[0]!));
      rn = residual(next);
      if (norm1(rn) < norm) break;
      lambda *= 0.5;
    }
    x = next;
    r = rn;
  }

  const [alpha, powerRaw, trimRaw] = x as [number, number, number];
  const throttleRaw = engineThrottleForPower(powerRaw, rho, cfg);
  const throttle = Math.max(0, Math.min(1, throttleRaw));
  const elevatorTrim = Math.max(-1, Math.min(1, trimRaw));
  // Never more power than the engine can make here.
  const power = Math.max(0, Math.min(powerRaw, enginePowerTarget(1, rho, cfg)));
  return {
    alpha,
    pitchDeg: (gamma + alpha) / DEG,
    tas: V,
    density: rho,
    power,
    throttle,
    elevatorTrim,
    flapsDeg,
    converged: norm1(r) < 1e-6 && throttle === throttleRaw && elevatorTrim === trimRaw && powerRaw >= 0,
  };
}
