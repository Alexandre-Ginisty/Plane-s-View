/**
 * First-person camera. Every mode is built from the same body frame; the list
 * lives in `frame.ts`.
 *
 * ## Why the camera is smoothed *again*
 *
 * The track is already Kalman-filtered, so placing the camera directly on its
 * output is tempting and unwatchable: the filter's job is to estimate where
 * the aircraft is, not to be pleasant to sit inside, and its small continuous
 * corrections read as a permanent tremor one metre from your eye. A second,
 * much softer smoothing on the camera pose removes it without noticeable lag.
 *
 * ## Terrain clearance
 *
 * Every external mode is lifted above the sampled terrain height. A camera on
 * a barometric altitude, or on an aircraft parked at an elevated airport, ends
 * up inside a mountain — which renders as a full-screen texture and looks like
 * a crash rather than a camera placement.
 */

import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';

import { DEG2RAD, FEET_TO_METRES, clamp, type Vec3 } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import type { SampledAircraft } from '@/state/traffic';
import { registry } from '@/data/meta/registry';
import { shapeFor, type AirframeShape } from '@/render/aircraft';
import { GROUND_CHECK_CEILING_M, clearanceFor, surfaceAltitudeM } from '@/render/ground';
import { aircraftFrame, bearingOf, type AircraftFrame, type CameraMode } from './frame';
import { placeCamera } from './placement';
import type { PovState } from './state';

export type { PovState } from './state';

export { CAMERA_MODES, aircraftFrame } from './frame';
export type { AircraftFrame, CameraMode } from './frame';

/** Metres of clearance the camera keeps above terrain. */
const TERRAIN_CLEARANCE_M = 8;

/**
 * Drag sensitivity, as a multiple of one-to-one with the cursor.
 *
 * These used to be flat constants — 0.005 rad/px — roughly *five times* the
 * angle the pixel under the cursor actually moved through. No amount of
 * smoothing fixes a gain that is simply wrong; it only makes the overshoot
 * arrive late as well.
 *
 * Orbit is exactly one-to-one, so the point you grabbed stays under the
 * cursor. Free look gets more, because you cannot drag across three screen
 * widths to look over your shoulder — at 2.2 a quarter turn is two thirds of
 * a screen.
 */
const ORBIT_DRAG_GAIN = 1;
const LOOK_DRAG_GAIN = 2.2;

/**
 * How hard the *aircraft's own motion* is damped, per mode, seconds.
 *
 * ## Zero in every external view, and that is the point
 *
 * These used to be 0.1-0.12, on the reasoning that damping the anchor hides
 * the track filter's jitter. In a view whose subject is the aeroplane it does
 * the exact opposite, and it took a report of "l'avion tremble" to see why.
 *
 * An external camera is placed at `anchor + offset` and aimed back at
 * `anchor`, while the model is drawn at the aircraft's true position. Where
 * the aeroplane lands on screen is therefore governed by
 * `aircraft - smoothedAnchor` — the *residual* of the damping. Damping does
 * not remove that residual; damping is what creates it. Every wobble in the
 * filter becomes a wobble of the subject against a stationary frame, which is
 * the most visible place it could possibly be put.
 *
 * With no damping the anchor is the drawn position exactly, so the aeroplane
 * is pinned to the centre of frame by construction and cannot move relative to
 * the camera at all. The residual has not vanished — it now moves the *world*
 * instead, and a few metres of terrain shift seen from a kilometre away is
 * invisible, where the same few metres on the subject are not.
 *
 * The cockpit keeps its damping, because there the camera *is* the subject:
 * the residual moves the whole view, and that is the one case the smoothing
 * was actually written for.
 */
const ANCHOR_TAU: Record<CameraMode, number> = {
  cockpit: 0.035,
  chase: 0,
  wing: 0,
  orbit: 0,
};

