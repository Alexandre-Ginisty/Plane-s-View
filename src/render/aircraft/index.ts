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
 * `shapes.ts` decides what an airframe is and `details.ts` derives what the
 * table leaves implicit; `fixedWing.ts` and `rotorcraft.ts` turn that into
 * triangles; `meshBuilder.ts` is the shared primitive layer; `gear.ts` and
 * `propeller.ts` build the parts that move or retract.
 *
 * ## Why a model is four things
 *
 * A single geometry cannot express an aeroplane. The hull is light and matte,
 * the glass is dark and reflective, the gear is only there some of the time,
 * and the propellers have to turn — four different materials or behaviours, so
 * four buffers. Merging them was what made every aircraft a uniform grey
 * silhouette with no windows, no undercarriage and, on a turboprop, no
 * propellers at all.
 */

import type { BufferGeometry } from 'three';

import { createGearGeometry } from './gear';
import { createAircraftGeometry, type Spinner } from './fixedWing';
import { createRotorcraftGeometry } from './rotorcraft';
import { shapeFor, type AirframeShape } from './shapes';

export { isSurfaceVehicle, shapeFor } from './shapes';
export type { AirframeShape } from './shapes';
export { propBladesFor } from './details';
export { bladeOpacity, propellerRpm, visibleSpinRate } from './propeller';
export type { Spinner } from './propeller';
export { rotorRpm } from './rotorcraft';

export interface AircraftModel {
  /** Airframe skin: fuselage, wings, tail, nacelles. Light and matte. */
  hull: BufferGeometry;
  /** Glass and shadowed detail: windows, fan faces, exhausts. Dark. */
  trim: BufferGeometry | null;
  /** Extended undercarriage, drawn only near the ground. */
  gear: BufferGeometry | null;
  /** Propellers and rotors, each turned about its own axis. */
  spinners: Spinner[];
  shape: AirframeShape;
}

/** Complete model for a type code, ready to scale by `shape.length`. */
export function buildAircraftModel(
  typeCode: string | null,
  category: string | null,
  detail: 'high' | 'low' = 'high',
): AircraftModel {
  const shape = shapeFor(typeCode, category);

  if (shape.kind === 'rotorcraft') {
    const { hull, trim, spinners } = createRotorcraftGeometry(shape, detail);
    return { hull, trim, gear: null, spinners, shape };
  }

  const { hull, trim, spinners } = createAircraftGeometry(shape, detail);
  return { hull, trim, gear: createGearGeometry(shape, detail), spinners, shape };
}

/** Release every buffer a model holds. */
export function disposeAircraftModel(model: AircraftModel): void {
  model.hull.dispose();
  model.trim?.dispose();
  model.gear?.dispose();
  for (const spinner of model.spinners) spinner.geometry.dispose();
}
