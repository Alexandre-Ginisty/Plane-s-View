/**
 * Sun, sky and haze.
 *
 * One function, because the three have to move together: the terrain fades
 * towards exactly the colour the sky shows at the horizon, and if they are
 * updated from different places they drift apart and the edge of the loaded
 * terrain becomes a visible line — which is the one thing the whole streaming
 * design exists to hide.
 */

import type { Vector3 } from 'three';

import { sunDirectionEcef } from '@/core/sun';
import type { Engine } from '@/render/engine';
import type { Globe } from '@/render/globe';

/**
 * @param sunVec Scratch vector the caller owns, left holding the sun direction
 * in ECEF. Reused rather than returned because the aircraft model needs the
 * same vector each frame and allocating one per frame is exactly the kind of
 * churn that shows up as a periodic GC pause in a first-person view.
 */
export function updateSunlight(engine: Engine, globe: Globe, sunVec: Vector3): void {
  const dir = sunDirectionEcef();
  sunVec.set(dir[0], dir[1], dir[2]);
  // The sky, the haze and the light on the models all come from the one
  // atmosphere, which works out the sun's elevation from the camera itself.
  engine.setSky(sunVec);
  globe.setSun(sunVec);
}
