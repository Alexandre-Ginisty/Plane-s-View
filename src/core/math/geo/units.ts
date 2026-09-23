/**
 * Constants and scalar helpers.
 *
 * The unit conversions exist so that no factor is ever typed twice. Aviation
 * mixes feet, knots, nautical miles and feet-per-minute with SI in the same
 * data structure, and a `0.3048` written inline in two places is a bug waiting
 * for one of them to be corrected.
 *
 * The angle helpers are the other recurring trap: heading arithmetic that does
 * not wrap produces an aircraft that spins the long way round through 359°,
 * which is both wrong and very visible.
 */

/**
 * WGS84 geodesy + Web Mercator tile math.
 *
 * Coordinate systems used across PlanesView:
 *
 *  - **Geodetic**  `(lat°, lon°, h)` — h is height above the WGS84 ellipsoid in
 *    metres. This is what every data source speaks.
 *  - **ECEF**      Earth-Centred Earth-Fixed metres. +Z through the north pole,
 *    +X through (0°N, 0°E), +Y through (0°N, 90°E). This is the *world* frame.
 *  - **Render**    ECEF minus a floating origin, so the numbers that reach
 *    float32 GPU buffers stay small. See `core/frame.ts`.
 *  - **ENU**       Local tangent frame at a geodetic anchor: East / North / Up.
 *    Used for aircraft attitude and for the Kalman filter's state space.
 *
 * Nothing here allocates on hot paths that matter; the `*Into` variants write
 * into a caller-supplied tuple.
 */

/** Semi-major axis (equatorial radius), metres. */
export const WGS84_A = 6378137.0;
/** Flattening. */
export const WGS84_F = 1 / 298.257223563;
/** Semi-minor axis (polar radius), metres. */
export const WGS84_B = WGS84_A * (1 - WGS84_F);
/** First eccentricity squared. */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
/** Second eccentricity squared, for Bowring's inverse. */
export const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

/** Mean radius, good enough for great-circle work. */
export const EARTH_MEAN_RADIUS = 6371008.8;

/**
 * Latitude beyond which Web Mercator is undefined. Every XYZ tile source in
 * this app (Esri, EOX, OSM, Terrarium) is Mercator, so the tiled globe is
 * clipped here and the caps are filled separately.
 */
export const MERCATOR_MAX_LAT = 85.051128779806604;

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** Unit conversions for the aviation units the ADS-B feeds report in. */
export const FEET_TO_METRES = 0.3048;
export const METRES_TO_FEET = 1 / FEET_TO_METRES;
export const KNOTS_TO_MPS = 0.514444444444;
export const MPS_TO_KNOTS = 1 / KNOTS_TO_MPS;
export const NM_TO_METRES = 1852;
export const METRES_TO_NM = 1 / NM_TO_METRES;
/** Feet per minute -> metres per second. */
export const FPM_TO_MPS = FEET_TO_METRES / 60;

export type Vec3 = [number, number, number];

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap degrees into [-180, 180). */
export function wrapLongitude(lon: number): number {
  let l = (lon + 180) % 360;
  if (l < 0) l += 360;
  return l - 180;
}

/** Wrap degrees into [0, 360). */
export function wrapHeading(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/**
 * Shortest signed angular difference `to - from`, in degrees, within
 * (-180, 180]. Used when interpolating headings so an aircraft crossing north
 * turns 2° rather than 358°.
 */
export function angleDeltaDeg(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}
