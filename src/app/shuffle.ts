/**
 * "Take me somewhere else": a random aircraft, anywhere on Earth.
 *
 * ## Why it is not actually random
 *
 * A uniformly random point on the globe is water seven times out of ten, and
 * most of the land is not under a flight path either. Sampling the planet
 * evenly would spend most of its attempts on an empty circle over the South
 * Pacific and feel broken long before it found anything.
 *
 * So the randomness is over *airspace*, not over area: a hand-picked list of
 * regions that reliably have traffic at some hour, weighted by nothing and
 * shuffled on every call. That is the honest description of the feature —
 * "somewhere else in the world, picked at random from the busy parts" — and it
 * is what makes it land on an interesting aircraft rather than on the ocean.
 *
 * ## Time of day is the whole difficulty
 *
 * Europe at 04:00 UTC has almost nothing airborne; the Gulf and East Asia are
 * busy at exactly that hour. The list therefore spans every longitude band, and
 * the search walks it until something answers rather than trusting any one
 * region — because on a given attempt roughly a third of them are asleep.
 */

import type { AircraftState, TrafficQuery, TrafficSnapshot } from '@/data/types';

export interface Region {
  name: string;
  lat: number;
  lon: number;
}

/**
 * Airspaces with dependable traffic, spread across every longitude band so
 * that some of them are always in daylight hours.
 *
 * Coordinates are the middle of the busy volume, not the airport: a circle
 * centred on the terminal is mostly aircraft on stands, and a parked aircraft
 * makes a poor thing to be teleported into.
 */
export const REGIONS: readonly Region[] = [
  // Europe
  { name: 'the London TMA', lat: 51.5, lon: -0.3 },
  { name: 'the Paris basin', lat: 49.0, lon: 2.5 },
  { name: 'the Rhine corridor', lat: 50.1, lon: 8.6 },
  { name: 'the Alps', lat: 46.8, lon: 9.5 },
  { name: 'the Costa del Sol', lat: 36.8, lon: -4.5 },
  { name: 'the Bosphorus', lat: 41.0, lon: 29.0 },
  { name: 'the Norwegian coast', lat: 60.2, lon: 5.3 },
  // North America
  { name: 'the New York approach', lat: 40.7, lon: -73.9 },
  { name: 'the Chicago hub', lat: 41.9, lon: -87.9 },
  { name: 'the Los Angeles basin', lat: 33.9, lon: -118.2 },
  { name: 'the Rocky Mountains', lat: 39.8, lon: -104.7 },
  { name: 'the Gulf Coast', lat: 29.8, lon: -95.3 },
  { name: 'the Florida Keys', lat: 25.8, lon: -80.3 },
  { name: 'the Saint Lawrence', lat: 45.5, lon: -73.6 },
  // Asia and the Gulf
  { name: 'the Kanto plain', lat: 35.6, lon: 140.0 },
  { name: 'the Pearl River delta', lat: 22.6, lon: 113.9 },
  { name: 'the Singapore Strait', lat: 1.4, lon: 103.9 },
  { name: 'the Gulf', lat: 25.3, lon: 55.4 },
  { name: 'the Bay of Bengal', lat: 13.0, lon: 80.2 },
  { name: 'the Bosporus of Korea', lat: 37.5, lon: 126.8 },
  // Southern hemisphere
  { name: 'the Sydney basin', lat: -33.9, lon: 151.2 },
  { name: 'the Tasman Sea', lat: -37.0, lon: 174.8 },
  { name: 'the Rio coast', lat: -22.9, lon: -43.2 },
  { name: 'the Highveld', lat: -26.1, lon: 28.2 },
  { name: 'the Atacama', lat: -33.4, lon: -70.8 },
];

/** Radius searched around a region, nautical miles. */
const SEARCH_RADIUS_NM = 150;

/** How many regions to try before giving up for this attempt. */
const MAX_REGIONS_TRIED = 5;

/**
 * Minimum altitude for a candidate, feet.
 *
 * Being dropped into an airliner at cruise over the Alps is the experience
 * this button is for. Being dropped onto a stand at Frankfurt is not: nothing
 * moves, the view never changes, and the feed for a parked aircraft is so
 * sparse that the session times out on its own a few seconds later.
 */
const MIN_ALT_FT = 2_000;

/** And a floor on speed, which also excludes anything taxiing or towed. */
const MIN_SPEED_KT = 80;

export interface ShuffleResult {
  aircraft: AircraftState;
  region: Region;
}

export type FetchArea = (
  query: TrafficQuery,
  signal?: AbortSignal,
) => Promise<TrafficSnapshot | null>;

/** Fisher-Yates, on a copy. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Airborne, moving, and carrying enough data to be worth flying. */
export function isWorthFlying(a: AircraftState): boolean {
  if (a.onGround) return false;
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return false;

  const alt = a.altGeomFt ?? a.altBaroFt;
  if (alt === null || alt < MIN_ALT_FT) return false;

  // A null ground speed is missing data, not a stationary aircraft — but it
  // gives the camera nothing to orient by, so it is still the wrong pick when
  // hundreds of better ones are in the same snapshot.
  if ((a.groundSpeedKt ?? 0) < MIN_SPEED_KT) return false;

  // Track is what the whole body frame is built from. Without it the aircraft
  // would be drawn, and flown, pointing due north regardless of where it is
  // going.
  return a.trackDeg !== null || a.headingDeg !== null;
}

/**
 * Find one aircraft worth stepping into, somewhere in the world.
 *
 * Walks a shuffled region list until a query returns a usable candidate.
 * Returns null only when every region tried was empty or unreachable, which in
 * practice means the feed itself is down — the caller should say so rather
 * than retry, because trying again will walk the same dead providers.
 */
export async function findRandomAircraft(
  fetchArea: FetchArea,
  options: {
    signal?: AbortSignal;
    random?: () => number;
    /** Excluded from the result — normally the aircraft being flown now. */
    excludeHex?: string | null;
  } = {},
): Promise<ShuffleResult | null> {
  const random = options.random ?? Math.random;
  const order = shuffled(REGIONS, random).slice(0, MAX_REGIONS_TRIED);

  for (const region of order) {
    if (options.signal?.aborted) return null;

    let snapshot: TrafficSnapshot | null = null;
    try {
      snapshot = await fetchArea(
        { lat: region.lat, lon: region.lon, radiusNm: SEARCH_RADIUS_NM },
        options.signal,
      );
    } catch {
      // A dead region is not a dead feature: try the next one.
      continue;
    }

    const candidates = (snapshot?.aircraft ?? []).filter(
      (a) => a.hex !== options.excludeHex && isWorthFlying(a),
    );
    if (candidates.length === 0) continue;

    const pick = candidates[Math.floor(random() * candidates.length)];
    if (pick) return { aircraft: pick, region };
  }

  return null;
}
