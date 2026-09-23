/**
 * Procedural aircraft geometry.
 *
 * Built in code rather than loaded from a glTF asset, for the same reason the
 * rest of the project has no API keys: a downloadable aircraft model that is
 * free, redistributable, and covers a useful range of types does not really
 * exist. Generating one keeps the app self-contained and lets the silhouette
 * follow the *actual* airframe — a 737 and an A380 differ in wing sweep,
 * engine count and proportions, and all of that is derivable from the ICAO
 * type code the feed already gives us.
 *
 * `shapes.ts` decides what an airframe is; `fixedWing.ts` and `rotorcraft.ts`
 * turn that into triangles; `meshBuilder.ts` is the shared primitive layer.
 */

import type { BufferGeometry } from 'three';

import { addVerticalFin, createAircraftGeometry } from './fixedWing';
import { createRotorcraftGeometry } from './rotorcraft';
import { shapeFor, type AirframeShape } from './shapes';

export { isRotorcraftType, isSurfaceVehicle, shapeFor } from './shapes';
export type { AirframeKind, AirframeShape, EngineMount } from './shapes';

/** Complete model for a type code, ready to scale by `shape.length`. */
export function buildAircraftModel(
  typeCode: string | null,
  category: string | null,
  detail: 'high' | 'low' = 'high',
): { geometry: BufferGeometry; shape: AirframeShape } {
  const shape = shapeFor(typeCode, category);
  if (shape.kind === 'rotorcraft') {
    return { geometry: createRotorcraftGeometry(shape, detail), shape };
  }
  const geometry = addVerticalFin(createAircraftGeometry(shape, detail), shape);
  return { geometry, shape };
}
