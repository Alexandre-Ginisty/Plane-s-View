/**
 * The sky, as physics.
 *
 * One clear-sky atmosphere, integrated on the CPU, from which everything that
 * has a colour because of air takes it: the sky dome, the haze over distant
 * terrain and aircraft, the sunlight on the models and the terrain. Before
 * this, each of those was a hand-picked colour lerped against the sun
 * elevation, and they drifted apart at exactly the moments that matter —
 * sunset, dusk, cruise altitude — which is where the horizon showed as a line.
 *
 * ## The model
 *
 * A spherical planet under an exponential Rayleigh atmosphere (air molecules:
 * blue, scale height 8 km), an exponential aerosol layer (Mie: grey, forward
 * scattering, scale height 1.2 km) and an ozone term that absorbs orange light
 * on grazing paths — which is why the twilight zenith turns deep blue instead
 * of grey. Single scattering along the view ray, integrated in sixteen
 * energy-conserving steps (Hillaire 2020); the sunlight reaching each step is
 * attenuated through Schüler's analytic approximation of the Chapman grazing
 * function, so no transmittance table is needed. A small isotropic term
 * stands in for multiple scattering.
 *
 * ## Why on the CPU
 *
 * The sky only changes when the sun moves or the camera climbs, so the
 * integral runs a few times a second into a small table (`buildSkyLut`), and
 * the GPU samples the table: the dome costs one texture read per pixel, and
 * the haze on every material reads the *same* table below the horizon. That
 * sharing is the whole point — distant terrain fades to exactly the colour of
 * the sky behind it because both come from one lookup of one integral.
 *
 * It also makes the sky testable. `src/render/sky/model.test.ts` pins the
 * blue zenith, the white-blue horizon, the red sunset and the dark space-blue
 * at altitude on this code; the shader is a texture fetch and cannot drift.
 *
 * Units: metres; radiance relative to a unit solar irradiance at the top of
 * the atmosphere.
 */

/**
 * Mean Earth radius, metres.
 *
 * A sphere, not the ellipsoid, and deliberately: this only turns positions
 * into altitudes for the density curves, where the 21 km between the polar
 * and equatorial radii changes the haze by a fraction of a percent.
 */
export const EARTH_RADIUS_M = 6_371_000;

/** Top of the modelled atmosphere, metres above the surface. */
const ATMOSPHERE_TOP_M = 80_000;
const TOP_R = EARTH_RADIUS_M + ATMOSPHERE_TOP_M;

/** Rayleigh scattering at sea level, per metre, for red, green and blue. */
export const RAYLEIGH_BETA: Rgb = [5.802e-6, 13.558e-6, 33.1e-6];
export const RAYLEIGH_H = 8000;
/** Aerosol scattering at sea level on a clear day, per metre. */
const MIE_BETA = 8e-6;
/** Scattering / extinction: aerosols absorb a tenth of what they intercept. */
const MIE_ALBEDO = 0.9;
export const MIE_H = 1200;
const MIE_G = 0.76;
/**
 * Ozone absorption, expressed per metre of *Rayleigh-weighted* path.
 *
 * Real ozone sits in a layer near 25 km; folding it into the Rayleigh profile
 * with the same column total keeps the one thing it does visibly — stealing
 * orange from sunlight that crossed the whole atmosphere at a grazing angle —
 * without a third density profile. Applied to sunlight only, so it tints the
 * twilight sky and leaves the haze over the ground alone.
 */
const OZONE_BETA: Rgb = [2.4e-6, 7e-6, 0.3e-6];
/**
 * Isotropic stand-in for light scattered more than once.
 *
 * Lit by the *sky*, not by the sun: by the time light has bounced twice it
 * has lost its direction and taken the sky's blue, and that blue fill is what
 * keeps a low-sun horizon pale instead of brown — single scattering alone
 * reddens every long horizontal ray, because only reddened sunlight reaches
 * it. Its colour is a clear sky's irradiance; it fades out as the point
 * passes into the Earth's shadow.
 */