/**
 * Why the anchor is *predicted* forward before it is corrected.
 *
 * A first-order lag following a *moving* target never catches it: the
 * steady-state error is speed times the time constant, which at 480 knots and
 * 0.1 s is **twenty-five metres** — most of a fuselage. Every external view
 * aims at the damped anchor while the model is drawn at the true position, so
 * the aeroplane sat permanently off to one side of views whose entire purpose
 * is to centre it.
 *
 * So the anchor advances along the aircraft's own velocity each frame and the
 * damping acts only on what is left. The velocity comes from the feed rather
 * than from successive positions, and that choice matters: an alpha-beta
 * filter learning the rate from the residual was tried first and is quietly
 * unsafe. `dt` is clamped to 100 ms so a backgrounded tab cannot teleport the
 * world, but *positions* keep advancing with wall clock, so every stall hands
 * the filter a several-hundred-metre jump labelled one tenth of a second.
 * Measured here at 4741 m/s against a true 216.
 *
 * Reading the broadcast speed cannot diverge, because nothing accumulates.
 */

/**
 * Damping for the airframe's *attitude*, seconds.
 *
 * The track filter's continuous small corrections to pitch and roll are
 * invisible on a model fifty metres away and read as a permanent tremor when
 * the same airframe is one metre from your eye.
 */
const BODY_TAU = 0.09;

/** Time constant for the eased return to centre. See `recentre`. */
const RECENTRE_TAU = 0.18;

/** Radians per pixel before the first frame has reported the real viewport. */
const FALLBACK_RAD_PER_PX = (50 * DEG2RAD) / 800;

/** Scratch, reused: see the note in `frame.ts`. */
const _quat = new Quaternion();
const _tmp = new Vector3();
const _basis = new Matrix4();
const _right = new Vector3();
const _trueUp = new Vector3();
const _desiredPosition = new Vector3();
const _desiredForward = new Vector3();
const _desiredUp = new Vector3();
const _offset = new Vector3();
const _aircraft = new Vector3();
const _desiredQuat = new Quaternion();
const _bodyQuat = new Quaternion();
const _sForward = new Vector3();
const _sRight = new Vector3();
const _sUp = new Vector3();
const _residual = new Vector3();
const _velocity = new Vector3();
const _horizontal = new Vector3();

/** Orientation looking along `forward` with `up` as the vertical reference. */
function lookQuaternion(forward: Vector3, up: Vector3, out: Quaternion): Quaternion {
  // Three's cameras look down -Z, so +Z is "backwards".
  _tmp.copy(forward).negate().normalize();
  _right.crossVectors(up, _tmp).normalize();
  _trueUp.crossVectors(_tmp, _right).normalize();
  _basis.makeBasis(_right, _trueUp, _tmp);
  return out.setFromRotationMatrix(_basis);
}

/**
 * The aircraft's velocity in ECEF, from what it is broadcasting.
 *
 * Ground speed is along the *track*, `frame.forward` along the *heading*; the
 * two differ by the drift angle. Using the body axis is therefore wrong by
 * speed times the sine of that angle — under a metre for the damping to
 * absorb, against the twenty-five it exists to remove.
 */
function velocityOf(sample: SampledAircraft, frame: AircraftFrame, out: Vector3): Vector3 {
  const groundMps = sample.groundSpeedKt * 0.514_444;
  const verticalMps = (sample.verticalRateFpm * FEET_TO_METRES) / 60;

  _horizontal
    .copy(frame.forward)
    .addScaledVector(frame.localUp, -frame.forward.dot(frame.localUp));

  const length = _horizontal.length();
  if (length < 1e-6) return out.set(0, 0, 0);

  return out
    .copy(_horizontal)
    .multiplyScalar(groundMps / length)
    .addScaledVector(frame.localUp, verticalMps);
}

/** Modes whose whole job is to keep the aircraft in frame. */
function isSubjectLocked(mode: CameraMode): boolean {
  return mode !== 'cockpit';
}


export class PovController {
  readonly state: PovState = {
    mode: 'cockpit',
    orbitYaw: 0.6,
    orbitPitch: 0.25,
    orbitDistance: 90,
    lookYaw: 0,
    lookPitch: 0,
  };

