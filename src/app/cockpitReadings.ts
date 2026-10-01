/**
 * Filling the cockpit's readings from the feed, and the traffic around for
 * the radar and the navigation display.
 *
 * Directions to other aircraft are taken in the frame the cockpit is drawn in
 * — the attitude the camera was built on — so a contact sits where the
 * aircraft is, not a frame of smoothing away from it.
 */

import { Quaternion, Vector3 } from 'three';

import type { CockpitReadings } from '@/render/cockpit';
import type { SampledAircraft } from '@/state/traffic';

const FT = 3.280_84;
const _inv = new Quaternion();
const _d = new Vector3();

/** What the feed says, and what it does not (left null). */
export function readingsFromSample(r: CockpitReadings, s: SampledAircraft, groundM: number | null): void {
  r.iasKt = s.latest.iasKt ?? s.groundSpeedKt;
  r.gsKt = s.groundSpeedKt;
  r.mach = s.latest.mach ?? null;
  r.altFt = s.altFt;
  r.aglFt = groundM !== null && Number.isFinite(groundM) ? s.altFt - groundM * FT : null;
  r.vsFpm = s.verticalRateFpm;
  r.headingDeg = s.headingDeg;
  r.trackDeg = s.trackDeg;
  r.pitchDeg = s.pitchDeg;
  r.rollDeg = s.rollDeg;
  r.aoaDeg = null;
  r.betaDeg = null;
  r.g = null;
  r.throttle = null;
  r.afterburner = 0;
  r.rpm = null;
  r.flapsDeg = null;
  r.gear = s.latest.onGround ? 'down' : null;
  r.brake = false;
  r.speedBrake = false;
  r.stall = false;
  r.stallWarning = false;
  r.overspeed = false;
  r.windFromDeg = s.latest.windDirectionDeg ?? null;
  r.windKt = s.latest.windSpeedKt ?? null;
  r.stickX = Math.max(-1, Math.min(1, s.rollDeg / 30)) * 0.3;
  r.stickY = 0;
}

/**
 * The traffic around, in the cockpit's frame. `eye` is the camera, render
 * space; `body` the cockpit's attitude (camera convention, −Z forward).
 */
export function fillContacts(
  r: CockpitReadings,
  inRange: readonly { hex: string; position: Vector3; distanceM: number; sample: SampledAircraft }[],
  eye: Vector3,
  body: Quaternion,
  ownAltFt: number,
): void {
  _inv.copy(body).invert();
  r.contacts.length = 0;
  for (const c of inRange) {
    _d.copy(c.position).sub(eye);
    const range = _d.length();
    if (range < 1) continue;
    _d.divideScalar(range).applyQuaternion(_inv);
    // Bearing off the nose in the aircraft's own horizontal plane.
    r.contacts.push({ az: Math.atan2(_d.x, -_d.z), rangeM: range, relAltFt: c.sample.altFt - ownAltFt });
    if (r.contacts.length >= 40) break;
  }
}
