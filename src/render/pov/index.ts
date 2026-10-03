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

import { Euler, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';

import { DEG2RAD, FEET_TO_METRES, clamp, type Vec3 } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import type { SampledAircraft } from '@/state/traffic';
import { registry } from '@/data/meta/registry';
import { shapeFor, type AirframeShape } from '@/render/aircraft';
import {
  GROUND_CHECK_CEILING_M,
  GroundMemory,
  clearanceFor,
  surfaceAltitudeM,
} from '@/render/ground';
import { aircraftFrame, isInterior, type AircraftFrame, type CameraMode } from './frame';
import { placeCamera } from './placement';
import type { PovState } from './state';

export type { PovState } from './state';

export { CAMERA_MODES, aircraftFrame, isInterior } from './frame';
export type { AircraftFrame, CameraGroup, CameraMode } from './frame';

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

/*
 * ## Which way a drag goes
 *
 * One rule for every view: **the camera goes where the hand goes.** Drag right
 * and the view turns right (cockpit) or the camera swings round to the right
 * of the aircraft (every outside view); drag down and the view drops, or the
 * camera sinks.
 *
 * It used to be half of that. Horizontal drags followed the hand and vertical
 * ones grabbed the world, so pulling the mouse down tipped the cockpit view up
 * at the sky and lifted the orbit camera over the top — "quand je descends ça
 * monte". Each axis on its own was a defensible convention; the pair was not.
 * Anyone who wants the old vertical back has `invertY`.
 *
 * Chase and wing orbit too, rather than turning the head. Free look in an
 * outside view swung the aircraft straight off the screen, which is never
 * what dragging over the subject of the shot is for.
 */

/** How far below and above its home position an outside view may swing, radians. */
const SWING_PITCH_MIN = -1.25;
const SWING_PITCH_MAX = 0.45;

/** Cockpit zoom: the narrowest field of view the wheel reaches, degrees. */
const MIN_FOV_DEG = 16;

/** How long a change of camera takes, seconds. */
const MODE_TRANSITION_S = 0.85;

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
  cabin: 0.035,
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

/**
 * The flight between two aircraft, when switching from one to the other.
 *
 * Long enough to see where you are going and to keep your bearings, short
 * enough never to feel like waiting: scaled with the distance, within these
 * bounds, seconds.
 */
const TRANSITION_MIN_S = 1.4;
const TRANSITION_MAX_S = 3.2;
/** Seconds of transition per kilometre travelled, before the bounds apply. */
const TRANSITION_S_PER_KM = 0.09;

/** Smooth start, smooth arrival, no jerk at either end (quintic). */
function smootherstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

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
const _radial = new Vector3();
const _startQuat = new Quaternion();
const _swing = new Vector3();
/**
 * The vertical field of view for a screen taller than it is wide.
 *
 * The lens is set vertically, so a phone held upright saw a slot of the world
 * a third as wide as a laptop did — one wing, or half a windscreen. Widened
 * here by the square root of the aspect, half way to matching the landscape
 * width in angle, and capped short of fisheye.
 */
function portraitFov(fovDeg: number, aspect: number): number {
  if (!(aspect > 0) || aspect >= 1) return fovDeg;
  const half = Math.atan(Math.tan((fovDeg * Math.PI) / 360) / Math.sqrt(aspect));
  return Math.min(85, (half * 360) / Math.PI);
}

const _shake = new Quaternion();
const _shakeEuler = new Euler();
const _swingAxis = new Vector3();

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
  return !isInterior(mode);
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

  /**
   * The camera pose a switch started from, in absolute ECEF so a rebase of
   * the floating origin mid-flight cannot move it. Null when not switching.
   */
  private transition: {
    from: Vector3;
    fromQuat: Quaternion;
    elapsed: number;
    duration: number;
    arc: number;
  } | null = null;

  /** Set by `recentre`; cleared once the view has arrived back at centre. */
  private recentring = false;

  /** Flip vertical drags, for anyone who prefers to grab the world. */
  invertY = false;

  /** 0..1 how hard the airframe is shaking (buffet, a blast, a touchdown). */
  shake = 0;

  /** Degrees added to the lens with speed: a subtle sense of it, as in a real cockpit's peripheral vision. */
  speedFovDeg = 0;

  /**
   * Where the view from inside rests, radians: pitch below the boresight and
   * yaw left of the nose. With a cockpit drawn, the eye looks a little down,
   * the way simulators set their default view so the panel is in it as well
   * as the sky; from a window seat, it looks out of the window. Recentring
   * returns here.
   */
  private restPitch = 0;
  private restYaw = 0;

  setRestPitch(radians: number): void {
    this.setRestLook(0, radians);
  }

  setRestLook(yaw: number, pitch: number): void {
    if (yaw === this.restYaw && pitch === this.restPitch) return;
    // A view still at its old rest moves with it; one the user has turned stays turned.
    if (isInterior(this.state.mode) && Math.abs(this.state.lookPitch - this.restPitch) < 1e-6 && Math.abs(this.state.lookYaw - this.restYaw) < 1e-6) {
      this.state.lookPitch = pitch;
      this.state.lookYaw = yaw;
    }
    this.restPitch = pitch;
    this.restYaw = yaw;
  }

  /** The airframe's attitude the camera was built on this frame, shake included; camera convention. */
  readonly bodyQuaternion = new Quaternion();
  private shakeClock = 0;

  /** Outside views: how much nearer or further than home, eased towards. */
  private swingZoom = 1;
  private swingZoomTarget = 1;
  /** Cockpit: the field of view the wheel has asked for, and the resting one. */
  private fovTarget: number | null = null;
  private baseFov: number | null = null;

  /** Where the camera was last put, absolute ECEF, for a change of mode. */
  private readonly lastPosition = new Vector3();
  private readonly lastQuaternion = new Quaternion();

  /** Where the wheel has asked the orbit distance to go; eased towards. */
  private orbitDistanceTarget = 90;
  /** Memoised airframe, and the hex it belongs to. See `airframeOf`. */
  private shape: AirframeShape | null = null;
  private shapeHex: string | null = null;
  /** Angle one pixel of drag subtends, from the live camera. */
  private radPerPx = FALLBACK_RAD_PER_PX;

  /**
   * Where the ground was last known to be, for the approach.
   *
   * The camera has to agree with the model about the surface, or the aircraft
   * you are riding sinks relative to the view. Both consult the same tiles, so
   * both go blind at the same moment — and both have to remember.
   */
  private readonly ground = new GroundMemory();

  constructor(private readonly origin: FloatingOrigin) {}

  /**
   * Fly the camera from where it is now to wherever the next frames place it.
   *
   * Call right after the controller has been pointed at a new aircraft. The
   * normal camera logic keeps running underneath, so the destination is
   * always the live one — the aircraft keeps moving during the flight, and
   * the camera arrives exactly where it would have been anyway, with nothing
   * to settle afterwards. The path is an arc, so a jump between two aircraft
   * at the same height passes above the space between them instead of
   * skimming straight across it.
   */
  beginTransition(
    fromEcef: Vector3,
    fromQuat: Quaternion,
    toEcef: Vector3,
    options: { duration?: number; arc?: number } = {},
  ): void {
    const km = fromEcef.distanceTo(toEcef) / 1000;
    this.transition = {
      from: fromEcef.clone(),
      fromQuat: fromQuat.clone(),
      elapsed: 0,
      duration:
        options.duration ??
        Math.min(TRANSITION_MAX_S, Math.max(TRANSITION_MIN_S, TRANSITION_MIN_S + km * TRANSITION_S_PER_KM)),
      arc: options.arc ?? Math.min(2500, km * 1000 * 0.12),
    };
  }

  /** The camera's last pose, absolute ECEF, for handing to `beginTransition`. */
  get pose(): { position: Vector3; quaternion: Quaternion } {
    return { position: this.lastPosition, quaternion: this.lastQuaternion };
  }

  /** 0..1 through a switch, or null when not switching. */
  get transitionProgress(): number | null {
    const t = this.transition;
    return t ? Math.min(1, t.elapsed / t.duration) : null;
  }

  /**
   * Change view, and glide there.
   *
   * A cut between two views of the same aircraft throws away the one thing
   * that tells you they are the same aircraft. The camera flies from where it
   * was to the new placement over a moment instead — out of the cockpit and
   * round behind the tail, rather than a jump.
   */
  setMode(mode: CameraMode): void {
    if (this.state.mode === mode) return;
    if (this.initialised && !this.transition) {
      this.transition = {
        from: this.lastPosition.clone(),
        fromQuat: this.lastQuaternion.clone(),
        elapsed: 0,
        duration: MODE_TRANSITION_S,
        arc: 0,
      };
    }
    this.state.mode = mode;
    this.state.lookYaw = isInterior(mode) ? this.restYaw : 0;
    this.state.lookPitch = isInterior(mode) ? this.restPitch : 0;
    this.swingZoomTarget = 1;
    this.fovTarget = this.baseFov;
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
    // See "Which way a drag goes" above.
    const vy = this.invertY ? -dy : dy;
    switch (this.state.mode) {
      case 'orbit': {
        const k = this.radPerPx * ORBIT_DRAG_GAIN;
        this.state.orbitYaw -= dx * k;
        this.state.orbitPitch = clamp(this.state.orbitPitch - vy * k, -1.3, 1.4);
        return;
      }
      case 'cockpit':
      case 'cabin': {
        // Zoomed in, the same drag covers less of the world: keep the point
        // under the cursor under the cursor.
        const k = this.radPerPx * LOOK_DRAG_GAIN * this.zoomScale;
        this.state.lookYaw = clamp(this.state.lookYaw - dx * k, -Math.PI, Math.PI);
        this.state.lookPitch = clamp(this.state.lookPitch - vy * k, -1.2, 1.2);
        return;
      }
      default: {
        const k = this.radPerPx * ORBIT_DRAG_GAIN * 1.4;
        this.state.lookYaw += dx * k;
        this.state.lookPitch = clamp(this.state.lookPitch + vy * k, SWING_PITCH_MIN, SWING_PITCH_MAX);
      }
    }
  }

  /**
   * The wheel, in every view: nearer and further outside, a narrower lens in
   * the cockpit.
   *
   * It moves a *target*; `update` eases towards it. Applied directly, a
   * trackpad's stream of small deltas reads as a stack of discrete steps
   * rather than as a zoom.
   */
  applyZoom(delta: number): void {
    switch (this.state.mode) {
      case 'orbit':
        this.orbitDistanceTarget = clamp(this.orbitDistanceTarget * Math.exp(delta * 0.001), 25, 4000);
        return;
      case 'cockpit':
      case 'cabin': {
        if (this.baseFov === null) return;
        const current = this.fovTarget ?? this.baseFov;
        this.fovTarget = clamp(current * Math.exp(delta * 0.0008), MIN_FOV_DEG, this.baseFov);
        return;
      }
      default:
        this.swingZoomTarget = clamp(this.swingZoomTarget * Math.exp(delta * 0.001), 0.45, 4);
    }
  }

  /** How much a cockpit zoom has narrowed the view: 1 at rest. */
  private get zoomScale(): number {
    if (this.baseFov === null || this.fovTarget === null) return 1;
    return this.fovTarget / this.baseFov;
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
        this.ground.update(terrainHeightAt(sample.lat, sample.lon)),
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

    // Shake: a few incommensurate sines, not noise, so it reads as airframe
    // vibration rather than as a jittering camera. Applied to the airframe the
    // camera is built on, so the cockpit shakes with the head and the world
    // shakes against both.
    this.shakeClock += dt;
    const sk = this.shake * this.shake;
    this.bodyQuaternion.copy(this.smoothedBody);
    if (sk > 1e-4) {
      const t = this.shakeClock;
      const a = sk * 0.012;
      _shake.setFromEuler(
        _shakeEuler.set(
          a * (Math.sin(t * 37.1) + 0.6 * Math.sin(t * 71.3 + 1.1)),
          a * 0.6 * (Math.sin(t * 29.7 + 2.1) + 0.5 * Math.sin(t * 83.9)),
          a * (Math.sin(t * 43.3 + 0.7) + 0.4 * Math.sin(t * 97.1 + 2.3)),
        ),
      );
      this.bodyQuaternion.multiply(_shake);
    }

    // The damped body axes. Three's cameras look down -Z, so forward is -Z.
    const sForward = _sForward.set(0, 0, -1).applyQuaternion(this.bodyQuaternion);
    const sUp = _sUp.set(0, 1, 0).applyQuaternion(this.bodyQuaternion);
    const sRight = _sRight.set(1, 0, 0).applyQuaternion(this.bodyQuaternion);

    // Ease the wheel's target rather than jumping to it. See `applyZoom`.
    const zoomK = 1 - Math.exp(-dt / 0.12);
    this.state.orbitDistance += (this.orbitDistanceTarget - this.state.orbitDistance) * zoomK;
    this.swingZoom += (this.swingZoomTarget - this.swingZoom) * zoomK;
    this.easeFov(camera, zoomK);

    if (this.recentring) {
      const k = 1 - Math.exp(-dt / RECENTRE_TAU);
      const inside = isInterior(this.state.mode);
      const rest = inside ? this.restPitch : 0;
      const restYaw = inside ? this.restYaw : 0;
      this.state.lookYaw -= (this.state.lookYaw - restYaw) * k;
      this.state.lookPitch -= (this.state.lookPitch - rest) * k;
      this.swingZoomTarget = 1;
      this.fovTarget = this.baseFov;
      if (Math.abs(this.state.lookYaw - restYaw) < 1e-3 && Math.abs(this.state.lookPitch - rest) < 1e-3) {
        this.state.lookYaw = restYaw;
        this.state.lookPitch = rest;
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

    // Chase and wing: the drag swings the camera round the aircraft and the
    // wheel moves it nearer or further, about the aircraft rather than the eye.
    if (this.state.mode === 'chase' || this.state.mode === 'wing') {
      this.swingAround(position, anchor, frame.localUp);
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

    // Free look, applied about the view's own axes, at full rate. Cockpit
    // only: every other view swings the camera instead (see `swingAround`).
    if (!subjectLocked && (this.state.lookYaw !== 0 || this.state.lookPitch !== 0)) {
      _right.crossVectors(forward, up).normalize();
      _quat.setFromAxisAngle(up, this.state.lookYaw);
      forward.applyQuaternion(_quat);
      _quat.setFromAxisAngle(_right, this.state.lookPitch);
      forward.applyQuaternion(_quat).normalize();
    }

    // Keep the floating origin under the camera before writing render-space
    // coordinates, or the first frame after a rebase is placed against the old
    // origin and the world jumps.
    lookQuaternion(forward, up, _desiredQuat);

    // A switch between aircraft: blend from the old pose to the live new one.
    const tr = this.transition;
    if (tr) {
      tr.elapsed += dt;
      const t = Math.min(1, tr.elapsed / tr.duration);
      const e = smootherstep(t);
      _radial.copy(position).normalize();
      position.lerpVectors(tr.from, position, e).addScaledVector(_radial, Math.sin(Math.PI * e) * tr.arc);
      // The view turns a little ahead of the travel, so the destination is in
      // front of you for most of the flight rather than swinging round at the
      // end.
      _startQuat.copy(tr.fromQuat);
      _desiredQuat.copy(_startQuat.slerp(_desiredQuat, smootherstep(Math.min(1, t * 1.35))));
      if (t >= 1) this.transition = null;
    }

    this.lastPosition.copy(position);
    this.lastQuaternion.copy(_desiredQuat);

    const camEcef: Vec3 = [position.x, position.y, position.z];
    this.origin.maybeRebase(camEcef);

    camera.position.set(
      camEcef[0] - this.origin.current[0],
      camEcef[1] - this.origin.current[1],
      camEcef[2] - this.origin.current[2],
    );
    camera.quaternion.copy(_desiredQuat);
    camera.updateMatrixWorld();

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

  /**
   * Swing an outside camera round the aircraft: yaw about the local vertical,
   * pitch about the camera's own horizontal, then scale by the wheel.
   *
   * Positive yaw moves the camera to its right and positive pitch moves it
   * down, which is what makes "the camera goes where the hand goes" true.
   */
  private swingAround(position: Vector3, anchor: Vector3, localUp: Vector3): void {
    const { lookYaw, lookPitch } = this.state;
    if (lookYaw === 0 && lookPitch === 0 && this.swingZoom === 1) return;
    const offset = _swing.copy(position).sub(anchor);
    if (lookYaw !== 0) offset.applyQuaternion(_quat.setFromAxisAngle(localUp, lookYaw));
    if (lookPitch !== 0) {
      // The camera's right: forward (towards the anchor) crossed with up.
      _swingAxis.copy(offset).negate().cross(localUp);
      if (_swingAxis.lengthSq() > 1e-9) {
        offset.applyQuaternion(_quat.setFromAxisAngle(_swingAxis.normalize(), lookPitch));
      }
    }
    position.copy(anchor).addScaledVector(offset, this.swingZoom);
  }

  /** Ease the cockpit lens towards the wheel's target. */
  private easeFov(camera: PerspectiveCamera, k: number): void {
    this.baseFov ??= camera.fov;
    const target = portraitFov(
      (isInterior(this.state.mode) ? (this.fovTarget ?? this.baseFov) : this.baseFov) + this.speedFovDeg,
      camera.aspect,
    );
    if (Math.abs(camera.fov - target) < 0.01) return;
    camera.fov += (target - camera.fov) * k;
    if (Math.abs(camera.fov - target) < 0.02) camera.fov = target;
    camera.updateProjectionMatrix();
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
    this.swingZoom = this.swingZoomTarget = 1;
    this.fovTarget = this.baseFov;
    // A switch that was in flight belongs to the aircraft being left. A new
    // one, if any, is started by the caller after this.
    this.transition = null;
    this.ground.forget();
    this.orbitDistanceTarget = this.state.orbitDistance;
  }
}
