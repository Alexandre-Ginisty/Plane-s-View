/**
 * "Catch a landing" / "Catch a takeoff": find an aircraft doing it now.
 *
 * Nearby first, because the nearest one is the one whose terrain is already
 * streamed and whose feed is already being polled — stepping into it is
 * instant. Only when nothing in the tracked traffic qualifies does the search
 * go out to the busy airspaces of `shuffle.ts`, where at any hour something
 * is on final somewhere.
 *
 * Ranked rather than filtered: an aircraft on short final beats one still on
 * a long approach, and a takeoff roll beats an initial climb, because the
 * point is to arrive in time to watch the moment itself.
 */

import type { AircraftState } from '@/data/types';
import { classifyPhase, type FlightPhase, type PhaseInput } from '@/state/phase';
import type { SampledAircraft } from '@/state/traffic';
import { haversineMetres } from '@/core/math/geo';
import { hasUsableFix } from './shuffle';

export type CatchKind = 'landing' | 'takeoff';

/** Lower is better; phases not listed do not qualify. */
const RANK: Record<CatchKind, Partial<Record<FlightPhase, number>>> = {
  landing: { final: 0, approach: 1 },
  takeoff: { takeoff: 0, departure: 1 },
};

export const CATCH_LABELS: Record<CatchKind, { verb: string; noun: string }> = {
  landing: { verb: 'Catch a landing', noun: 'landing' },
  takeoff: { verb: 'Catch a takeoff', noun: 'takeoff' },
};

/** Rank of a phase for a kind of catch, or null when it does not qualify. */
function catchRank(kind: CatchKind, phase: FlightPhase): number | null {
  return RANK[kind][phase] ?? null;
}

/**
 * Phase of one raw report, with no history and no terrain. Good enough to
 * pick a candidate; the cockpit's own tracker takes over once aboard.
 */
function phaseOfState(a: AircraftState): FlightPhase {
  const input: PhaseInput = {
    onGround: a.onGround === true,
    groundSpeedKt: a.groundSpeedKt ?? 0,
    verticalRateFpm: a.baroRateFpm ?? a.geomRateFpm ?? 0,
    aglFt: Number.NaN,
    altFt: a.altBaroFt ?? a.altGeomFt ?? 0,
  };
  return classifyPhase(input);
}

/** For the worldwide search. */
export function acceptsForCatch(kind: CatchKind): (a: AircraftState) => boolean {
  return (a) => hasUsableFix(a) && catchRank(kind, phaseOfState(a)) === 0;
}

/**
 * Best candidate among tracked aircraft: best rank, then nearest to `near`.
 */
export function pickNearby(
  kind: CatchKind,
  samples: readonly SampledAircraft[],
  near: { lat: number; lon: number },
  excludeHex: string | null,
): SampledAircraft | null {
  let best: SampledAircraft | null = null;
  let bestRank = Infinity;
  let bestDistance = Infinity;

  for (const s of samples) {
    if (s.hex === excludeHex || s.stale) continue;
    const phase = classifyPhase({
      onGround: s.latest.onGround === true,
      groundSpeedKt: s.groundSpeedKt,
      verticalRateFpm: s.verticalRateFpm,
      aglFt: Number.NaN,
      altFt: s.altFt,
    });
    const rank = catchRank(kind, phase);
    if (rank === null || rank > bestRank) continue;
    const distance = haversineMetres(near.lat, near.lon, s.lat, s.lon);
    if (rank < bestRank || distance < bestDistance) {
      best = s;
      bestRank = rank;
      bestDistance = distance;
    }
  }
  return best;
}
