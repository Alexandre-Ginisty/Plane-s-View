/**
 * The aircraft body frame, and the camera modes built on it.
 *
 * ## The frame
 *
 * ADS-B gives a track (the direction the aircraft is *moving*) and sometimes a
 * heading (the direction it is *pointing*). They differ by the drift angle,
 * which at cruise in a jet stream is several degrees — enough that a camera
 * aligned to track instead of heading sits visibly crabbed in the cockpit.
 * Heading is used when it is broadcast and track is the fallback.
 *
 * Roll and pitch come from `AircraftTrack`, which infers them from the turn
 * rate and the vertical speed when they are not broadcast. The basis built
 * here is right-handed with **+Y forward, +X starboard, +Z up**, matching the
 * aircraft geometry in `@/render/aircraft` so a model needs no correction.
 *
 * ## The scratch vectors
 *
 * Module-level and reused. `aircraftFrame` is called for every aircraft on
 * screen, every frame — a thousand of them at 60 Hz — and allocating six
 * vectors per call is the kind of churn that never shows as a frame spike and
 * always shows as a periodic GC pause.
 */

import { Quaternion, Vector3 } from 'three';
import {
  DEG2RAD,
  FEET_TO_METRES,
  enuBasis,
  geodeticToEcef,
  type Vec3,
} from '@/core/math/geo';
import type { SampledAircraft } from '@/state/traffic';

export type CameraMode = 'cockpit' | 'chase' | 'wing' | 'orbit' | 'tower';

export interface CameraModeInfo {
  id: CameraMode;
  label: string;
  hint: string;
}

export const CAMERA_MODES: readonly CameraModeInfo[] = [
  { id: 'cockpit', label: 'Cockpit', hint: 'Eyes forward from the flight deck' },
  { id: 'chase', label: 'Chase', hint: 'Behind and above, following the tail' },
  { id: 'wing', label: 'Wing', hint: 'Off the left wingtip, looking back in' },
  { id: 'orbit', label: 'Orbit', hint: 'Free look around the aircraft — drag to rotate' },
  { id: 'tower', label: 'Tower', hint: 'Fixed ground viewpoint watching it pass' },
];

export interface AircraftFrame {
  /** Aircraft position in ECEF. */
  position: Vec3;
  /** Unit vectors in ECEF. */
  forward: Vector3;
  right: Vector3;
  up: Vector3;
  /** Local vertical (ellipsoid normal), independent of attitude. */
  localUp: Vector3;
}

const _east = new Vector3();
const _north = new Vector3();
const _up = new Vector3();
const _forward = new Vector3();
const _right = new Vector3();
const _quat = new Quaternion();

/**
 * Build the aircraft's body axes in ECEF from its geodetic position and
 * heading / pitch / roll.
 */
export function aircraftFrame(sample: SampledAircraft): AircraftFrame {
  const altM = sample.altFt * FEET_TO_METRES;
  const position = geodeticToEcef(sample.lat, sample.lon, altM);
  const basis = enuBasis(sample.lat, sample.lon);

  _east.set(basis.east[0], basis.east[1], basis.east[2]);
  _north.set(basis.north[0], basis.north[1], basis.north[2]);
  _up.set(basis.up[0], basis.up[1], basis.up[2]);

  const localUp = _up.clone();

  // Heading: rotate in the horizontal plane, measured clockwise from north.
  const h = sample.headingDeg * DEG2RAD;
  _forward.copy(_north).multiplyScalar(Math.cos(h)).addScaledVector(_east, Math.sin(h));
  _right.crossVectors(_forward, _up).normalize();

  // Pitch: nose up about the right wing.
  const pitch = sample.pitchDeg * DEG2RAD;
  _quat.setFromAxisAngle(_right, pitch);
  const forward = _forward.clone().applyQuaternion(_quat).normalize();
  const up = _up.clone().applyQuaternion(_quat).normalize();

  // Roll: about the nose. Positive roll drops the right wing, so the up vector
  // tips towards the left — hence the negative angle about `forward`.
  const roll = sample.rollDeg * DEG2RAD;
  _quat.setFromAxisAngle(forward, -roll);
  up.applyQuaternion(_quat).normalize();
  const right = _right.clone().applyQuaternion(_quat).normalize();

  return { position, forward, right, up, localUp };
}
