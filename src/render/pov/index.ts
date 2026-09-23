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

import { DEG2RAD, clamp, geodeticToEcef, type Vec3 } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import type { SampledAircraft } from '@/state/traffic';
import { aircraftFrame, type AircraftFrame, type CameraMode } from './frame';

export { CAMERA_MODES, aircraftFrame } from './frame';
export type { AircraftFrame, CameraMode, CameraModeInfo } from './frame';

/** Metres of clearance the camera keeps above terrain. */
const TERRAIN_CLEARANCE_M = 8;

/** Scratch, reused: see the note in `frame.ts`. */
const _quat = new Quaternion();
const _tmp = new Vector3();
const _basis = new Matrix4();

/** Orientation looking along `forward` with `up` as the vertical reference. */
function lookQuaternion(forward: Vector3, up: Vector3, out: Quaternion): Quaternion {
  // Three's cameras look down -Z, so +Z is "backwards".
  _tmp.copy(forward).negate().normalize();
  const right = new Vector3().crossVectors(up, _tmp).normalize();
  const trueUp = new Vector3().crossVectors(_tmp, right).normalize();
  _basis.makeBasis(right, trueUp, _tmp);
  return out.setFromRotationMatrix(_basis);
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

  private readonly smoothedPosition = new Vector3();
  private readonly smoothedQuaternion = new Quaternion();
  private initialised = false;

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

  /** Mouse drag: look around in cockpit/chase, orbit in orbit mode. */
  applyDrag(dx: number, dy: number): void {
    if (this.state.mode === 'orbit') {
      this.state.orbitYaw -= dx * 0.005;
      this.state.orbitPitch = clamp(this.state.orbitPitch + dy * 0.005, -1.4, 1.4);
    } else {
      this.state.lookYaw = clamp(this.state.lookYaw - dx * 0.004, -Math.PI, Math.PI);
      this.state.lookPitch = clamp(this.state.lookPitch + dy * 0.004, -1.2, 1.2);
    }
  }

  applyZoom(delta: number): void {
    if (this.state.mode !== 'orbit') return;
    this.state.orbitDistance = clamp(this.state.orbitDistance * Math.exp(delta * 0.001), 25, 4000);
  }

  /** Recentre the free look. */
  recentre(): void {
    this.state.lookYaw = 0;
    this.state.lookPitch = 0;
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
    const frame = aircraftFrame(sample);

    const desiredPosition = new Vector3();
    const desiredForward = new Vector3();
    const desiredUp = new Vector3().copy(frame.up);

    // Scale offsets with the airframe so a light aircraft is not viewed from
    // where an A380's tail would be.
    const size = this.airframeScale(sample);

    switch (this.state.mode) {
      case 'cockpit': {
        // Eye point: forward of the centre of mass, a little above the axis.
        desiredPosition
          .set(frame.position[0], frame.position[1], frame.position[2])
          .addScaledVector(frame.forward, size * 0.42)
          .addScaledVector(frame.up, size * 0.07);
        desiredForward.copy(frame.forward);
        break;
      }

      case 'chase': {
        desiredPosition
          .set(frame.position[0], frame.position[1], frame.position[2])
          .addScaledVector(frame.forward, -size * 2.6)
          .addScaledVector(frame.localUp, size * 0.7);
        desiredForward
          .set(frame.position[0], frame.position[1], frame.position[2])
          .sub(desiredPosition)
          .normalize();
        // Chase uses the local vertical, not the body's: a chase camera that
        // rolls with the aircraft is disorienting rather than immersive.
        desiredUp.copy(frame.localUp);
        break;
      }

      case 'wing': {
        desiredPosition
          .set(frame.position[0], frame.position[1], frame.position[2])
          .addScaledVector(frame.right, -size * 1.3)
          .addScaledVector(frame.up, size * 0.12)
          .addScaledVector(frame.forward, -size * 0.1);
        desiredForward
          .set(frame.position[0], frame.position[1], frame.position[2])
          .sub(desiredPosition)
          .normalize();
        break;
      }

      case 'orbit': {
        const { orbitYaw, orbitPitch, orbitDistance } = this.state;
        const offset = new Vector3()
          .addScaledVector(frame.forward, Math.cos(orbitPitch) * Math.cos(orbitYaw))
          .addScaledVector(frame.right, Math.cos(orbitPitch) * Math.sin(orbitYaw))
          .addScaledVector(frame.localUp, Math.sin(orbitPitch))
          .normalize()
          .multiplyScalar(orbitDistance);

        desiredPosition
          .set(frame.position[0], frame.position[1], frame.position[2])
          .add(offset);
        desiredForward.copy(offset).negate().normalize();
        desiredUp.copy(frame.localUp);
        break;
      }

      case 'tower': {
        // A fixed point on the ground, placed once, ahead of and beside the
        // aircraft so it flies past rather than away.
        this.towerAnchor ??= this.pickTowerAnchor(sample, terrainHeightAt);
        desiredPosition.set(this.towerAnchor[0], this.towerAnchor[1], this.towerAnchor[2]);
        desiredForward
          .set(frame.position[0], frame.position[1], frame.position[2])
          .sub(desiredPosition)
          .normalize();

        const towerUp = new Vector3(
          this.towerAnchor[0],
          this.towerAnchor[1],
          this.towerAnchor[2],
        ).normalize();
        desiredUp.copy(towerUp);
        break;
      }
    }

    // Free look, applied about the view's own axes.
    if (this.state.lookYaw !== 0 || this.state.lookPitch !== 0) {
      const right = new Vector3().crossVectors(desiredForward, desiredUp).normalize();
      _quat.setFromAxisAngle(desiredUp, this.state.lookYaw);
      desiredForward.applyQuaternion(_quat);
      _quat.setFromAxisAngle(right, this.state.lookPitch);
      desiredForward.applyQuaternion(_quat).normalize();
    }

    // Terrain clearance for the external views. The cockpit deliberately does
    // not get this: if the aircraft is below the terrain the data says so, and
    // silently lifting the camera would hide a real problem.
    if (terrainHeightAt && this.state.mode !== 'cockpit') {
      this.liftAboveTerrain(desiredPosition, terrainHeightAt);
    }

    const desiredQuaternion = lookQuaternion(desiredForward, desiredUp, new Quaternion());

    if (!this.initialised) {
      this.smoothedPosition.copy(desiredPosition);
      this.smoothedQuaternion.copy(desiredQuaternion);
      this.initialised = true;
    } else {
      // Frame-rate independent exponential smoothing. Position is nearly
      // rigid; orientation lags enough to feel hand-held.
      const posK = 1 - Math.exp(-dt / 0.04);
      const rotK = 1 - Math.exp(-dt / (this.state.mode === 'cockpit' ? 0.08 : 0.18));
      this.smoothedPosition.lerp(desiredPosition, posK);
      this.smoothedQuaternion.slerp(desiredQuaternion, rotK);
    }

    // Keep the floating origin under the camera before writing render-space
    // coordinates, or the first frame after a rebase is placed against the old
    // origin and the world jumps.
    const camEcef: Vec3 = [
      this.smoothedPosition.x,
      this.smoothedPosition.y,
      this.smoothedPosition.z,
    ];
    this.origin.maybeRebase(camEcef);

    camera.position.set(
      camEcef[0] - this.origin.current[0],
      camEcef[1] - this.origin.current[1],
      camEcef[2] - this.origin.current[2],
    );
    camera.quaternion.copy(this.smoothedQuaternion);
    camera.updateMatrixWorld();

    return frame;
  }

  /** Rough airframe length in metres, from the ADS-B emitter category. */
  private airframeScale(sample: SampledAircraft): number {
    switch (sample.latest.category) {
      case 'A1': return 10;   // light
      case 'A2': return 20;   // small
      case 'A3': return 40;   // large — 737/A320 class
      case 'A4': return 55;   // high-vortex large — 757
      case 'A5': return 70;   // heavy — 777/747/A350
      case 'A6': return 25;   // high performance
      case 'A7': return 15;   // rotorcraft
      case 'B1': return 12;   // glider
      case 'B2': return 30;   // lighter-than-air
      case 'B4': return 8;    // ultralight
      case 'B6': return 6;    // UAV
      default: return 35;
    }
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
  }
}