  /** The aircraft's position, damped. The camera is built out from here. */
  private readonly smoothedAnchor = new Vector3();
  /** The aircraft's attitude, damped. Never mixed with the user's input. */
  private readonly smoothedBody = new Quaternion();
  private initialised = false;

  /** Set by `recentre`; cleared once the view has arrived back at centre. */
  private recentring = false;

  /** Where the wheel has asked the orbit distance to go; eased towards. */
  private orbitDistanceTarget = 90;
  /** Memoised airframe, and the hex it belongs to. See `airframeOf`. */
  private shape: AirframeShape | null = null;
  private shapeHex: string | null = null;
  /** Angle one pixel of drag subtends, from the live camera. */
  private radPerPx = FALLBACK_RAD_PER_PX;

  /**
   * Compass bearing the camera is actually looking along, degrees.
   *
   * Not the aircraft's heading. The HUD strip sits over the *view*, so it has
   * to describe the view: free look turns the head without turning the
   * aeroplane, and in the external modes the camera is not pointing along the
   * airframe at all. Feeding it the heading made the strip disagree with the
   * window it was drawn on.
   */
  private viewHeading = 0;

  get viewHeadingDeg(): number {
    return this.viewHeading;
  }

  constructor(private readonly origin: FloatingOrigin) {}

  setMode(mode: CameraMode): void {
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    this.state.lookYaw = 0;
    this.state.lookPitch = 0;
  }

  /**
   * Drag gain has to come from the live camera, not a constant: the same fifty
   * pixels mean a different rotation at a different field of view or window
   * height, and a fixed number is right for exactly one window size.
   */
  setViewport(radiansPerPixel: number): void {
    if (Number.isFinite(radiansPerPixel) && radiansPerPixel > 0) {
      this.radPerPx = radiansPerPixel;
    }
  }

  applyDrag(dx: number, dy: number): void {
    // Any drag cancels a return to centre: the hand wins over the animation.
    this.recentring = false;
    if (this.state.mode === 'orbit') {
      const k = this.radPerPx * ORBIT_DRAG_GAIN;
      this.state.orbitYaw -= dx * k;
      this.state.orbitPitch = clamp(this.state.orbitPitch + dy * k, -1.4, 1.4);
    } else {
      const k = this.radPerPx * LOOK_DRAG_GAIN;
      this.state.lookYaw = clamp(this.state.lookYaw - dx * k, -Math.PI, Math.PI);
      this.state.lookPitch = clamp(this.state.lookPitch + dy * k, -1.2, 1.2);
    }
  }

  applyZoom(delta: number): void {
    if (this.state.mode !== 'orbit') return;
    // The wheel moves a *target*; `update` eases the real distance towards it.
    // Applied directly, a trackpad's stream of small deltas reads as a stack
    // of discrete steps rather than as a zoom.
    this.orbitDistanceTarget = clamp(
      this.orbitDistanceTarget * Math.exp(delta * 0.001),
      25,
      4000,
    );
  }

  /**
   * Eased over a few frames rather than snapped. Snapping was a teleport: over
   * the wing one frame, dead ahead the next, with nothing on screen to explain
   * what moved. This is the one place a user-driven value is damped, and it is
   * damped precisely because the user is *not* driving it — they asked for it
   * to be put back.
   */
  recentre(): void {
    this.recentring = true;
  }

