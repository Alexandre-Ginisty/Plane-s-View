/**
 * The single source of truth for frame conventions (see the header of
 * ./types). Every module converts between world, body and aircraft-convention
 * quantities through these helpers — never by hand.
 *
 * Adapted from Tater's Flight Sim (MIT, Copyright (c) 2026 Jared Tate — see
 * ./LICENSE).
 */

import type { Quat, Vec3 } from './types';
import { qFromAxisAngle, qMul, qRotate, qRotateInverse, wrap360 } from './math';

const DEG = Math.PI / 180;

const BODY_FORWARD: Vec3 = { x: 0, y: 0, z: -1 };
const BODY_RIGHT: Vec3 = { x: 1, y: 0, z: 0 };
const BODY_UP: Vec3 = { x: 0, y: 1, z: 0 };

/** Body -> world orientation from heading / pitch / roll, degrees. */
export function quatFromEuler(headingDeg: number, pitchDeg: number, rollDeg: number): Quat {
  const qYaw = qFromAxisAngle({ x: 0, y: 1, z: 0 }, -headingDeg * DEG);
  const qPitch = qFromAxisAngle({ x: 1, y: 0, z: 0 }, pitchDeg * DEG);
  const qRoll = qFromAxisAngle({ x: 0, y: 0, z: 1 }, -rollDeg * DEG);
  return qMul(qMul(qYaw, qPitch), qRoll);
}

interface Euler {
  /** 0..360, clockwise from north. */
  headingDeg: number;
  /** + nose up. */
  pitchDeg: number;
  /** + right wing down, -180..180. */
  rollDeg: number;
}

export function eulerFromQuat(q: Quat): Euler {
  const f = qRotate(q, BODY_FORWARD);
  const r = qRotate(q, BODY_RIGHT);
  const u = qRotate(q, BODY_UP);
  const pitch = Math.asin(Math.max(-1, Math.min(1, f.y)));
  let heading: number;
  if (Math.abs(f.y) < 0.9999) {
    heading = Math.atan2(f.x, -f.z);
  } else {
    // Straight up or down: heading from the up vector's horizontal direction.
    heading = Math.atan2(-u.x * Math.sign(f.y), u.z * Math.sign(f.y));
  }
  const roll = Math.atan2(-r.y, u.y);
  return { headingDeg: wrap360(heading / DEG), pitchDeg: pitch / DEG, rollDeg: roll / DEG };
}

export const worldToBody = (q: Quat, v: Vec3): Vec3 => qRotateInverse(q, v);
export const bodyToWorld = (q: Quat, v: Vec3): Vec3 => qRotate(q, v);

interface AirData {
  V: number;
  u: number;
  v: number;
  w: number;
  alpha: number;
  beta: number;
}

/** Air data from the body-frame velocity relative to the air. */
export function airDataFromBodyVelocity(vb: Vec3): AirData {
  const u = -vb.z;
  const v = vb.x;
  const w = -vb.y;
  const V = Math.sqrt(u * u + v * v + w * w);
  const alpha = Math.atan2(w, u);
  const beta = V > 1e-6 ? Math.asin(Math.max(-1, Math.min(1, v / V))) : 0;
  return { V, u, v, w, alpha, beta };
}

/** Aircraft-convention body rates from the body angular velocity. */
export function pqrFromOmega(omegaBody: Vec3): { p: number; q: number; r: number } {
  return { p: -omegaBody.z, q: omegaBody.x, r: -omegaBody.y };
}

/** Body torque from aircraft-convention moments. */
export function torqueFromLMN(L: number, M: number, N: number): Vec3 {
  return { x: M, y: -N, z: -L };
}
