/**
 * First-person camera.
 *
 * Rides the selected aircraft. Five modes, all built from the same body frame:
 * cockpit (inside, looking out), wing (on the wingtip), chase, orbit and
 * tower (a fixed ground observer watching it pass).
 *
 * ## Why the camera is smoothed *again*
 *
 * The track is already Kalman-filtered, so it is tempting to place the camera
 * directly on its output. That produces a view that is technically correct and
 * unwatchable: the filter's job is to estimate where the aircraft is, not to
 * be pleasant to sit inside, and its small continuous corrections read as a
 * permanent tremor when they are one metre from your eye. A second, much
 * softer critically-damped smoothing on the camera pose removes it without
 * introducing noticeable lag.
 *
 * ## Terrain clearance
 *
 * Every mode is lifted above the sampled terrain height. A camera placed on a
 * reported altitude that is barometric, or on an aircraft on the ground at an
 * elevated airport, would otherwise end up inside a mountain — and being
 * inside terrain renders as a full-screen texture, which looks like a crash
 * rather than a camera placement.
 */

import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';

import { DEG2RAD, FEET_TO_METRES, clamp, geodeticToEcef, type Vec3 } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import type { SampledAircraft } from '@/state/traffic';
import { registry } from '@/data/meta/registry';
import { shapeFor, type AirframeShape } from '@/render/aircraft';
import { GROUND_CHECK_CEILING_M, clearanceFor, surfaceAltitudeM } from '@/render/ground';
import { aircraftFrame, type AircraftFrame, type CameraMode } from './frame';

export { CAMERA_MODES, aircraftFrame } from './frame';
export type { AircraftFrame, CameraMode, CameraModeInfo } from './frame';

/** Metres of clearance the camera keeps above terrain. */
const TERRAIN_CLEARANCE_M = 8;

/**
 * Drag sensitivity, as a multiple of one-to-one with the cursor.
 *
 * The old figures were flat constants — 0.005 rad per pixel for orbit, 0.004
 * for free look — which at this field of view is roughly *five times* the
 * angle the pixel under the cursor actually moved through. Dragging therefore
 * threw the view about far faster than the hand expected, and no amount of
 * smoothing fixes a gain that is simply wrong; it only makes the overshoot
 * arrive late as well.
 *
 * Orbit is exactly one-to-one: the point you grabbed stays under the cursor,
 * which is what makes an orbit control feel attached to the object rather
 * than to a slider. Free look gets a little more, because you cannot drag
 * across three screen widths to look over your shoulder — at 2.2 a quarter
 * turn is about two thirds of a screen.
 */
const ORBIT_DRAG_GAIN = 1;
const LOOK_DRAG_GAIN = 2.2;

/**
 * How hard the *aircraft's own motion* is damped, per mode, seconds.
 *
 * This is the only thing that gets damped. See the note on `update`: the
 * user's own input is applied afterwards, undamped, because smoothing input is
 * not smoothing — it is lag.
 *
 * The cockpit is tight because you are bolted to the airframe and a soft
 * follow there reads as the aeroplane sliding around you. The external views
 * are slower because their lag becomes a gentle arc rather than a wobble: the
 * aim is recomputed from wherever the camera actually ended up, so the subject
 * cannot drift out of frame however far behind the body is.
 */
const ANCHOR_TAU: Record<CameraMode, number> = {
  cockpit: 0.035,
  chase: 0.12,
  wing: 0.12,
  orbit: 0.1,
  tower: 0.1,
};