const MULTI_SCATTER = 0.05;
const MULTI_SCATTER_COLOR: Rgb = [0.52, 0.72, 1];
/**
 * A clear moonless night is not black: airglow, starlight, distant towns.
 * A display value, added after exposure — in radiance it would be multiplied
 * by the dusk exposure boost and come out as a pastel blue night.
 */
const NIGHT_SKY: Rgb = [0.0035, 0.0075, 0.021];

const VIEW_STEPS = 16;

export type Rgb = [number, number, number];

export interface SkyConditions {
  /** Camera height above the sphere, metres. */
  altitudeM: number;
  /** Sun elevation above the camera's local horizontal, degrees. */
  sunElevationDeg: number;
  /** Aerosol multiplier: 1 on a clear day, more in haze. */
  haze: number;
}

/** Radiance scattered towards the eye and the fraction of what lies behind that survives. */
export interface RaySample {
  radiance: Rgb;
  transmittance: Rgb;
}

// ─── Phase functions ────────────────────────────────────────────────────────

function phaseRayleigh(mu: number): number {
  return (3 / (16 * Math.PI)) * (1 + mu * mu);
}

/** Cornette-Shanks: Henyey-Greenstein with the Rayleigh-like (1 + mu^2) lobe. */
function phaseMie(mu: number, g = MIE_G): number {
  const g2 = g * g;
  const denom = Math.pow(Math.max(1e-6, 1 + g2 - 2 * g * mu), 1.5);
  return ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + mu * mu))) / ((2 + g2) * denom);
}

// ─── Geometry ───────────────────────────────────────────────────────────────

/**
 * How far the true horizon sits below the local horizontal, radians.
 *
 * From the ground it is nothing; from FL350 it is 3.3 degrees, which is the
 * band a flat-horizon sky gets wrong: sky colour where the eye expects haze.
 */
export function horizonDip(altitudeM: number): number {
  const h = Math.max(0, altitudeM);
  return Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + h));
}

/**
 * Scaled complementary error function, exp(z^2) erfc(z), for z >= 0.
 *
 * Numerical Recipes' Chebyshev fit, which is naturally written in this scaled
 * form (relative error below 1.2e-7), so a large z costs no overflow.
 */
function erfcx(z: number): number {
  const t = 1 / (1 + 0.5 * z);
  return (
    t *
    Math.exp(
      -1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 +
        t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    )
  );
}

/** Chapman function for a ray that climbs (cosChi >= 0), large-x asymptotic form. */
function chapmanUpper(x: number, cosChi: number): number {
  return Math.sqrt((Math.PI * x) / 2) * erfcx(Math.sqrt(x / 2) * cosChi);
}

/**
 * Column of an exponential atmosphere from radius `r` along a straight ray
 * whose zenith angle has cosine `cosChi`, in metres of sea-level-equivalent
 * air (multiply by a sea-level coefficient to get an optical depth).
 *
 * The Chapman grazing-incidence function in its asymptotic form,
 * sqrt(pi x / 2) exp(y^2) erfc(y) with y = sqrt(x / 2) cos(chi) — within a
 * percent or so of a brute-force integral for any ray the sky uses, where the
 * simpler rational fits are off by ten percent near the horizon. The exponent
 * of the lower branch is assembled before `exp` rather than as a product of
 * two exponentials: separately they overflow long before their product does.
 */
export function chapmanColumn(r: number, cosChi: number, scaleHeight: number): number {
  const x = r / scaleHeight;
  const hRel = (r - EARTH_RADIUS_M) / scaleHeight;
  if (cosChi >= 0) return scaleHeight * Math.exp(-hRel) * chapmanUpper(x, cosChi);
  // Below the local horizontal the ray passes its lowest point: the column is
  // the full grazing path twice, minus the half behind the start.
  const sinChi = Math.sqrt(Math.max(0, 1 - cosChi * cosChi));
  const x0 = x * sinChi;
  const e = Math.min(60, (EARTH_RADIUS_M - r * sinChi) / scaleHeight);
  return scaleHeight * (2 * Math.sqrt((Math.PI * x0) / 2) * Math.exp(e) - Math.exp(-hRel) * chapmanUpper(x, -cosChi));
}

