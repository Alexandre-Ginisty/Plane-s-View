/**
 * Small immutable vector and quaternion helpers for the flight model.
 *
 * Adapted from Tater's Flight Sim (MIT, Copyright (c) 2026 Jared Tate — see
 * ./LICENSE). Same component layout as three's Quaternion (x, y, z, w).
 */

import type { Quat, Vec3 } from './types';

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Move `current` toward `target` by at most `maxDelta`. */
export const moveToward = (current: number, target: number, maxDelta: number): number =>
  Math.abs(target - current) <= maxDelta ? target : current + Math.sign(target - current) * maxDelta;

/** Frame-rate independent exponential approach with time constant `tau`. */
export const expApproach = (current: number, target: number, tau: number, dt: number): number =>
  tau <= 0 ? target : target + (current - target) * Math.exp(-dt / tau);

/** Degrees into [0, 360). */
export const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;

/** Hamilton product a·b (b first, then a). */
export const qMul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});

const qConj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

const qNormalize = (q: Quat): Quat => {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  return l > 1e-12 ? { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l } : { x: 0, y: 0, z: 0, w: 1 };
};

export const qFromAxisAngle = (axis: Vec3, angle: number): Quat => {
  const h = angle / 2;
  const s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
};

/** Rotate v by unit quaternion q. */
export const qRotate = (q: Quat, v: Vec3): Vec3 => {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
};

/** Rotate v by the inverse of q (world -> body when q is body -> world). */
export const qRotateInverse = (q: Quat, v: Vec3): Vec3 => qRotate(qConj(q), v);

/**
 * Integrate an orientation by a BODY-frame angular velocity over dt, with the
 * exact rotation for the step, renormalised.
 */
export const qIntegrateBody = (q: Quat, omegaBody: Vec3, dt: number): Quat => {
  const wx = omegaBody.x;
  const wy = omegaBody.y;
  const wz = omegaBody.z;
  const mag = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (mag < 1e-12) return q;
  const dq = qFromAxisAngle({ x: wx / mag, y: wy / mag, z: wz / mag }, mag * dt);
  return qNormalize(qMul(q, dq));
};
