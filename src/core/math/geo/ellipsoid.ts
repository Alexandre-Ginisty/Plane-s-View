/**
 * WGS84 geodetic <-> ECEF, and local frames.
 *
 * ECEF (Earth-Centred, Earth-Fixed) is the frame the whole renderer works in:
 * metres, origin at the centre of the Earth, +Z through the north pole. Every
 * position on screen is derived from `geodeticToEcef`.
 *
 * The inverse is Bowring's method rather than an iterative solve — closed
 * form, accurate to well under a millimetre for any altitude this app will
 * ever see, and it cannot fail to converge.
 *
 * The `*Into` variants exist for the hot paths: they write into a caller-owned
 * array instead of allocating, which matters when they are called once per
 * aircraft per frame.
 */

import {
  DEG2RAD,
  RAD2DEG,
  WGS84_A,
  WGS84_B,
  WGS84_E2,
  WGS84_EP2,
  type Vec3,
} from './units';

// ---------------------------------------------------------------------------
// Geodetic <-> ECEF
// ---------------------------------------------------------------------------

/** Radius of curvature in the prime vertical at latitude `latRad`. */
function primeVerticalRadius(sinLat: number): number {
  return WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
}

function geodeticToEcefInto(
  latDeg: number,
  lonDeg: number,
  height: number,
  out: Vec3,
): Vec3 {
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  const n = primeVerticalRadius(sinLat);
  const xy = (n + height) * cosLat;

  out[0] = xy * cosLon;
  out[1] = xy * sinLon;
  out[2] = (n * (1 - WGS84_E2) + height) * sinLat;
  return out;
}

export function geodeticToEcef(latDeg: number, lonDeg: number, height = 0): Vec3 {
  return geodeticToEcefInto(latDeg, lonDeg, height, [0, 0, 0]);
}

/**
 * ECEF -> geodetic via Bowring's closed-form approximation, which is accurate
 * to well under a millimetre for any altitude we care about and needs no
 * iteration.
 */
export function ecefToGeodetic(x: number, y: number, z: number): {
  lat: number;
  lon: number;
  height: number;
} {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);

  if (p < 1e-9) {
    // On the polar axis: latitude is ±90° and longitude is arbitrary.
    const sign = z >= 0 ? 1 : -1;
    return { lat: sign * 90, lon: 0, height: Math.abs(z) - WGS84_B };
  }

  const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);

  const lat = Math.atan2(
    z + WGS84_EP2 * WGS84_B * sinT * sinT * sinT,
    p - WGS84_E2 * WGS84_A * cosT * cosT * cosT,
  );

  const sinLat = Math.sin(lat);
  const n = primeVerticalRadius(sinLat);
  const cosLat = Math.cos(lat);

  // Near the poles `p / cosLat` loses precision, so switch formulation.
  const height =
    Math.abs(cosLat) > 0.1
      ? p / cosLat - n
      : z / sinLat - n * (1 - WGS84_E2);

  return { lat: lat * RAD2DEG, lon: lon * RAD2DEG, height };
}

/**
 * Orthonormal ENU basis at a geodetic anchor, expressed in ECEF.
 * Returns column vectors east, north, up.
 */
export function enuBasis(latDeg: number, lonDeg: number): {
  east: Vec3;
  north: Vec3;
  up: Vec3;
} {
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  return {
    east: [-sinLon, cosLon, 0],
    north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    up: [cosLat * cosLon, cosLat * sinLon, sinLat],
  };
}

/** Metres per degree of latitude / longitude at a given latitude. */
export function metresPerDegree(latDeg: number): { lat: number; lon: number } {
  const lat = latDeg * DEG2RAD;
  const sinLat = Math.sin(lat);
  const n = primeVerticalRadius(sinLat);
  // Meridional radius of curvature.
  const m = (WGS84_A * (1 - WGS84_E2)) / Math.pow(1 - WGS84_E2 * sinLat * sinLat, 1.5);
  return { lat: m * DEG2RAD, lon: n * Math.cos(lat) * DEG2RAD };
}
