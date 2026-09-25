/**
 * Great-circle helpers.
 *
 * The ADS-B side of the app works in latitude and longitude, not ECEF, and at
 * the ranges involved (a query radius, a trail, a bearing to a destination) a
 * spherical Earth is accurate to a few parts in a thousand — far inside the
 * error of the positions themselves. Doing these on the ellipsoid would be
 * more precise in a way nothing here could use.
 */

import { DEG2RAD, EARTH_MEAN_RADIUS } from './units';

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