  /**
   * `terrainHeightAt` keeps the camera out of the ground in the external
   * views, which otherwise clip into hillsides on approach.
   */
  update(
    camera: PerspectiveCamera,
    sample: SampledAircraft,
    dt: number,
    terrainHeightAt?: (lat: number, lon: number) => number,
  ): AircraftFrame {
    // Everything else is measured against the airframe: the camera offsets,
    // and how far off the ground the aircraft itself sits.
    const shape = this.airframeOf(sample);

    /*
     * Put the aircraft on the ground before framing it.
     *
     * An aircraft on the surface reports no usable altitude, and the zero
     * standing in for it is the ellipsoid — seventy metres under Heathrow, a
     * hundred and sixty-five under Charles de Gaulle. Stepping into one put
     * the cockpit inside the planet. See `@/render/ground`.
     */
    let altM = sample.altFt * FEET_TO_METRES;
    if (terrainHeightAt && (sample.latest.onGround || altM < GROUND_CHECK_CEILING_M)) {
      altM = surfaceAltitudeM(
        altM,
        sample.latest.onGround,
        terrainHeightAt(sample.lat, sample.lon),
        clearanceFor(shape),
      );
    }

    const frame = aircraftFrame(sample, altM);

    const aircraft = _aircraft.set(frame.position[0], frame.position[1], frame.position[2]);

    /*
     * Damp the aircraft, then add the user. In that order, and never together.
     *
     * Everything used to go through one smoothing pass: the mode placed a
     * camera, the drag moved it, and the *result* was eased over 40-140 ms —
     * so the damping meant for the track filter's jitter also sat on the
     * mouse. The head turned late and kept turning after the hand stopped.
     * That was "la cam ça lag": input latency built in on purpose, for a
     * reason that only ever applied to the data.
     *
     * Damping is now confined to the two things that carry noise — where the
     * aircraft is and how it is oriented — and the camera is constructed *out*
     * from those each frame, with input applied to the result at full rate.
     */
    const firstFrame = !this.initialised;
    const bodyQuaternion = lookQuaternion(frame.forward, frame.up, _bodyQuat);

    const anchorTau = ANCHOR_TAU[this.state.mode];

    if (firstFrame || anchorTau === 0) {
      // Pinned to the drawn position. See the note above `ANCHOR_TAU`.
      this.smoothedAnchor.copy(aircraft);
      if (firstFrame) {
        this.smoothedBody.copy(bodyQuaternion);
        this.initialised = true;
      }
    } else {
      // Carry the anchor along the aircraft's own velocity, then damp only the
      // discrepancy that is left. See the note above `ANCHOR_TAU`.
      this.smoothedAnchor.addScaledVector(velocityOf(sample, frame, _velocity), dt);
      _residual.copy(aircraft).sub(this.smoothedAnchor);
      this.smoothedAnchor.addScaledVector(_residual, 1 - Math.exp(-dt / anchorTau));
    }

    if (!firstFrame) {
      this.smoothedBody.slerp(bodyQuaternion, 1 - Math.exp(-dt / BODY_TAU));
    }

    // The damped body axes. Three's cameras look down -Z, so forward is -Z.
    const sForward = _sForward.set(0, 0, -1).applyQuaternion(this.smoothedBody);
    const sUp = _sUp.set(0, 1, 0).applyQuaternion(this.smoothedBody);
    const sRight = _sRight.set(1, 0, 0).applyQuaternion(this.smoothedBody);

    // Ease the wheel's target rather than jumping to it. See `applyZoom`.
    this.state.orbitDistance +=
      (this.orbitDistanceTarget - this.state.orbitDistance) * (1 - Math.exp(-dt / 0.12));

    if (this.recentring) {
      const k = 1 - Math.exp(-dt / RECENTRE_TAU);
      this.state.lookYaw -= this.state.lookYaw * k;
      this.state.lookPitch -= this.state.lookPitch * k;
      if (Math.abs(this.state.lookYaw) < 1e-3 && Math.abs(this.state.lookPitch) < 1e-3) {
        this.state.lookYaw = 0;
        this.state.lookPitch = 0;
        this.recentring = false;
      }
    }

    const anchor = this.smoothedAnchor;
    const position = _desiredPosition.set(0, 0, 0);
    const forward = _desiredForward.set(0, 0, 0);
    const up = _desiredUp.copy(sUp);

    // Scale offsets with the airframe so a light aircraft is not viewed from
    // where an A380's tail would be.
    const size = shape.length;

    placeCamera(
      this.state.mode,
      this.state,
      anchor,
      { forward: sForward, right: sRight, up: sUp },
      frame,
      size,
      _offset,
      { position, forward, up },
    );

    // Terrain clearance for the external views. The cockpit deliberately does
    // not get this: if the aircraft is below the terrain the data says so, and
    // silently lifting the camera would hide a real problem.
    const subjectLocked = isSubjectLocked(this.state.mode);
    if (terrainHeightAt && subjectLocked) {
      this.liftAboveTerrain(position, terrainHeightAt);
    }

    /*
     * Aim at the damped aircraft, from wherever the camera ended up.
     *
     * For every view whose job is to watch the aircraft this pins it to the
     * centre of frame by construction, including after the terrain lift has
     * moved the camera out from under a hillside.
     */
    if (subjectLocked) {
      forward.copy(anchor).sub(position).normalize();
    }

    // Free look, applied about the view's own axes, at full rate.
    if (this.state.lookYaw !== 0 || this.state.lookPitch !== 0) {
      _right.crossVectors(forward, up).normalize();
      _quat.setFromAxisAngle(up, this.state.lookYaw);
      forward.applyQuaternion(_quat);
      _quat.setFromAxisAngle(_right, this.state.lookPitch);
      forward.applyQuaternion(_quat).normalize();
    }

    // Keep the floating origin under the camera before writing render-space
    // coordinates, or the first frame after a rebase is placed against the old
    // origin and the world jumps.
    const camEcef: Vec3 = [position.x, position.y, position.z];
    this.origin.maybeRebase(camEcef);

    camera.position.set(
      camEcef[0] - this.origin.current[0],
      camEcef[1] - this.origin.current[1],
      camEcef[2] - this.origin.current[2],
    );
    camera.quaternion.copy(lookQuaternion(forward, up, _desiredQuat));
    camera.updateMatrixWorld();

    this.viewHeading = bearingOf(forward, frame, this.viewHeading);

    return frame;
  }

