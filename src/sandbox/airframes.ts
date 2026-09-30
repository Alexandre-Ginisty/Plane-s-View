/**
 * Which flight model each sandbox aircraft flies.
 *
 * Four airframes are calibrated against real data (`@/flight/config`): a
 * Cessna 172, an F-16, an A-10 and a 747. The F-16 and the A-10 fly theirs
 * exactly. Everything else is built from the closest of the four by
 * similarity scaling to the model's own length — fighters from the F-16,
 * attack jets from the A-10, airliners from the 747, propeller aircraft from
 * the Cessna — so an A320 handles like a smaller, lighter 747,
 * with the 747's calibrated stability, stall and engine behaviour, rather than
 * like numbers made up per type. Where plain scaling lands far from the real
 * aircraft's weight (big turboprops come out too heavy from a Cessna), the
 * real mass is given and the speeds follow the wing loading; fighters also get
 * their real thrust-to-weight ratio.
 *
 * Helicopters have no flight model here and keep the arcade one.
 */

import { A10, B747, C172, F16, SIM, scaleAirframe, type AircraftConfig, type FlightConfig, type ScaleOptions } from '@/flight/config';
import type { SandboxAircraft } from './catalog';

type Base = 'c172' | 'b747' | 'f16' | 'a10';

/** Model id → the airframe it scales from, and anything plain scaling gets wrong. */
const DERIVED: Record<string, { base: Base } & Partial<Omit<ScaleOptions, 'name' | 'lengthM'>>> = {
  // Fighters: the F-16's fly-by-wire handling at their own weight, the thrust
  // scaled to their thrust-to-weight ratio (the F-16's is 1.1).
  hornet: { base: 'f16', massKg: 16_800, powerFactor: 0.87 },
  eagle: { base: 'f16', massKg: 20_200, powerFactor: 0.97 },
  tomcat: { base: 'f16', massKg: 27_700, powerFactor: 0.84 },
  mirage: { base: 'f16', massKg: 10_000, powerFactor: 0.88 },
  gripen: { base: 'f16', massKg: 8_500, powerFactor: 0.88 },
  fulcrum: { base: 'f16', massKg: 15_300, powerFactor: 0.99 },
  fishbed: { base: 'f16', massKg: 8_700, powerFactor: 0.75 },
  // An armoured attack jet from the other armoured attack jet.
  frogfoot: { base: 'a10', massKg: 14_600, powerFactor: 1.2 },
  // Propeller fighters: a Cessna's handling at their weight and power.
  corsair: { base: 'c172', massKg: 5_200, powerFactor: 1.35, vneKt: 400 },
  mustang: { base: 'c172', massKg: 4_580, powerFactor: 1.3, vneKt: 440 },
  // Turboprops at their real weights.
  dh8d: { base: 'c172', massKg: 27_000, powerFactor: 1.6 },
  at72: { base: 'c172', massKg: 21_000, powerFactor: 1.4 },
  f50: { base: 'c172', massKg: 19_000, powerFactor: 1.3 },
  f27: { base: 'c172', massKg: 18_000, powerFactor: 1.3 },
  d228: { base: 'c172', massKg: 6_000, powerFactor: 1.3 },
  b190: { base: 'c172', massKg: 7_000, powerFactor: 1.4 },
  l410: { base: 'c172', powerFactor: 1.2 },
  be20: { base: 'c172', powerFactor: 1.4 },
  pc12: { base: 'c172', powerFactor: 1.3 },
  c208: { base: 'c172' },
  da40: { base: 'c172' },
  c172: { base: 'c172' },
};

const BASES: Record<Base, AircraftConfig> = { c172: C172, b747: B747, f16: F16, a10: A10 };

/**
 * The flight model for an aircraft, or null for the arcade one.
 *
 * @param lengthM the length of the 3D model it is drawn with
 */
export function airframeFor(a: SandboxAircraft, lengthM: number): FlightConfig | null {
  if (a.flight.heli) return null;
  if (a.id === 'viper') return { sim: SIM, aircraft: F16 };
  if (a.id === 'warthog') return { sim: SIM, aircraft: A10 };
  const d = DERIVED[a.id] ?? { base: 'b747' as const };
  const base = BASES[d.base];
  const length = Number.isFinite(lengthM) && lengthM > 2 ? lengthM : base.geometry.length;
  if (d.base === 'c172' && a.id === 'c172') return { sim: SIM, aircraft: C172 };
  return {
    sim: SIM,
    aircraft: scaleAirframe(base, {
      name: a.name,
      lengthM: length,
      massKg: d.massKg,
      powerFactor: d.powerFactor,
      vneKt: d.vneKt,
    }),
  };
}
