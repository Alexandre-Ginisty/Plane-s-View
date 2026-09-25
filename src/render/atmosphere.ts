/**
 * Aerial perspective.
 *
 * ## The problem it actually solves
 *
 * Esri World Imagery is a stack of datasets, and which one you get depends on
 * the zoom: deep zooms are recent aerial survey, shallow zooms a satellite
 * composite, captured by different sensors in different seasons. The composite
 * runs warm and brown where the aerial runs cool and blue-green.
 *
 * That is invisible on a flat map, where you see one level at a time. In a
 * cockpit you see *every* level at once, laid out by distance, so the dataset
 * change draws a ring on the ground around you — and it moves with you, which
 * makes it far more obvious than a static seam.
 *
 * It cannot be fixed at the source. What removes it is what removes it in
 * reality: **air**. Fifty kilometres of atmosphere washes out any colour
 * difference before the eye can compare the two.
 *
 * ## Why the old fog did not do this
 *
 * At 1.1e-6 per metre it reached **3% opacity at thirty kilometres and 20% at
 * the horizon from FL350**. Thirty kilometres of real air is not 3% — the far
 * hills are plainly hazed. Twenty times too thin to be atmosphere, so it read
 * as a faint tint and left the ring fully legible underneath.
 *
 * ## The model
 *
 * Constant density is the obvious fix and is wrong in the other direction. Air
 * thins exponentially with height, so a constant that hazes the horizon
 * correctly also puts a grey veil on the ground eleven kilometres directly
 * below the aircraft, where the real path is mostly near-vacuum.
 *
 * So density follows the standard exponential atmosphere, rho(h) =
 * rho0 * exp(-h / H), and the optical depth along a ray has a closed form. For
 * a ray of length L between altitudes h0 and h1:
 *
 *     tau = rho0 * H * (L / (h1 - h0)) * (exp(-h0/H) - exp(-h1/H))
 *
 * which is just the integral of the density over the path, and degenerates to
 * `rho0 * exp(-h/H) * L` for a horizontal ray. Opacity is then the usual
 * `1 - exp(-tau)`.
 *
 * `terrainMaterial`'s fragment shader is a direct transcription of
 * `opticalDepth` below. The two must stay in step — the tests here are what
 * pins the behaviour, and there is no way to run a fragment shader in them.
 */

/** Scale height of the atmosphere, metres. The standard 8.5 km. */
export const SCALE_HEIGHT_M = 8500;

/**
 * Mean Earth radius, metres.
 *
 * A sphere, not the ellipsoid, and deliberately: this is only used to turn a
 * position into an altitude for the density curve, where the 21 km difference
 * between the polar and equatorial radii changes the haze by a fraction of a
 * percent and costs a square root either way.
 */
export const EARTH_RADIUS_M = 6_371_000;

/**
 * Sea-level extinction, per metre, in clear daylight and at night.
 *
 * Meteorological visual range V relates to extinction by the Koschmieder
 * relation, tau = 3.912 / V. 1.4e-5 is a visual range of about 280 km — an
 * exceptionally clear day, past what the real atmosphere usually manages, and
 * chosen for that reason.
 *
 * A textbook clear day is nearer 2.0e-5, and it was tried first. From FL460 it
 * turns the forward view white: the cockpit looks *along* the ground, so most
 * of the screen is 100-300 km away and an honest atmosphere is 86% opaque
 * there. Correct, and not what anyone opened a satellite globe to see. 1.4e-5
 * keeps the horizon dissolved (95% at 370 km) and the mid-field legible.
 *
 * The night figure is thicker because haze reads as heavier in low light and,
 * more practically, because an unlit LOD boundary needs more covering.
 */
export const CLEAR_DAY_DENSITY = 1.4e-5;
export const NIGHT_DENSITY = 2.6e-5;

/** Thicker haze at night and at low sun; thinner in clear daylight. */
export function fogDensityFor(sunElevationDeg: number): number {
  const day = Math.min(Math.max((sunElevationDeg + 6) / 12, 0), 1);
  return NIGHT_DENSITY - (NIGHT_DENSITY - CLEAR_DAY_DENSITY) * day;
}

/**
 * Optical depth along a ray through an exponential atmosphere.
 *
 * @param density Sea-level extinction per metre.
 * @param lengthM Length of the ray.
 * @param fromAltM Altitude of the eye, metres above sea level.
 * @param toAltM Altitude of the far end.
 */
export function opticalDepth(
  density: number,
  lengthM: number,
  fromAltM: number,
  toAltM: number,
): number {
  // Below sea level is ocean floor or a heightmap artefact, not denser air.
  const h0 = Math.max(fromAltM, 0);
  const h1 = Math.max(toAltM, 0);
  const dh = h1 - h0;

  // A horizontal ray: the closed form divides by `dh`, so it needs the limit.
  // One metre, not zero — a near-horizontal ray over a hundred kilometres
  // would otherwise swing between the two branches and flicker.
  if (Math.abs(dh) < 1) {
    return density * Math.exp(-h0 / SCALE_HEIGHT_M) * lengthM;
  }

  return Math.abs(
    density *
      SCALE_HEIGHT_M *
      (lengthM / dh) *
      (Math.exp(-h0 / SCALE_HEIGHT_M) - Math.exp(-h1 / SCALE_HEIGHT_M)),
  );
}

/** How much of the far colour has been replaced by haze, 0-1. */
export function aerialOpacity(
  density: number,
  lengthM: number,
  fromAltM: number,
  toAltM: number,
): number {
  return 1 - Math.exp(-opticalDepth(density, lengthM, fromAltM, toAltM));
}