/**
 * Distance from radius `r` along a ray with zenith cosine `mu` to where it
 * leaves the atmosphere or meets the ground, and whether it met the ground.
 */
function rayLength(r: number, mu: number): { length: number; ground: boolean } {
  const disc = r * r * (mu * mu - 1);
  const ground = disc + EARTH_RADIUS_M * EARTH_RADIUS_M;
  if (mu < 0 && ground >= 0) {
    return { length: Math.max(0, -r * mu - Math.sqrt(ground)), ground: true };
  }
  return { length: Math.max(0, -r * mu + Math.sqrt(Math.max(0, disc + TOP_R * TOP_R))), ground: false };
}

// ─── The integral ───────────────────────────────────────────────────────────

/** Sunlight reaching a point at `altitudeM`, per channel, for a sun at `sunElevationDeg`. */
export function sunTransmittance(altitudeM: number, sunElevationDeg: number, haze = 1, out: Rgb = [0, 0, 0]): Rgb {
  const r = EARTH_RADIUS_M + Math.max(0, altitudeM);
  const cosChi = Math.sin((sunElevationDeg * Math.PI) / 180);
  const colR = chapmanColumn(r, cosChi, RAYLEIGH_H);
  const colM = chapmanColumn(r, cosChi, MIE_H);
  const mieExt = (MIE_BETA * haze) / MIE_ALBEDO;
  for (let c = 0; c < 3; c++) {
    out[c] = Math.exp(-(RAYLEIGH_BETA[c]! + OZONE_BETA[c]!) * colR - mieExt * colM);
  }
  return out;
}

/**
 * Light scattered into one view direction, and the transmittance of the
 * whole ray. The camera is at the origin of a local frame with +y up and the
 * sun in the x-y plane; `azimuth` is measured from the sun's azimuth.
 */
export function integrateView(
  conditions: SkyConditions,
  elevation: number,
  azimuth: number,
  out: RaySample = { radiance: [0, 0, 0], transmittance: [1, 1, 1] },
): RaySample {
  const r0 = EARTH_RADIUS_M + Math.max(1, conditions.altitudeM);
  const haze = Math.max(0, conditions.haze);
  const ce = Math.cos(elevation);
  const vx = ce * Math.cos(azimuth);
  const vy = Math.sin(elevation);
  const vz = ce * Math.sin(azimuth);
  const se = (conditions.sunElevationDeg * Math.PI) / 180;
  const sx = Math.cos(se);
  const sy = Math.sin(se);
  const mu = vx * sx + vy * sy;
  const pR = phaseRayleigh(mu);
  const pM = phaseMie(mu);
  const mieScatter = MIE_BETA * haze;
  const mieExt = mieScatter / MIE_ALBEDO;

  const { length } = rayLength(r0, vy);
  const L = out.radiance;
  const T = out.transmittance;
  L[0] = L[1] = L[2] = 0;
  T[0] = T[1] = T[2] = 1;

  let prev = 0;
  for (let i = 1; i <= VIEW_STEPS; i++) {
    // Quadratic spacing: fine steps near the eye, where the air is dense and
    // a near-horizontal ray stays low for its first hundred kilometres.
    const f = i / VIEW_STEPS;
    const next = length * f * f;
    const ds = next - prev;
    const t = prev + ds * 0.5;
    prev = next;

    const px = vx * t;
    const py = r0 + vy * t;
    const pz = vz * t;
    const r = Math.sqrt(px * px + py * py + pz * pz);
    const h = r - EARTH_RADIUS_M;
    const dR = Math.exp(-h / RAYLEIGH_H);
    const dM = Math.exp(-h / MIE_H);
    const cosSun = (px * sx + py * sy) / r;
    const colR = chapmanColumn(r, cosSun, RAYLEIGH_H);
    const colM = chapmanColumn(r, cosSun, MIE_H);
    // Skylight at this point: full with the sun well up, gone a few degrees
    // into the Earth's shadow.
    const fill = MULTI_SCATTER * smoothstep(-0.12, 0.35, cosSun);

    for (let c = 0; c < 3; c++) {
      const bR = RAYLEIGH_BETA[c]!;
      const sun = Math.exp(-(bR + OZONE_BETA[c]!) * colR - mieExt * colM);
      const scatterR = bR * dR;
      const scatterM = mieScatter * dM;
      const source = sun * (scatterR * pR + scatterM * pM) + (scatterR + scatterM) * fill * MULTI_SCATTER_COLOR[c]!;
      const ext = scatterR + mieExt * dM;
      const segT = Math.exp(-ext * ds);
      // Energy-conserving: the source integrated over the step with the
      // step's own extinction, not sampled once and multiplied by ds.
      L[c] = L[c]! + (T[c]! * source * (1 - segT)) / Math.max(ext, 1e-12);
      T[c] = T[c]! * segT;
    }
  }
  return out;
}

