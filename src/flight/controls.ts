/**
 * Keyboard → smoothed `Controls`. Pure: the caller hands in the keys held and
 * the key-down edges since the last frame.
 *
 * Stick and pedals: the held key drives a rate-limited position, then a short
 * exponential smoothing, so a tap is a small input and a held key a full one.
 * Released, the ailerons and rudder return to centre briskly and the elevator
 * eases off slowly — a pilot relaxing back pressure — so a rotation or a flare
 * held with the keyboard does not drop the moment the key comes up.
 *
 * Key codes are `KeyboardEvent.code`, i.e. physical positions: on an AZERTY
 * keyboard W/A/S/D are the keys marked Z/Q/S/D.
 *
 * Adapted from Tater's Flight Sim (MIT, Copyright (c) 2026 Jared Tate — see
 * ./LICENSE).
 */

import type { Controls } from './types';
import { clamp, expApproach, moveToward } from './math';

/** Units/second the stick moves while a key is held. */
const PITCH_RATE = 2.2;
const ROLL_RATE = 2.8;
const YAW_RATE = 2.5;
/** Units/second back to centre when released (and on a reversal). */
const RETURN_RATE = 3.5;
const PITCH_RETURN_RATE = 0.8;
const SMOOTHING_TAU = 0.06;
/** Throttle travel per second. */
const THROTTLE_RATE = 0.45;
/** Trim travel per second. */
const TRIM_RATE = 0.35;
const BRAKE_APPLY_S = 0.15;
const BRAKE_RELEASE_S = 0.1;
const SNAP_EPS = 2.5e-3;

const FLIGHT_KEYS = {
  pitchDown: ['ArrowUp'],
  pitchUp: ['ArrowDown'],
  rollLeft: ['ArrowLeft'],
  rollRight: ['ArrowRight'],
  yawLeft: ['KeyA'],
  yawRight: ['KeyD'],
  throttleUp: ['KeyW', 'ShiftLeft', 'ShiftRight', 'PageUp'],
  throttleDown: ['KeyS', 'ControlLeft', 'ControlRight', 'PageDown'],
  flapsDown: ['KeyF'],
  flapsUp: ['KeyV'],
  gear: ['KeyG'],
  brake: ['KeyB'],
  speedBrake: ['KeyX'],
  trimNoseDown: ['BracketLeft', 'Home'],
  trimNoseUp: ['BracketRight', 'End'],
} as const;

/** Every code the flight controls use. */
export const FLIGHT_KEY_CODES: ReadonlySet<string> = new Set(Object.values(FLIGHT_KEYS).flat());

export interface ControlState {
  controls: Controls;
  /** Rate-limited stick and pedal positions before smoothing. */
  raw: { elevator: number; aileron: number; rudder: number };
  keyBrake: number;
}

export function createControlState(controls: Controls): ControlState {
  return {
    controls: { ...controls },
    raw: { elevator: controls.elevator, aileron: controls.aileron, rudder: controls.rudder },
    keyBrake: clamp(controls.brake, 0, 1),
  };
}

function stepAxis(raw: number, smoothed: number, key: number | null, rate: number, returnRate: number, dt: number) {
  let r = raw;
  if (key !== null) {
    const target = key;
    const k = target === 0 ? RETURN_RATE : r * target < 0 ? Math.max(rate, RETURN_RATE) : rate;
    r = moveToward(r, target, k * dt);
  } else {
    r = moveToward(r, 0, returnRate * dt);
  }
  r = clamp(r, -1, 1);
  let v = expApproach(smoothed, r, SMOOTHING_TAU, dt);
  if (Math.abs(v - r) < SNAP_EPS) v = r;
  return { raw: r, value: clamp(v, -1, 1) };
}

/**
 * One frame of input.
 *
 * @param held codes of every key currently down
 * @param pressed key-down edges since the last frame, in order
 * @param flapNotches number of flap positions of the airframe
 */
export function updateControls(
  state: ControlState,
  held: ReadonlySet<string>,
  pressed: readonly string[],
  dt: number,
  flapNotches: number,
): ControlState {
  const t = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const isDown = (codes: readonly string[]) => codes.some((code) => held.has(code));
  const prev = state.controls;
  let flapsNotch = prev.flapsNotch;
  let gearDown = prev.gearDown;
  let speedBrake = prev.speedBrake ?? false;
  const maxNotch = Math.max(0, flapNotches - 1);

  for (const code of pressed) {
    if ((FLIGHT_KEYS.flapsDown as readonly string[]).includes(code)) flapsNotch = Math.min(maxNotch, flapsNotch + 1);
    if ((FLIGHT_KEYS.flapsUp as readonly string[]).includes(code)) flapsNotch = Math.max(0, flapsNotch - 1);
    if ((FLIGHT_KEYS.gear as readonly string[]).includes(code)) gearDown = !gearDown;
    if ((FLIGHT_KEYS.speedBrake as readonly string[]).includes(code)) speedBrake = !speedBrake;
  }

  const keyAxis = (neg: readonly string[], pos: readonly string[]): number | null => {
    const n = isDown(neg);
    const p = isDown(pos);
    if (!n && !p) return null;
    return (p ? 1 : 0) - (n ? 1 : 0);
  };
  const elev = stepAxis(state.raw.elevator, prev.elevator, keyAxis(FLIGHT_KEYS.pitchDown, FLIGHT_KEYS.pitchUp), PITCH_RATE, PITCH_RETURN_RATE, t);
  const ail = stepAxis(state.raw.aileron, prev.aileron, keyAxis(FLIGHT_KEYS.rollLeft, FLIGHT_KEYS.rollRight), ROLL_RATE, RETURN_RATE, t);
  const rud = stepAxis(state.raw.rudder, prev.rudder, keyAxis(FLIGHT_KEYS.yawLeft, FLIGHT_KEYS.yawRight), YAW_RATE, RETURN_RATE, t);

  const dir = (isDown(FLIGHT_KEYS.throttleUp) ? 1 : 0) - (isDown(FLIGHT_KEYS.throttleDown) ? 1 : 0);
  const throttle = clamp(prev.throttle + dir * THROTTLE_RATE * t, 0, 1);
  const trimDir = (isDown(FLIGHT_KEYS.trimNoseUp) ? 1 : 0) - (isDown(FLIGHT_KEYS.trimNoseDown) ? 1 : 0);
  const elevatorTrim = clamp(prev.elevatorTrim + trimDir * TRIM_RATE * t, -1, 1);

  const brakeHeld = isDown(FLIGHT_KEYS.brake);
  const keyBrake = moveToward(state.keyBrake, brakeHeld ? 1 : 0, t / (brakeHeld ? BRAKE_APPLY_S : BRAKE_RELEASE_S));

  return {
    controls: {
      ...prev,
      throttle,
      elevator: elev.value,
      aileron: ail.value,
      rudder: rud.value,
      elevatorTrim,
      flapsNotch,
      gearDown,
      brake: keyBrake,
      speedBrake,
    },
    raw: { elevator: elev.raw, aileron: ail.raw, rudder: rud.raw },
    keyBrake,
  };
}
