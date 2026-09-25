/**
 * Turning whatever a feed sent into values that can be trusted.
 *
 * Every provider here is a free community service assembling data from
 * volunteer receivers, and the JSON reflects that: numbers arrive as strings,
 * `"ground"` arrives where an altitude should be, absent fields are sometimes
 * `null`, sometimes `""`, sometimes missing. Coercing defensively in one place
 * means the normalisers below can be read as a mapping rather than as a
 * minefield.
 *
 * The clock handling is the subtle part and is documented where it lives: the
 * readsb family disagree about the units of their own `now` field, and a feed
 * whose clock is wrong is worse than a feed with no clock at all, because
 * every fix it stamps is then confidently mis-aged.
 */

export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Normalise a feed clock to epoch milliseconds.
 *
 * The readsb-family providers disagree about units for the top-level `now`,
 * and nothing in the payload declares which is meant:
 *
 *   adsb.lol -> 1790080770002  (milliseconds)
 *   adsb.fi  -> 1790080986     (seconds)
 *
 * Read the wrong way, a seconds timestamp lands in January 1970, every
 * aircraft appears decades stale, and the staleness pruner deletes the whole
 * fleet on the same tick it was inserted — a feed that returns 200 OK with
 * hundreds of aircraft and still shows an empty map.
 *
 * Magnitude is the only available discriminator: epoch *seconds* passed 1e9 in
 * 2001 and will not reach 1e12 until the year 33658, while epoch
 * *milliseconds* passed 1e12 in 2001. So 1e12 separates them unambiguously for
 * any date this software could plausibly run on.
 */
export function feedClockToMs(value: unknown): number | null {
  const n = num(value);
  if (n === null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Reject a feed clock that disagrees wildly with our own.
 *
 * Even after unit normalisation a provider can serve a stuck or misconfigured
 * clock. Trusting it would silently age out every aircraft, so beyond a
 * generous tolerance we fall back to local time.
 */
const MAX_FEED_CLOCK_SKEW_MS = 10 * 60_000;

export function usableFeedClock(feedNowMs: number | null, receivedAt: number): number | null {
  if (feedNowMs === null) return null;
  return Math.abs(receivedAt - feedNowMs) <= MAX_FEED_CLOCK_SKEW_MS ? feedNowMs : null;
}

export const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

/** `"none"` is readsb's way of saying "no emergency", which is not a value. */
export const emergencyOrNull = (v: unknown): string | null => {
  const s = str(v);
  return s && s.toLowerCase() !== 'none' ? s : null;
};

export function validPosition(lat: number | null, lon: number | null): boolean {
  return (
    lat !== null &&
    lon !== null &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    // 0,0 is Null Island: always a decode artefact, never an aircraft.
    !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6)
  );
}
