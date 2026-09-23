/**
 * Great-circle helpers.
 *
 * The ADS-B side of the app works in latitude and longitude, not ECEF, and at
 * the ranges involved (a query radius, a trail, a bearing to a destination) a
 * spherical Earth is accurate to a few parts in a thousand — far inside the
 * error of the positions themselves. Doing these on the ellipsoid would be
 * more precise in a way nothing here could use.
 */

import {
  DEG2RAD,
  EARTH_MEAN_RADIUS,
  RAD2DEG,
  clamp,
  wrapHeading,
  wrapLongitude,
} from './units';

// ---------------------------------------------------------------------------
// Great-circle helpers (the ADS-B side works in lat/lon, not ECEF)
// ---------------------------------------------------------------------------

/** Great-circle distance in metres. */
export function haversineMetres(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MEAN_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial true bearing, degrees clockwise from north. */
export function initialBearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const p1 = lat1 * DEG2RAD;
  const p2 = lat2 * DEG2RAD;
  const dl = (lon2 - lon1) * DEG2RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return wrapHeading(Math.atan2(y, x) * RAD2DEG);
}

/** Point reached by travelling `distance` metres along `bearingDeg`. */
export function destinationPoint(
  latDeg: number,
  lonDeg: number,
  bearingDeg: number,
  distance: number,
): { lat: number; lon: number } {
  const d = distance / EARTH_MEAN_RADIUS;
  const b = bearingDeg * DEG2RAD;
  const p1 = latDeg * DEG2RAD;
  const l1 = lonDeg * DEG2RAD;

  const sinP1 = Math.sin(p1);
  const cosP1 = Math.cos(p1);
  const sinD = Math.sin(d);
  const cosD = Math.cos(d);

  const sinP2 = sinP1 * cosD + cosP1 * sinD * Math.cos(b);
  const p2 = Math.asin(clamp(sinP2, -1, 1));
  const l2 = l1 + Math.atan2(Math.sin(b) * sinD * cosP1, cosD - sinP1 * sinP2);

  return { lat: p2 * RAD2DEG, lon: wrapLongitude(l2 * RAD2DEG) };
}
