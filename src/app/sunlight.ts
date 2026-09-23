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

import { clamp, enuBasis } from '@/core/math/geo';
import { sunDirectionEcef, sunElevation } from '@/core/sun';
import type { Engine } from '@/render/engine';
import type { Globe } from '@/render/globe';

/**
 * @param sunVec Scratch vector the caller owns, left holding the sun direction
 * in ECEF. Reused rather than returned because the aircraft model needs the
 * same vector each frame and allocating one per frame is exactly the kind of
 * churn that shows up as a periodic GC pause in a first-person view.
 */
export function updateSunlight(
  engine: Engine,
  globe: Globe,
  sunVec: Vector3,
  upVec: Vector3,
  lat: number,
  lon: number,
): void {
  const dir = sunDirectionEcef();
  sunVec.set(dir[0], dir[1], dir[2]);

  const basis = enuBasis(lat, lon);
  upVec.set(basis.up[0], basis.up[1], basis.up[2]);

  const elevation = sunElevation(lat, lon);
  engine.setSky(sunVec, upVec, elevation);
  globe.setSun(sunVec);

  // Terrain fades into the same colour the sky shows at the horizon, so the
  // edge of loaded terrain has nothing to give it away.
  globe.setAtmosphere(engine.horizonColor, fogDensityFor(elevation));
}

/** Thicker haze low down and at night; thinner in clear daylight. */
export function fogDensityFor(sunElevationDeg: number): number {
  const day = clamp((sunElevationDeg + 6) / 12, 0, 1);
  return 2.2e-6 - 1.1e-6 * day;
}