// ─── The table ──────────────────────────────────────────────────────────────

/** Texels across (azimuth from the sun, 0..pi) and per half (sky, then haze) down. */
export const LUT_WIDTH = 64;
export const LUT_HALF = 48;
export const LUT_HEIGHT = LUT_HALF * 2;

/**
 * Where a view elevation lands in one half of the table, 0-1.
 *
 * Measured from the *true* horizon, not the local horizontal, and with a
 * square root on each side: nearly everything interesting — the haze band,
 * the sunset glow, the terrain edge — happens within a few degrees of that
 * line, so half the rows go there.
 */
export function lutV(elevation: number, dip: number): number {
  const l = elevation + dip;
  if (l >= 0) return 0.5 + 0.5 * Math.sqrt(Math.min(1, l / (Math.PI / 2 + dip)));
  return 0.5 - 0.5 * Math.sqrt(Math.min(1, -l / (Math.PI / 2 - dip)));
}

/** Inverse of `lutV`. */
export function lutElevation(v: number, dip: number): number {
  const s = (v - 0.5) * 2;
  const l = s >= 0 ? (Math.PI / 2 + dip) * s * s : -(Math.PI / 2 - dip) * s * s;
  return l - dip;
}

/** Azimuth from the sun to the table's u, 0-1: finer towards the sun, where the glow is. */
export function lutU(azimuth: number): number {
  return Math.sqrt(Math.min(1, Math.max(0, azimuth / Math.PI)));
}

/**
 * Radiance to what the screen shows, 0-1.
 *
 * A simple exponential shoulder, applied here once for every consumer. The
 * terrain and the imagery are not tone mapped, so the haze they fade into must
 * already be a display value, and the sky must be the same display value or
 * the horizon shows.
 */
export function expose(radiance: number, exposure: number): number {
  return 1 - Math.exp(-radiance * exposure);
}

/**
 * Exposure for a sun elevation: the eye opening up through dusk.
 *
 * Without it the sky goes from blue to black in the ten minutes after sunset,
 * where the real eye adapts and keeps seeing the afterglow and the blue hour.
 */
export function exposureFor(sunElevationDeg: number): number {
  const day = smoothstep(-9, 7, sunElevationDeg);
  return 11 * (1 + 4 * (1 - day));
}

/**
 * Colour grade: a saturation lift, in display values.
 *
 * Three-channel Rayleigh scattering is right in ratio and still reads grey
 * once sRGB-encoded — the deep zenith blue a camera or an eye reports comes
 * from spectral response, not from the three wavelengths this model carries.
 * Lifting saturation once, here, restores it for the sky and the haze alike,
 * so they stay the same colour as each other.
 */
