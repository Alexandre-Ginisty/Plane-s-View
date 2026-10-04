/**
 * The ground detail map: what the map knows of the ground, drawn sharp over
 * imagery that is not.
 *
 * Where no national agency publishes open aerial photographs (see
 * `tiles/regional.ts`) the ground is the 10 m satellite mosaic, which from a
 * few hundred metres up is a soft green-brown wash with no roads in it. The
 * map has them: every road, rail line and runway as a line of its real width,
 * every building as its footprint. Drawn at a metre or two a pixel over the
 * photograph, they give back the sharp edges and the structure a low pass over
 * a town should have, and stand aside (the shader fades them out) wherever the
 * photograph is already sharp.
 *
 * Two squares about the aircraft, like the night map's levels, drawn by the
 * same worker from the same vector tiles. Colours are straight sRGB with
 * alpha: they are painted over the photograph, not added to it.
 */

import type { NightLevel } from './levels';

export interface GroundLevel extends NightLevel {
  /** Draw building footprints. */
  footprints: boolean;
}

export const GROUND_LEVELS: readonly GroundLevel[] = [
  { spanKm: 16, px: 2048, zoom: 12, lamps: false, buildings: false, landuse: false, footprints: false, maxAglM: 6_000 },
  { spanKm: 4, px: 2048, zoom: 14, lamps: false, buildings: false, landuse: false, footprints: true, maxAglM: 2_000 },
];

export interface GroundLine {
  widthM: number;
  /** Surface colour, 0..1 sRGB. */
  rgb: readonly [number, number, number];
  alpha: number;
  /** Draw order, low first: a motorway lies over the lane it crosses. */
  rank: number;
}

// The satellite mosaic's land is dark and muted; a road reads against it as the pale grey it is
// from the air, darkest where it is widest and newest.
const ASPHALT_MAJOR = [0.4, 0.4, 0.42] as const;
const ASPHALT = [0.55, 0.55, 0.55] as const;
const ASPHALT_MINOR = [0.64, 0.63, 0.6] as const;
const EARTH = [0.68, 0.58, 0.44] as const;

const ROADS: Record<string, GroundLine> = {
  motorway: { widthM: 20, rgb: ASPHALT_MAJOR, alpha: 0.92, rank: 9 },
  trunk: { widthM: 16, rgb: ASPHALT_MAJOR, alpha: 0.9, rank: 8 },
  primary: { widthM: 12, rgb: ASPHALT, alpha: 0.88, rank: 7 },
  secondary: { widthM: 10, rgb: ASPHALT, alpha: 0.84, rank: 6 },
  tertiary: { widthM: 8, rgb: ASPHALT, alpha: 0.8, rank: 5 },
  minor: { widthM: 6, rgb: ASPHALT_MINOR, alpha: 0.74, rank: 4 },
  residential: { widthM: 6, rgb: ASPHALT_MINOR, alpha: 0.74, rank: 4 },
  busway: { widthM: 6, rgb: ASPHALT_MINOR, alpha: 0.7, rank: 4 },
  service: { widthM: 3.5, rgb: ASPHALT_MINOR, alpha: 0.7, rank: 3 },
  track: { widthM: 3, rgb: EARTH, alpha: 0.6, rank: 2 },
  rail: { widthM: 3.2, rgb: [0.5, 0.47, 0.44], alpha: 0.7, rank: 1 },
};

const UNBUILT = /_construction$|_proposed$/;

export function groundRoadStyle(kind: string): GroundLine | null {
  if (UNBUILT.test(kind)) return null;
  return ROADS[kind] ?? null;
}

/** Runways and taxiways: wider and darker than any road, and marked. */
export function groundAerowayStyle(kind: string): GroundLine | null {
  if (kind === 'runway') return { widthM: 45, rgb: [0.27, 0.27, 0.29], alpha: 0.9, rank: 10 };
  if (kind === 'taxiway') return { widthM: 20, rgb: [0.33, 0.33, 0.35], alpha: 0.92, rank: 9 };
  return null;
}

/** Aprons and the like: a flat grey, lighter than a runway. */
export function groundAerowayAreaRgb(kind: string): readonly [number, number, number] | null {
  if (kind === 'apron') return [0.48, 0.48, 0.49];
  if (kind === 'helipad' || kind === 'heliport') return [0.45, 0.45, 0.47];
  return null;
}

const ROOFS: readonly (readonly [number, number, number])[] = [
  [0.63, 0.6, 0.56], // pale render
  [0.52, 0.36, 0.29], // clay tile
  [0.46, 0.46, 0.49], // slate
  [0.7, 0.68, 0.64], // concrete
  [0.4, 0.37, 0.35], // dark tile
  [0.58, 0.5, 0.42], // sand
];

/** A building's roof, always the same for the same building. `seed` is any number the footprint fixes. */
export function roofColour(seed: number): readonly [number, number, number] {
  const h = Math.imul(Math.floor(seed) | 0, 2654435761) >>> 0;
  return ROOFS[(h >>> 8) % ROOFS.length]!;
}
