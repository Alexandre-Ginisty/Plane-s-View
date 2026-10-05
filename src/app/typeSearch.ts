/**
 * "Fly me in a …": one aircraft of an exact model, picked at random.
 *
 * The feed answers with every aircraft of the type it can see, parked ones and
 * ones barely off the runway included. A random pick from all of them lands on
 * a stand at some airport as often as not, so those are only a last resort.
 */

import type { AircraftState } from '@/data/types';
import { hasUsableFix, isWorthFlying } from './shuffle';

export function pickOfType(
  aircraft: readonly AircraftState[],
  options: { random?: () => number; excludeHex?: string | null } = {},
): AircraftState | null {
  const random = options.random ?? Math.random;
  const usable = aircraft.filter((a) => a.hex !== options.excludeHex && hasUsableFix(a));
  // Cruising or climbing first; anything airborne next; never a parked one.
  const pools = [usable.filter(isWorthFlying), usable.filter((a) => !a.onGround)];
  for (const pool of pools) {
    if (pool.length > 0) return pool[Math.floor(random() * pool.length)] ?? null;
  }
  return null;
}