const SKY_SATURATION = 1.3;

export function grade(rgb: Rgb): Rgb {
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  for (let c = 0; c < 3; c++) {
    rgb[c] = Math.min(1, Math.max(0, lum + (rgb[c]! - lum) * SKY_SATURATION));
  }
  return rgb;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Fill the table for one set of conditions, in display values.
 *
 * Rows `[0, LUT_HALF)` are the sky: what the dome shows in each direction.
 * Rows `[LUT_HALF, LUT_HEIGHT)` are the haze colour for the same directions:
 * the scattered light divided by the opacity of the ray, i.e. the colour an
 * infinitely hazy object in that direction would take. A material that knows
 * its own transmittance mixes towards this, and at the distance where that
 * transmittance reaches the ray's it reproduces the sky exactly.
 *
 * @param out RGBA, `LUT_WIDTH * LUT_HEIGHT * 4` floats.
 */
export function buildSkyLut(conditions: SkyConditions, out: Float32Array): void {
  const dip = horizonDip(conditions.altitudeM);
  const exposure = exposureFor(conditions.sunElevationDeg);
  const sample: RaySample = { radiance: [0, 0, 0], transmittance: [1, 1, 1] };
  const skyRgb: Rgb = [0, 0, 0];
  const hazeRgb: Rgb = [0, 0, 0];
  for (let j = 0; j < LUT_HALF; j++) {
    const elevation = lutElevation((j + 0.5) / LUT_HALF, dip);
    for (let i = 0; i < LUT_WIDTH; i++) {
      const u = (i + 0.5) / LUT_WIDTH;
      integrateView(conditions, elevation, Math.PI * u * u, sample);
      const sky = (j * LUT_WIDTH + i) * 4;
      const haze = ((j + LUT_HALF) * LUT_WIDTH + i) * 4;
      for (let c = 0; c < 3; c++) {
        skyRgb[c] = expose(sample.radiance[c]!, exposure);
        const opacity = 1 - sample.transmittance[c]!;
        // A ray of perfectly clear air has no haze colour; fall back to the
        // radiance itself, which for such a ray is almost nothing anyway.
        const hazeRadiance = opacity > 1e-4 ? sample.radiance[c]! / opacity : sample.radiance[c]! * 1e4;
        hazeRgb[c] = expose(hazeRadiance, exposure);
      }
      grade(skyRgb);
      grade(hazeRgb);
      for (let c = 0; c < 3; c++) {
        out[sky + c] = skyRgb[c]! + NIGHT_SKY[c]!;
        out[haze + c] = hazeRgb[c]! + NIGHT_SKY[c]!;
      }
      out[sky + 3] = 1;
      out[haze + 3] = 1;
    }
  }
  // Sky rows below the true horizon are never shown (the dome draws the haze
  // there), but the texture filter blends the last of them into the first row
  // above: rays that meet the ground a kilometre away are nearly black, and
  // left alone they draw a dark line along the horizon. Repeat the horizon.
  const first = LUT_HALF / 2;
  const row = LUT_WIDTH * 4;
  for (let j = 0; j < first; j++) out.copyWithin(j * row, first * row, (first + 1) * row);
}

// ─── Light for the models ───────────────────────────────────────────────────

export interface SceneLight {
  /** Colour of direct sunlight, normalised so its brightest channel is 1. */
  sunColor: Rgb;
  /** Relative strength of direct sunlight, 0 (below the horizon) to 1. */
  sunStrength: number;
  /** Colour of the sky's diffuse light, display values. */
  skyColor: Rgb;
  /** Relative strength of the diffuse light, a night floor to 1. */
  skyStrength: number;
}

/**
 * The sunlight and skylight a model at the camera receives.
 *
 * Normalised to the midday values, so at noon the models look exactly as they
 * were tuned and only the colour and the balance move through the day.
 */
export function sceneLight(conditions: SkyConditions, out?: SceneLight): SceneLight {
  const t = sunTransmittance(conditions.altitudeM, conditions.sunElevationDeg, conditions.haze);
  const max = Math.max(t[0], t[1], t[2], 1e-6);
  // The disc sinking below the horizon, not an instant switch.
  const above = smoothstep(-1.2, 3, conditions.sunElevationDeg);
  const sunStrength = Math.min(1, (max / NOON_SUN) * above);
  const day = smoothstep(-12, 10, conditions.sunElevationDeg);
  const light = out ?? { sunColor: [1, 1, 1], sunStrength: 0, skyColor: [1, 1, 1], skyStrength: 0 };
  light.sunColor[0] = t[0] / max;
  light.sunColor[1] = t[1] / max;
  light.sunColor[2] = t[2] / max;
  light.sunStrength = sunStrength;
  // Skylight is blue by day and drifts to the twilight violet-blue.
  light.skyColor[0] = 0.62 + 0.1 * day;
  light.skyColor[1] = 0.74 + 0.08 * day;
  light.skyColor[2] = 1;
  light.skyStrength = 0.12 + 0.88 * day;
  return light;
}

/** Brightest channel of sea-level sunlight with the sun high, for normalising. */
const NOON_SUN = (() => {
  const t = sunTransmittance(0, 60, 1);
  return Math.max(t[0], t[1], t[2]);
})();

// ─── Haze on surfaces ───────────────────────────────────────────────────────

/**
 * Per-channel transmittance from the eye to a point, in the closed form the
 * shader uses (`atmoTransmittance` in `./shader.ts`). Blue dies first, which
 * is what turns distant ground blue before it turns into sky.
 */
export function surfaceTransmittance(
  lengthM: number,
  fromAltM: number,
  toAltM: number,
  haze = 1,
  out: Rgb = [1, 1, 1],
): Rgb {
  const colR = column(lengthM, fromAltM, toAltM, RAYLEIGH_H);
  const colM = column(lengthM, fromAltM, toAltM, MIE_H);
  const mieExt = (MIE_BETA * haze) / MIE_ALBEDO;
  for (let c = 0; c < 3; c++) out[c] = Math.exp(-RAYLEIGH_BETA[c]! * colR - mieExt * colM);
  return out;
}

/** Sea-level-equivalent air along a straight segment through an exponential profile. */
export function column(lengthM: number, fromAltM: number, toAltM: number, scaleHeight: number): number {
  const h0 = Math.max(fromAltM, 0);
  const h1 = Math.max(toAltM, 0);
  const dh = h1 - h0;
  if (Math.abs(dh) < 1) return Math.exp(-h0 / scaleHeight) * lengthM;
  return Math.abs(scaleHeight * (lengthM / dh) * (Math.exp(-h0 / scaleHeight) - Math.exp(-h1 / scaleHeight)));
}

/** Mie extinction per metre at sea level for a haze multiplier (the shader's uniform). */
export function mieExtinction(haze: number): number {
  return (MIE_BETA * haze) / MIE_ALBEDO;
}

/**
 * Aerosol multiplier from a reported visibility.
 *
 * Only ever thickens: forecast models report "visibility" capped near 24 km
 * on most clear days, and taking that literally would put a grey veil on
 * every cruise view. Below it, the Koschmieder relation (extinction =
 * 3.912 / visibility) sets how much extra aerosol the report implies.
 */
export function hazeForVisibility(visibilityM: number | null): number {
  if (visibilityM === null || !Number.isFinite(visibilityM) || visibilityM >= 20_000) return 1;
  const v = Math.max(1500, visibilityM);
  const extinction = 3.912 / v;
  const clear = 3.912 / 20_000;
  return Math.min(150, 1 + (extinction - clear) / (MIE_BETA / MIE_ALBEDO));
}
