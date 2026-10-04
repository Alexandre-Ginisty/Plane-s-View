/**
 * What gives light, and how much, by what it is mapped as.
 *
 * Three channels in the night map, read back by the terrain shader:
 *  - red   warm street light — sodium orange, the colour of a city from above;
 *  - green warm-white glow — shop windows, offices, floodlit yards, buildings;
 *  - blue  cool white — LED, runways, taxiways, motorway lighting.
 *
 * Intensities are 0..1 before the level's own scaling, and are the same for the
 * same road at every level: a motorway is brighter than a back street from
 * cruise and from the kerb.
 */

export interface LineStyle {
  /** Width of the carriageway and its verges as lit, metres. */
  widthM: number;
  warm: number;
  cool: number;
}

/** Roads by OpenMapTiles `class`. Unlisted classes (paths, tracks, rail) are not lit. */
const ROADS: Record<string, LineStyle> = {
  motorway: { widthM: 22, warm: 0.7, cool: 0.55 },
  trunk: { widthM: 18, warm: 0.75, cool: 0.4 },
  primary: { widthM: 14, warm: 0.9, cool: 0.15 },
  secondary: { widthM: 11, warm: 0.75, cool: 0 },
  tertiary: { widthM: 9, warm: 0.6, cool: 0 },
  minor: { widthM: 7, warm: 0.42, cool: 0 },
  residential: { widthM: 7, warm: 0.42, cool: 0 },
  service: { widthM: 4, warm: 0.2, cool: 0 },
  busway: { widthM: 7, warm: 0.4, cool: 0 },
  pier: { widthM: 4, warm: 0.2, cool: 0 },
};

/** Under construction or not yet open: dark. */
const UNBUILT = /_construction$|_proposed$/;

export function roadStyle(kind: string): LineStyle | null {
  if (UNBUILT.test(kind)) return null;
  return ROADS[kind] ?? null;
}

/** Aerodrome lighting: the brightest, coolest thing on the map. */
export function aerowayStyle(kind: string): LineStyle | null {
  if (kind === 'runway') return { widthM: 45, warm: 0.15, cool: 1 };
  if (kind === 'taxiway') return { widthM: 16, warm: 0, cool: 0.55 };
  return null;
}

export interface AreaStyle {
  warm: number;
  glow: number;
  cool: number;
}

/** Built-up and lit land, by land-use class. Parks, farmland, forest and the rest stay dark. */
export function landuseStyle(kind: string): AreaStyle | null {
  switch (kind) {
    case 'residential':
    case 'suburb':
    case 'quarter':
    case 'neighbourhood':
      return { warm: 0.035, glow: 0, cool: 0 };
    case 'commercial':
    case 'retail':
      return { warm: 0.05, glow: 0.2, cool: 0 };
    case 'industrial':
    case 'railway':
      return { warm: 0.03, glow: 0.12, cool: 0.12 };
    case 'stadium':
    case 'pitch':
    case 'playground':
      return { warm: 0, glow: 0.2, cool: 0.22 };
    case 'hospital':
    case 'university':
    case 'school':
    case 'college':
      return { warm: 0.05, glow: 0.18, cool: 0 };
    default:
      return null;
  }
}

/** The aprons and terminals of an airfield are floodlit. */
export function aerowayAreaStyle(kind: string): AreaStyle | null {
  if (kind === 'apron') return { warm: 0.05, glow: 0.45, cool: 0.4 };
  if (kind === 'helipad' || kind === 'heliport') return { warm: 0, glow: 0.1, cool: 0.4 };
  return null;
}

/**
 * How bright a line that is thinner than a texel is drawn, relative to one
 * that fills it. Energy is conserved only up to a point: a street is not
 * visible at all from cruise if its light is spread over a whole texel, yet a
 * city from FL350 is plainly a web of streets, because a lamp is far brighter
 * than the ground it stands on. The exponent is the compromise, set by eye.
 */
export function thinLineGain(widthM: number, texelM: number): number {
  return Math.min(1, (widthM / (texelM * 1.3)) ** 0.45);
}

/** Positions at a fixed spacing along a polyline, starting half a spacing in. */
export function pointsAlong(path: ArrayLike<number>, spacing: number): [number, number][] {
  const out: [number, number][] = [];
  let carry = spacing / 2;
  for (let i = 2; i + 1 < path.length; i += 2) {
    const x0 = path[i - 2]!;
    const y0 = path[i - 1]!;
    const dx = path[i]! - x0;
    const dy = path[i + 1]! - y0;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    let d = carry;
    while (d <= len) {
      out.push([x0 + (dx * d) / len, y0 + (dy * d) / len]);
      d += spacing;
    }
    carry = d - len;
  }
  return out;
}
