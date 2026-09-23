/**
 * Solar position.
 *
 * Low-precision NOAA solar equations — accurate to roughly 0.01 degrees, which
 * is far beyond what lighting needs. The point is that the terminator falls
 * where it actually falls: fly east at dawn and the sunrise arrives when it
 * should, which is a detail that quietly makes the whole scene believable.
 */

import { DEG2RAD, RAD2DEG, geodeticToEcef, type Vec3 } from './math/geo';

/** Julian centuries since J2000.0. */
function julianCentury(date: Date): number {
  const julianDay = date.getTime() / 86_400_000 + 2440587.5;
  return (julianDay - 2451545) / 36525;
}

/** Subsolar point: the geodetic position where the sun is directly overhead. */
export function subsolarPoint(date: Date = new Date()): { lat: number; lon: number } {
  const t = julianCentury(date);

  const meanLongitude = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const m = meanAnomaly * DEG2RAD;
  const equationOfCentre =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;

  const trueLongitude = meanLongitude + equationOfCentre;
  const apparentLongitude =
    trueLongitude - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * DEG2RAD);

  const meanObliquity =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity =
    meanObliquity + 0.00256 * Math.cos((125.04 - 1934.136 * t) * DEG2RAD);

  const lambda = apparentLongitude * DEG2RAD;
  const epsilon = obliquity * DEG2RAD;

  const declination = Math.asin(Math.sin(epsilon) * Math.sin(lambda)) * RAD2DEG;

  // Equation of time, minutes.
  const y = Math.tan(epsilon / 2) ** 2;
  const l0 = meanLongitude * DEG2RAD;
  const equationOfTime =
    4 *
    RAD2DEG *
    (y * Math.sin(2 * l0) -
      2 * eccentricity * Math.sin(m) +
      4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * m));

  const utcMinutes =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;

  // Solar noon happens where the apparent solar time is 12:00.
  let lon = -((utcMinutes + equationOfTime) / 4 - 180);
  lon = ((lon + 180) % 360 + 360) % 360 - 180;

  return { lat: declination, lon };
}

/**
 * Unit vector from the Earth's centre towards the sun, in ECEF.
 *
 * The sun is 150 million km away, so this direction is effectively the same
 * everywhere on the planet — treating it as parallel light is exact enough.
 */
export function sunDirectionEcef(date: Date = new Date()): Vec3 {
  const { lat, lon } = subsolarPoint(date);
  const p = geodeticToEcef(lat, lon, 0);
  const len = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] / len, p[1] / len, p[2] / len];
}

/**
 * Sun elevation above the local horizon, degrees. Negative is night.
 * Drives the sky palette and the cockpit HUD's day/night styling.
 */
export function sunElevation(latDeg: number, lonDeg: number, date: Date = new Date()): number {
  const sun = sunDirectionEcef(date);
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  const cosLat = Math.cos(lat);

  // Local "up" is the ellipsoid surface normal.
  const up: Vec3 = [cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat)];
  const dot = sun[0] * up[0] + sun[1] * up[1] + sun[2] * up[2];
  return Math.asin(Math.max(-1, Math.min(1, dot))) * RAD2DEG;
}