  /** The airframe currently being framed, for anything that has to match it. */
  get airframe(): AirframeShape | null {
    return this.shape;
  }

  /**
   * From the type code where there is one, falling back to the emitter
   * category — the same source `Traffic3D` and `OwnAircraft` use, which is the
   * point: the camera used to sit where a 40 m aircraft's cockpit would be
   * while the model in front of it was 15 m long, because this read the
   * five-bucket category and they read the type. Memoised because the answer
   * cannot change while one aircraft is being flown, and this runs every frame.
   */
  private airframeOf(sample: SampledAircraft): AirframeShape {
    if (this.shapeHex !== sample.hex || !this.shape) {
      this.shape = shapeFor(registry.knownTypeCode(sample.hex), sample.latest.category ?? null);
      this.shapeHex = sample.hex;
    }
    return this.shape;
  }

  private liftAboveTerrain(
    position: Vector3,
    terrainHeightAt: (lat: number, lon: number) => number,
  ): void {
    const len = position.length();
    if (len < 1) return;

    // Cheap geodetic-ish conversion: good enough to decide a clearance lift.
    const lat = Math.asin(clamp(position.z / len, -1, 1)) * (180 / Math.PI);
    const lon = Math.atan2(position.y, position.x) * (180 / Math.PI);

    const ground = terrainHeightAt(lat, lon);
    const ellipsoidRadius = this.approximateRadius(lat);
    const altitude = len - ellipsoidRadius;

    if (altitude < ground + TERRAIN_CLEARANCE_M) {
      const lift = ground + TERRAIN_CLEARANCE_M - altitude;
      position.multiplyScalar((len + lift) / len);
    }
  }

  /** Ellipsoid radius at a geodetic latitude — adequate for clearance tests. */
  private approximateRadius(latDeg: number): number {
    const lat = latDeg * DEG2RAD;
    const a = 6378137.0;
    const b = 6356752.314245;
    const cos = Math.cos(lat);
    const sin = Math.sin(lat);
    const num = (a * a * cos) ** 2 + (b * b * sin) ** 2;
    const den = (a * cos) ** 2 + (b * sin) ** 2;
    return Math.sqrt(num / den);
  }

  reset(): void {
    this.initialised = false;
    this.orbitDistanceTarget = this.state.orbitDistance;
  }
}
