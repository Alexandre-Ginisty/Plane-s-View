/**
 * International Standard Atmosphere: density and the speed of sound.
 *
 * Adapted from Tater's Flight Sim (MIT, Copyright (c) 2026 Jared Tate — see
 * ./LICENSE).
 */

const SEA_LEVEL_DENSITY = 1.225;

const T0 = 288.15;
const LAPSE = 0.0065;
const R_AIR = 287.053;
const G0 = 9.80665;
const EXPONENT = G0 / (R_AIR * LAPSE) - 1;
const TROPOPAUSE = 11000;
const T11 = T0 - LAPSE * TROPOPAUSE;
const GAMMA_AIR = 1.4;

/** kg/m³ at a geometric altitude MSL: ISA troposphere, isothermal above. */
export function airDensity(altitudeM: number): number {
  if (!Number.isFinite(altitudeM)) return SEA_LEVEL_DENSITY;
  const h = Math.min(Math.max(altitudeM, -1000), 30000);
  if (h <= TROPOPAUSE) return SEA_LEVEL_DENSITY * Math.pow(1 - (LAPSE * h) / T0, EXPONENT);
  const rho11 = SEA_LEVEL_DENSITY * Math.pow(T11 / T0, EXPONENT);
  return rho11 * Math.exp((-G0 * (h - TROPOPAUSE)) / (R_AIR * T11));
}

function temperatureK(altitudeM: number): number {
  if (!Number.isFinite(altitudeM)) return T0;
  const h = Math.min(Math.max(altitudeM, -1000), 30000);
  return h <= TROPOPAUSE ? T0 - LAPSE * h : T11;
}

/** m/s at a geometric altitude MSL. */
export function speedOfSound(altitudeM: number): number {
  return Math.sqrt(GAMMA_AIR * R_AIR * temperatureK(altitudeM));
}
