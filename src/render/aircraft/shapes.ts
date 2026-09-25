/**
 * Picking a silhouette for an aircraft.
 *
 * The matching half of the aircraft model: given an ICAO type designator and
 * an ADS-B emitter category, which shape. No geometry and no data here — the
 * table lives in `typeTable.ts` — so the rules, which are where the
 * interesting mistakes live, can be read and tested on their own.
 */

import {
  CATEGORY_LENGTH,
  DEFAULT_SHAPE,
  EXACT,
  GLIDER_SHAPE,
  ROTOR_LENGTH,
  ROTOR_SHAPE,
  ROTORCRAFT_PREFIXES,
  ROTORCRAFT_TYPES,
  SHAPES,
  SURFACE_CATEGORIES,
} from './typeTable';

export type { AirframeShape } from './typeTable';
import type { AirframeShape } from './typeTable';

/**
 * True when this emitter category says the thing is not an aircraft.
 *
 * Airport ground vehicles broadcast ADS-B on the same feed as the traffic, so
 * they arrive in every snapshot taken near a field. Drawing them means a
 * baggage tug rendered as an airliner, parked on the runway at the resolution
 * of the terrain underneath it — which is what the spikes around airports
 * were.
 */
export function isSurfaceVehicle(category: string | null | undefined): boolean {
  return category !== null && category !== undefined && SURFACE_CATEGORIES.has(category.toUpperCase());
}

/** True when this type designator names a helicopter. */
export function isRotorcraftType(code: string): boolean {
  if (ROTORCRAFT_TYPES.has(code)) return true;
  return ROTORCRAFT_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/**
 * Pick the silhouette for an aircraft.
 *
 * Order matters and is not the obvious one. The **emitter category wins over
 * the type code** for rotorcraft and gliders, because the category is
 * broadcast by the aircraft itself while the type code is looked up from a
 * community registry that is frequently missing, stale, or wrong about
 * re-registered airframes. For everything else the type code is far more
 * specific than a category that lumps a CRJ and a 737 into `A3`, so it leads.
 *
 * Within the type code, exact matches are consulted before prefixes: a
 * handful of designators are a complete type *and* the prefix of an unrelated
 * family, and `C17` — the Globemaster and the Cessna 172 — is the one that
 * actually shows up in live traffic.
 */
export function shapeFor(typeCode: string | null, category: string | null): AirframeShape {
  const code = (typeCode ?? '').toUpperCase();
  const cat = (category ?? '').toUpperCase();

  // A7 is "rotorcraft" in the ADS-B emitter category table.
  if (cat === 'A7' || isRotorcraftType(code)) {
    return { ...ROTOR_SHAPE, length: ROTOR_LENGTH[code] ?? 13 };
  }

  // B1 is "glider / sailplane".
  if (cat === 'B1' || code.startsWith('GLID')) {
    return { ...GLIDER_SHAPE, length: 7 };
  }

  const exact = EXACT.get(code);
  if (exact) return { ...DEFAULT_SHAPE, ...exact };

  for (const [prefix, overrides] of SHAPES) {
    if (code.startsWith(prefix)) return { ...DEFAULT_SHAPE, ...overrides };
  }

  const length = CATEGORY_LENGTH[cat] ?? DEFAULT_SHAPE.length;
  // Small airframes are straight-winged and proportionally fatter.
  if (length < 15) {
    return {
      ...DEFAULT_SHAPE,
      kind: 'piston',
      length,
      spanRatio: 1.4,
      sweepDeg: 0,
      engines: 0,
      engineMount: 'none',
      radiusRatio: 0.08,
    };
  }
  return { ...DEFAULT_SHAPE, length };
}
