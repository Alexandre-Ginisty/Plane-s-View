/**
 * The night map: four overlapping squares of light, each finer and smaller,
 * all centred on the aircraft (a clipmap).
 *
 * What is lit at night is the *plan* of a place — its streets, its motorways,
 * its runways, where the buildings stand — so the lights are drawn from the
 * same OpenStreetMap vector tiles the ground detail comes from, not guessed from
 * a satellite picture of the day. Each level reads the vector zoom at which
 * the features it can show are present: z10 has the motorways, primary and
 * secondary roads and the industrial and commercial land; z12 has every road;
 * z14 has every building.
 */

export interface NightLevel {
  /** Side of the square, kilometres. */
  spanKm: number;
  /** Pixels along a side. */
  px: number;
  /** Vector tile zoom the level is drawn from. */
  zoom: number;
  /** Draw each street light as a point, spaced along the road, instead of a continuous line. */
  lamps: boolean;
  /** Draw building footprints (only present at z14). */
  buildings: boolean;
  /**
   * Draw land-use fills (built-up areas, industrial estates). Off at every level
   * for now: a flat fill reads as a painted rectangle, not as light, and the
   * streets and buildings already say where it is built up.
   */
  landuse: boolean;
  /** Highest aircraft height above ground at which the level is worth having, metres. */
  maxAglM: number;
}

export const NIGHT_LEVELS: readonly NightLevel[] = [
  // The motorways and trunk roads of a region, for the view from cruise.
  { spanKm: 320, px: 1024, zoom: 8, lamps: false, buildings: false, landuse: false, maxAglM: Infinity },
  { spanKm: 80, px: 2048, zoom: 10, lamps: false, buildings: false, landuse: false, maxAglM: 16_000 },
  { spanKm: 20, px: 1024, zoom: 12, lamps: false, buildings: false, landuse: false, maxAglM: 7_000 },
  { spanKm: 3, px: 1024, zoom: 14, lamps: true, buildings: true, landuse: false, maxAglM: 2_500 },
];

const KM_PER_DEG_LAT = 111.32;

/** The square's extent about a centre, degrees. Same ground distance both ways, so texels are square. */
export function levelBounds(
  level: NightLevel,
  lat: number,
  lon: number,
): { south: number; north: number; west: number; east: number } {
  const latHalf = level.spanKm / 2 / KM_PER_DEG_LAT;
  const lonHalf = Math.min(30, latHalf / Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const south = Math.max(-85, lat - latHalf);
  const north = Math.min(85, lat + latHalf);
  // Kept clear of the antimeridian: the shader does not wrap a level.
  const west = Math.max(-180, Math.min(180 - 2 * lonHalf, lon - lonHalf));
  return { south, north, west, east: west + 2 * lonHalf };
}

/** The vector tiles that cover a square of the given extent at a zoom. */
export function coveringTiles(
  bounds: { south: number; north: number; west: number; east: number },
  zoom: number,
): { x: number; y: number }[] {
  const n = 2 ** zoom;
  const x0 = Math.floor(((bounds.west + 180) / 360) * n);
  const x1 = Math.floor(((bounds.east + 180) / 360) * n);
  const yOf = (lat: number) =>
    Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  const y0 = yOf(bounds.north);
  const y1 = yOf(bounds.south);
  const tiles: { x: number; y: number }[] = [];
  for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(n - 1, x1); x++) tiles.push({ x, y });
  }
  return tiles;
}
