/**
 * What the camera remembers between frames, as plain data.
 *
 * Its own module so that `placement.ts` can describe a mode's geometry without
 * importing the controller that owns the state — the dependency would be a
 * cycle, and the arithmetic does not need the class.
 */

import type { CameraMode } from './frame';

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
