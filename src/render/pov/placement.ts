/**
 * Where each camera mode puts the eye.
 *
 * Split out of the controller because it is the only part that is pure: given
 * an anchor, a set of body axes and an airframe size, each mode is one
 * arithmetic expression with no state behind it. What is left in the controller
 * is the stateful half — the damping, the free look, the terrain lift — and
 * keeping the two apart is what makes either of them readable.
 *
 * Every offset is scaled by the airframe's own length, so a Cessna is not
 * viewed from where an A380's tail would be. That is the single rule all four
 * modes obey, and it is why none of them carries an absolute distance.
 */

import type { Vector3 } from 'three';

import type { AircraftFrame, CameraMode } from './frame';
import type { PovState } from './state';

/** The damped body axes the camera is built from. */
export interface BodyAxes {
  forward: Vector3;
  right: Vector3;
  up: Vector3;
}

export interface Placement {
  /** Written in place: where the camera goes. */
  position: Vector3;
  /** Written in place, and only by `cockpit` — the others aim at the anchor. */
  forward: Vector3;
  /** Written in place: the view's vertical reference. */
  up: Vector3;
}

/**
 * Place the camera for a mode.
 *
 * `out` is written in place rather than returned, because this runs every
 * frame for a camera that already exists and allocating three vectors sixty
 * times a second is the kind of churn that never shows as a frame spike and
 * always shows as a periodic collection pause.
 */
export function placeCamera(
  mode: CameraMode,
  state: PovState,
  anchor: Vector3,
  axes: BodyAxes,
  frame: AircraftFrame,
  sizeM: number,
  offsetScratch: Vector3,
  out: Placement,
): void {
  switch (mode) {
    case 'cockpit': {
      // Eye point: forward of the centre of mass, a little above the axis.
      out.position
        .copy(anchor)
        .addScaledVector(axes.forward, sizeM * 0.42)
        .addScaledVector(axes.up, sizeM * 0.07);
      out.forward.copy(axes.forward);
      return;
    }

    case 'chase': {
      out.position
        .copy(anchor)
        .addScaledVector(axes.forward, -sizeM * 2.6)
        .addScaledVector(frame.localUp, sizeM * 0.7);
      // Chase uses the local vertical, not the body's: a chase camera that
      // rolls with the aircraft is disorienting rather than immersive.
      out.up.copy(frame.localUp);
      return;
    }

    case 'wing': {
      out.position
        .copy(anchor)
        .addScaledVector(axes.right, -sizeM * 1.3)
        .addScaledVector(axes.up, sizeM * 0.12)
        .addScaledVector(axes.forward, -sizeM * 0.1);
      return;
    }

    case 'orbit': {
      const { orbitYaw, orbitPitch, orbitDistance } = state;
      const offset = offsetScratch
        .set(0, 0, 0)
        .addScaledVector(axes.forward, Math.cos(orbitPitch) * Math.cos(orbitYaw))
        .addScaledVector(axes.right, Math.cos(orbitPitch) * Math.sin(orbitYaw))
        .addScaledVector(frame.localUp, Math.sin(orbitPitch))
        .normalize()
        .multiplyScalar(orbitDistance);

      out.position.copy(anchor).add(offset);
      out.up.copy(frame.localUp);
      return;
    }
  }
}