/**
 * Why the anchor is *predicted* forward before it is corrected.
 *
 * `ANCHOR_TAU` on its own is a first-order lag, and a first-order lag
 * following a *moving* target never catches it: the steady-state error is
 * speed times the time constant, which at 480 knots and 0.1 s is **twenty-five
 * metres**. On an airliner that is most of a fuselage, and it showed exactly
 * as you would expect — every external view aims at the damped anchor while
 * the model is drawn at the true position, so the aeroplane sat permanently
 * off to one side of views whose entire purpose is to centre it. The faster
 * the aircraft, the further out of frame.
 *
 * The fix is to advance the anchor along the aircraft's own velocity each
 * frame and let the damping act only on what is left over. The velocity is
 * taken from the feed — ground speed along the track, plus the vertical rate —
 * rather than learned from successive positions, and that choice matters:
 *
 * An alpha-beta filter that learns the rate from the residual was tried first
 * and is quietly unsafe here. `dt` is clamped to 100 ms so a backgrounded tab
 * cannot teleport the world, but the *positions* keep advancing with wall
 * clock, so every stall hands the filter a jump of several hundred metres
 * labelled as one tenth of a second. It faithfully concludes the aircraft is
 * doing four thousand metres a second, and the camera is flung off into
 * space. Measured, in this application, at 4741 m/s against a true 216.
 *
 * Reading the speed the aircraft is broadcasting cannot diverge, because
 * nothing accumulates.
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
 * Ground speed is along the *track*, and `frame.forward` is along the
 * *heading*; the two differ by the drift angle, a few degrees in a strong
 * crosswind. Projecting the body axis onto the horizontal and using that is
 * therefore slightly wrong — by speed times the sine of the drift angle, which
 * is under a metre of residual for the damping to absorb, against the
 * twenty-five it exists to remove.
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


export interface PovState {
  mode: CameraMode;
  /** Orbit yaw / pitch, radians, relative to the aircraft's forward axis. */
  orbitYaw: number;
  orbitPitch: number;
  orbitDistance: number;
  /** Additional look-around within cockpit and chase views. */
  lookYaw: number;
  lookPitch: number;
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

  /** Ground viewpoint for tower mode, chosen when the mode is entered. */
  private towerAnchor: Vec3 | null = null;

  constructor(private readonly origin: FloatingOrigin) {}

  setMode(mode: CameraMode): void {
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    this.state.lookYaw = 0;
    this.state.lookPitch = 0;
    if (mode !== 'tower') this.towerAnchor = null;
  }

  /**
   * How much angle a pixel is worth, reported by the frame loop.
   *
   * Drag gain has to come from the live camera, not a constant: the same
   * fifty pixels mean a different rotation at a different field of view or
   * window height, and a fixed number is right for exactly one window size.
   */
  setViewport(radiansPerPixel: number): void {
    if (Number.isFinite(radiansPerPixel) && radiansPerPixel > 0) {
      this.radPerPx = radiansPerPixel;
    }
  }

  /** Mouse drag: look around in cockpit/chase, orbit in orbit mode. */
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
   * Return the free look to centre.
   *
   * Eased over a few frames rather than snapped. Snapping it was a teleport:
   * the view was looking over the wing one frame and dead ahead the next, with
   * nothing on screen to explain what moved, which reads as a glitch rather
   * than as a control. The easing is the one place a user-driven value is
   * damped, and it is damped precisely because the user is *not* driving it —
   * they asked for it to be put back.
   */
  recentre(): void {
    this.recentring = true;
  }

  /**
   * Position the camera for this frame.
   *
   * `terrainHeightAt` lets the controller keep the camera out of the ground in
   * the external views, which otherwise clip into hillsides on approach.
   */
  update(
    camera: PerspectiveCamera,
    sample: SampledAircraft,
    dt: number,
    terrainHeightAt?: (lat: number, lon: number) => number,
  ): AircraftFrame {
    /*
     * The airframe first, because everything else is measured against it: the
     * camera offsets, and how far off the ground the aircraft itself sits.
     */
    const shape = this.airframeOf(sample);

    /*
     * Put the aircraft on the ground before framing it.
     *
     * An aircraft on the surface reports no usable altitude at all, and the
     * zero that stands in for it is the ellipsoid — seventy metres under
     * Heathrow, a hundred and sixty-five under Charles de Gaulle. Stepping
     * into one put the cockpit inside the planet, looking at the underside of
     * the terrain. See `@/render/ground`.
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
     * camera, the user's drag moved that camera, and the *result* was eased
     * towards over 40-140 ms. So the damping meant for the track filter's
     * jitter was also sitting on the mouse. Dragging in orbit moved the
     * desired position and the view crawled after the cursor a seventh of a
     * second behind; in the cockpit the free look was slerped on an 80 ms
     * constant, so the head turned late and then kept turning after the hand
     * stopped. That is the "la cam ça lag" — not frame rate, and not the
     * filter. Input latency built in on purpose, for a reason that only ever
     * applied to the data.
     *
     * Now the damping is confined to the two things that actually carry noise
     * — where the aircraft is, and how it is oriented — and the camera is
     * constructed *out* from those each frame. User input is applied to the
     * result at full rate, so a drag is one-to-one with the hand and the
     * aeroplane still rides smoothly underneath it.
     */
    const firstFrame = !this.initialised;
    const bodyQuaternion = lookQuaternion(frame.forward, frame.up, _bodyQuat);

    if (firstFrame) {
      this.smoothedAnchor.copy(aircraft);
      this.smoothedBody.copy(bodyQuaternion);
      this.initialised = true;
    } else {
      // Carry the anchor along the aircraft's own velocity, then damp only the
      // discrepancy that is left. See the note above `ANCHOR_TAU`.
      this.smoothedAnchor.addScaledVector(velocityOf(sample, frame, _velocity), dt);
      _residual.copy(aircraft).sub(this.smoothedAnchor);
      this.smoothedAnchor.addScaledVector(
        _residual,
        1 - Math.exp(-dt / ANCHOR_TAU[this.state.mode]),
      );

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

    switch (this.state.mode) {
      case 'cockpit': {
        // Eye point: forward of the centre of mass, a little above the axis.
        position
          .copy(anchor)
          .addScaledVector(sForward, size * 0.42)
          .addScaledVector(sUp, size * 0.07);
        forward.copy(sForward);
        break;
      }

      case 'chase': {
        position
          .copy(anchor)
          .addScaledVector(sForward, -size * 2.6)
          .addScaledVector(frame.localUp, size * 0.7);
        // Chase uses the local vertical, not the body's: a chase camera that
        // rolls with the aircraft is disorienting rather than immersive.
        up.copy(frame.localUp);
        break;
      }

      case 'wing': {
        position
          .copy(anchor)
          .addScaledVector(sRight, -size * 1.3)
          .addScaledVector(sUp, size * 0.12)
          .addScaledVector(sForward, -size * 0.1);
        break;
      }

      case 'orbit': {
        const { orbitYaw, orbitPitch, orbitDistance } = this.state;
        const offset = _offset
          .set(0, 0, 0)
          .addScaledVector(sForward, Math.cos(orbitPitch) * Math.cos(orbitYaw))
          .addScaledVector(sRight, Math.cos(orbitPitch) * Math.sin(orbitYaw))
          .addScaledVector(frame.localUp, Math.sin(orbitPitch))
          .normalize()
          .multiplyScalar(orbitDistance);

        position.copy(anchor).add(offset);
        up.copy(frame.localUp);
        break;
      }

      case 'tower': {
        // A fixed point on the ground, placed once, ahead of and beside the
        // aircraft so it flies past rather than away.
        this.towerAnchor ??= this.pickTowerAnchor(sample, terrainHeightAt);
        position.set(this.towerAnchor[0], this.towerAnchor[1], this.towerAnchor[2]);
        up.copy(position).normalize();
        break;
      }
    }

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

    return frame;
  }

  /**
   * The airframe the camera is framing.
   *
   * From the type code where there is one, falling back to the emitter
   * category — the same source `Traffic3D` and `OwnAircraft` use, which is the
   * point: the camera used to sit where a 40 m aircraft's cockpit would be
   * while the model in front of it was 15 m long, because this read the
   * five-bucket category and they read the type. Memoised because the answer
   * cannot change while the same aircraft is being flown, and this runs every
   * frame.
   */
  /** The airframe currently being framed, for anything that has to match it. */
  get airframe(): AirframeShape | null {
    return this.shape;
  }

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

  private pickTowerAnchor(
    sample: SampledAircraft,
    terrainHeightAt?: (lat: number, lon: number) => number,
  ): Vec3 {
    // A couple of kilometres ahead and to the side, on the ground.
    const aheadDeg = 0.02;
    const bearing = sample.trackDeg * DEG2RAD;
    const lat = sample.lat + aheadDeg * Math.cos(bearing);
    const lon =
      sample.lon +
      (aheadDeg * Math.sin(bearing)) / Math.max(0.05, Math.cos(sample.lat * DEG2RAD)) +
      0.012;

    const ground = terrainHeightAt?.(lat, lon) ?? 0;
    return geodeticToEcef(lat, lon, ground + 25);
  }

  reset(): void {
    this.initialised = false;
    this.towerAnchor = null;
    this.orbitDistanceTarget = this.state.orbitDistance;
  }
}
