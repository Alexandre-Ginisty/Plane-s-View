/**
 * The flight so far: where the selected aircraft has been since it took off.
 *
 * The live feed only knows where an aircraft is; the trail drawn from it
 * starts when this page first saw it. adsb.lol keeps each aircraft's track
 * as readsb writes it — the day's (`trace_full`, rewritten every few minutes)
 * and the last half hour (`trace_recent`) — under the same ODbL as the
 * positions, so the whole leg can be drawn from the moment of selection.
 *
 * ## The format
 *
 * `{ timestamp, trace: [[dt, lat, lon, alt, gs, track, flags, …], …] }`:
 * seconds after `timestamp`, degrees, feet or `"ground"`. Bit 2 of `flags`
 * marks the first point of a new leg — readsb's own judgement of where one
 * flight ends and the next begins — so the current flight is everything from
 * the last such mark.
 */

import { relayUrl } from '@/data/endpoints';
import { fetchJson } from '@/data/http';
import type { TrailPoint } from '@/state/track';

const HEX = /^~?[0-9a-f]{6}$/;
/** A point further from the last than this, in seconds, starts a new leg even unmarked. */
const GAP_S = 30 * 60;

interface TraceFile {
  timestamp?: unknown;
  trace?: unknown;
}

/** The points of a trace file, oldest first, with absolute times (ms). */
export function parseTrace(body: unknown): (TrailPoint & { newLeg: boolean })[] {
  if (typeof body !== 'object' || body === null) return [];
  const { timestamp, trace } = body as TraceFile;
  if (typeof timestamp !== 'number' || !Array.isArray(trace)) return [];
  const out: (TrailPoint & { newLeg: boolean })[] = [];
  for (const row of trace) {
    if (!Array.isArray(row)) continue;
    const [dt, lat, lon, alt, , , flags] = row as unknown[];
    if (typeof dt !== 'number' || typeof lat !== 'number' || typeof lon !== 'number') continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const altFt = alt === 'ground' ? 0 : typeof alt === 'number' ? alt : null;
    out.push({
      lat,
      lon,
      altFt: altFt ?? out[out.length - 1]?.altFt ?? 0,
      t: (timestamp + dt) * 1000,
      newLeg: typeof flags === 'number' && (flags & 2) !== 0,
    });
  }
  return out;
}

/**
 * The current leg from the day's trace and the recent one: merged on time,
 * then cut at the last start of a leg (or the last long silence).
 */
export function currentLeg(full: readonly (TrailPoint & { newLeg: boolean })[], recent: readonly (TrailPoint & { newLeg: boolean })[]): TrailPoint[] {
  const end = full.length ? full[full.length - 1]!.t : -Infinity;
  const all = [...full, ...recent.filter((p) => p.t > end)];
  let start = 0;
  for (let i = 1; i < all.length; i++) {
    if (all[i]!.newLeg || all[i]!.t - all[i - 1]!.t > GAP_S * 1000) start = i;
  }
  return all.slice(start).map(({ lat, lon, altFt, t }) => ({ lat, lon, altFt, t }));
}

const fileUrl = (hex: string, kind: 'full' | 'recent') =>
  relayUrl('adsb-lol-traces', `/data/traces/${hex.slice(-2)}/trace_${kind}_${hex}.json`);

/** The leg flown so far, or an empty list when it cannot be had. Never throws. */
export async function fetchFlightTrace(hex: string, signal?: AbortSignal): Promise<TrailPoint[]> {
  const id = hex.toLowerCase();
  if (!HEX.test(id)) return [];
  const get = (kind: 'full' | 'recent') =>
    fetchJson<unknown>(fileUrl(id, kind), { timeoutMs: 10_000, retries: 0, ...(signal ? { signal } : {}) })
      .then(parseTrace)
      .catch(() => []);
  const [full, recent] = await Promise.all([get('full'), get('recent')]);
  return currentLeg(full, recent);
}
