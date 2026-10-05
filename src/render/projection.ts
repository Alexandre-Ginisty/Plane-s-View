/**
 * Where a world point lands on screen, or nothing when it is behind the eye.
 *
 * `Vector3.project` alone cannot say. Its depth is only a usable "is it in
 * front" test when the depth buffer is the classic one, where a point behind
 * the camera comes out above 1. With the reversed depth buffer the engine uses
 * whenever the browser allows it, that same point comes out *negative* and
 * passes any `z > 1` check — and its x and y are flipped, because the
 * perspective divide is by a negative number. The result is a marker drawn
 * mirrored through the centre of the screen: an aircraft behind and above you
 * labelled below and on the other side.
 *
 * The sign of the view-space z does not depend on the depth convention, so it
 * is read there, before the projection matrix is applied.
 */

import type { Camera, Vector3 } from 'three';

/**
 * Projects `point` (render space) in place to normalised device coordinates.
 * Returns false, leaving `point` meaningless, when it is behind the camera.
 */
export function projectAhead(point: Vector3, camera: Camera): boolean {
  point.applyMatrix4(camera.matrixWorldInverse);
  if (point.z >= 0) return false;
  point.applyMatrix4(camera.projectionMatrix);
  return true;
}
