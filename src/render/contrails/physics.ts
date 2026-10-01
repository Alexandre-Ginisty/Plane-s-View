/**
 * Whether an aircraft leaves a contrail, and for how long it stays: PURE.
 *
 * ## Forming: the Schmidt–Appleman criterion
 *
 * Exhaust is hot and wet; mixing into cold air it passes, on a straight line
 * in (temperature, vapour pressure), close to the saturation curve. Where the
 * line crosses it the mixture condenses and freezes — a contrail. The slope of
 * the line is
 *
 *     G = EI·cp·p / (ε·Q·(1 − η))      Pa/K
 *
 * (water per kilogram of fuel, heat capacity of air, pressure, molar mass
 * ratio, fuel energy and the engine's propulsive efficiency), and the warmest
 * air in which it still happens, for saturated air, is Schumann's fit
 *
 *     T_LM = −46.46 + 9.43·ln(G − 0.053) + 0.72·ln²(G − 0.053)      °C.
 *
 * For drier air the threshold is colder: the temperature `T_LC` at which the
 * mixing line from the ambient point is tangent-parallel to it, found here by
 * bisection. A modern turbofan at FL350 in dry air: about −41 °C.
 *
 * ## Staying: ice supersaturation
 *
 * Once formed, the ice survives only where the air is supersaturated over
 * ice. Weather models report humidity over water; at −50 °C water's
 * saturation pressure is about 1.6 times ice's, so 65 % over water is already
 * supersaturated over ice. There the trail spreads into a band that lasts
 * tens of minutes; elsewhere it sublimates in seconds, a short white stub
 * behind the aircraft.
 */

import type { AloftLevel } from '@/data/types';

/** Water emitted per kilogram of kerosene, kg. */
const EI_H2O = 1.25;
/** Heat capacity of air at constant pressure, J/(kg·K). */
const CP = 1004;
/** Ratio of the molar masses of water and air. */
const EPSILON = 0.622;
/** Heat of combustion of kerosene, J/kg. */
const Q_FUEL = 43.2e6;
/** Overall propulsive efficiency of a current turbofan. */
const ETA = 0.33;

/** ISA pressure at a geopotential altitude, hPa. */
export function isaPressureHpa(altM: number): number {
  if (altM <= 11_000) return 1013.25 * Math.pow(1 - 2.25577e-5 * altM, 5.25588);
  return 226.32 * Math.exp(-(altM - 11_000) / 6341.6);
}

/** ISA temperature, °C. */
export function isaTemperatureC(altM: number): number {
  return altM <= 11_000 ? 15 - 0.0065 * altM : -56.5;
}

/** Saturation vapour pressure over supercooled water, Pa (Murphy & Koop 2005). */
export function satWaterPa(tC: number): number {
  const T = tC + 273.15;
  const lnT = Math.log(T);
  return Math.exp(
    54.842763 - 6763.22 / T - 4.21 * lnT + 0.000367 * T +
      Math.tanh(0.0415 * (T - 218.8)) * (53.878 - 1331.22 / T - 9.44523 * lnT + 0.014025 * T),
  );
}

/** Saturation vapour pressure over ice, Pa (Murphy & Koop 2005). */
export function satIcePa(tC: number): number {
  const T = tC + 273.15;
  return Math.exp(9.550426 - 5723.265 / T + 3.53068 * Math.log(T) - 0.00728332 * T);
}

/** Slope of the exhaust mixing line, Pa/K. */
function mixingSlope(pressureHpa: number): number {
  return (EI_H2O * CP * pressureHpa * 100) / (EPSILON * Q_FUEL * (1 - ETA));
}

/**
 * The warmest ambient temperature at which a contrail forms, °C, at a
 * pressure and a relative humidity over water (0..1).
 */
export function contrailThresholdC(pressureHpa: number, rhWater: number): number {
  const g = mixingSlope(pressureHpa);
  const l = Math.log(Math.max(g - 0.053, 1e-6));
  const tLM = -46.46 + 9.43 * l + 0.72 * l * l;
  const rh = Math.min(1, Math.max(0, rhWater));
  if (rh >= 1) return tLM;
  // The ambient point whose mixing line just reaches saturation at T_LM.
  const eLM = satWaterPa(tLM);
  const f = (t: number) => eLM - g * (tLM - t) - rh * satWaterPa(t);
  let lo = tLM - 40;
  let hi = tLM;
  if (f(lo) > 0) return lo;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** The air at an aircraft: what decides its trail. */
export interface AirAt {
  pressureHpa: number;
  tempC: number;
  /** Relative humidity over water, 0..1. */
  rhWater: number;
}

/** Humidity assumed where no weather model has answered: typical of the upper troposphere. */
const DEFAULT_RH_WATER = 0.5;

/**
 * The air at an altitude. Temperature: what the aircraft measures, else the
 * weather model's, else the standard atmosphere; humidity: the model's,
 * interpolated in log-pressure, else a typical value.
 */
export function airAt(altM: number, measuredTempC: number | null, aloft: readonly AloftLevel[] | null, out: AirAt): AirAt {
  const p = isaPressureHpa(altM);
  out.pressureHpa = p;
  let modelT: number | null = null;
  let rh = DEFAULT_RH_WATER;
  if (aloft && aloft.length) {
    // Levels are ordered from high pressure (low) to low pressure (high).
    const lp = Math.log(p);
    let a = aloft[0]!;
    let b = aloft[aloft.length - 1]!;
    if (p >= a.hPa) b = a;
    else if (p <= b.hPa) a = b;
    else {
      for (let i = 1; i < aloft.length; i++) {
        if (p >= aloft[i]!.hPa) {
          a = aloft[i - 1]!;
          b = aloft[i]!;
          break;
        }
      }
    }
    const t = a === b ? 0 : (lp - Math.log(a.hPa)) / (Math.log(b.hPa) - Math.log(a.hPa));
    modelT = a.tempC + (b.tempC - a.tempC) * t;
    rh = (a.rhPct + (b.rhPct - a.rhPct) * t) / 100;
  }
  out.tempC = measuredTempC !== null && measuredTempC > -90 && measuredTempC < 30 ? measuredTempC : (modelT ?? isaTemperatureC(altM));
  out.rhWater = Math.min(1.2, Math.max(0, rh));
  return out;
}

/** The trail an aircraft leaves in that air. */
export interface TrailVerdict {
  /** 0: none; up to 1, a dense trail — thin just inside the threshold. */
  density: number;
  /** Seconds a point of it stays visible. */
  lifeS: number;
  /** Supersaturated over ice: it spreads and lingers. */
  persistent: boolean;
}

/** Below this, nothing forms whatever the air: jet exhaust over a warm lower atmosphere. */
const MIN_CONTRAIL_ALT_M = 7000;

export function trailFor(altM: number, air: AirAt, out: TrailVerdict): TrailVerdict {
  out.density = 0;
  out.lifeS = 0;
  out.persistent = false;
  if (altM < MIN_CONTRAIL_ALT_M) return out;
  const margin = contrailThresholdC(air.pressureHpa, air.rhWater) - air.tempC;
  if (margin <= 0) return out;
  const rhIce = (air.rhWater * satWaterPa(air.tempC)) / satIcePa(air.tempC);
  out.density = Math.min(1, Math.sqrt(margin / 4));
  out.persistent = rhIce >= 1;
  // Persistent trails outlast any history kept; short ones sublimate in
  // seconds in dry air, longer as the air nears ice saturation.
  const wet = Math.min(1, Math.max(0, (rhIce - 0.4) / 0.6));
  out.lifeS = out.persistent ? 900 : 3 + 30 * wet * wet;
  return out;
}
