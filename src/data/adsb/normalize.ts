/**
 * Provider payload -> `AircraftState`.
 *
 * One wire format: **readsb / tar1090 JSON** — `{ ac: [...] }`, one object per
 * aircraft, aviation units. adsb.lol serves it; so would any other
 * readsb-based feed, which is why the parser is not named after one provider.
 *
 * In the readsb schema `r` is the **registration** and `t` is the **type code**
 * (not receiver distance and timestamp). Distance to the receiver is `dst`, and
 * the timestamp is the top-level `now`. Mapping them correctly means the
 * registration and airframe type arrive with the position, so the identity of
 * an aircraft needs no lookup at all.
 */

import { wrapHeading, wrapLongitude } from '@/core/math/geo';
import {
  emergencyOrNull,
  feedClockToMs,
  num,
  str,
  usableFeedClock,
  validPosition,
} from './coerce';

// Re-exported: these are part of the normalisation contract, and callers
// (including the tests) should not have to know which file they live in.
export { feedClockToMs, usableFeedClock } from './coerce';
import type { AircraftState, ProviderId } from '@/data/types';

/** One entry of a readsb-style `ac` array. Everything is optional in practice. */
interface ReadsbAircraft {
  hex?: string;
  type?: string;
  flight?: string;
  r?: string;
  t?: string;
  alt_baro?: number | 'ground';
  alt_geom?: number;
  gs?: number;
  track?: number;
  true_heading?: number;
  mag_heading?: number;
  baro_rate?: number;
  geom_rate?: number;
  squawk?: string;
  emergency?: string;
  category?: string;
  nav_qnh?: number;
  nav_altitude_mcp?: number;
  nav_heading?: number;
  lat?: number;
  lon?: number;
  seen_pos?: number;
  seen?: number;
  rssi?: number;
  dst?: number;
  ground_speed?: number;
  ias?: number;
  tas?: number;
  mach?: number;
  roll?: number;
  track_rate?: number;
  wd?: number;
  ws?: number;
  oat?: number;
  tat?: number;
  nav_modes?: string[];
  nav_altitude_fms?: number;
  mlat?: unknown[];
  tisb?: unknown[];
}

export interface ReadsbResponse {
  ac?: ReadsbAircraft[] | null;
  aircraft?: ReadsbAircraft[] | null;
  now?: number;
  total?: number;
  msg?: string;
}

/** Registration and type ride along with the position on readsb feeds. */
export interface InlineAirframeHint {
  hex: string;
  registration: string | null;
  typeCode: string | null;
}

/**
 * Normalise one readsb record. Returns null for records without a usable
 * position — the feeds include aircraft heard on the radio but not yet located.
 */
function normalizeReadsbAircraft(
  raw: ReadsbAircraft,
  source: ProviderId,
  receivedAt: number,
  feedNow: number | null,
): { state: AircraftState; hint: InlineAirframeHint } | null {
  const hex = str(raw.hex)?.toLowerCase().replace(/^~/, '');
  if (!hex) return null;

  const lat = num(raw.lat);
  const lon = num(raw.lon);
  if (!validPosition(lat, lon)) return null;

  const onGround = raw.alt_baro === 'ground';
  const altBaroFt = onGround ? 0 : num(raw.alt_baro);
  const seenPosSec = num(raw.seen_pos) ?? num(raw.seen);

  // Prefer the feed's own clock: it removes our network latency from the age.
  const base = feedNow ?? receivedAt;
  const fixTime = seenPosSec !== null ? base - seenPosSec * 1000 : base;

  const track = num(raw.track);
  const heading = num(raw.true_heading) ?? num(raw.mag_heading);

  const windDir = num(raw.wd);

  const state: AircraftState = {
    hex,
    callsign: str(raw.flight),
    lat: lat as number,
    lon: wrapLongitude(lon as number),
    altBaroFt,
    altGeomFt: num(raw.alt_geom),
    groundSpeedKt: num(raw.gs) ?? num(raw.ground_speed),
    trackDeg: track === null ? null : wrapHeading(track),
    headingDeg: heading === null ? null : wrapHeading(heading),
    baroRateFpm: num(raw.baro_rate),
    geomRateFpm: num(raw.geom_rate),
    squawk: str(raw.squawk),
    category: str(raw.category),
    emergency: emergencyOrNull(raw.emergency),
    onGround,
    navAltitudeMcpFt: num(raw.nav_altitude_mcp),
    navHeadingDeg: num(raw.nav_heading),
    navQnhHpa: num(raw.nav_qnh),
    iasKt: num(raw.ias),
    tasKt: num(raw.tas),
    mach: num(raw.mach),
    rollDeg: num(raw.roll),
    trackRateDegSec: num(raw.track_rate),
    windDirectionDeg: windDir === null ? null : wrapHeading(windDir),
    windSpeedKt: num(raw.ws),
    oatC: num(raw.oat),
    tatC: num(raw.tat),
    navModes: Array.isArray(raw.nav_modes) ? raw.nav_modes.filter((m): m is string => typeof m === 'string') : null,
    navAltitudeFmsFt: num(raw.nav_altitude_fms),
    // Non-empty arrays list which fields arrived that way; presence is the signal.
    isMlat: Array.isArray(raw.mlat) && raw.mlat.length > 0,
    isTisb: Array.isArray(raw.tisb) && raw.tisb.length > 0,
    seenPosSec,
    rssi: num(raw.rssi),
    receiverDistanceNm: num(raw.dst),
    source,
    observedAt: receivedAt,
    fixTime,
  };

  return {
    state,
    hint: { hex, registration: str(raw.r), typeCode: str(raw.t) },
  };
}

export function normalizeReadsbResponse(
  body: ReadsbResponse,
  source: ProviderId,
  receivedAt: number,
): { states: AircraftState[]; hints: InlineAirframeHint[] } {
  // readsb answers under `ac`; some forks spell it `aircraft`.
  const list = body.ac ?? body.aircraft ?? [];
  const feedNow = usableFeedClock(feedClockToMs(body.now), receivedAt);
  const states: AircraftState[] = [];
  const hints: InlineAirframeHint[] = [];

  for (const raw of list) {
    const n = normalizeReadsbAircraft(raw, source, receivedAt, feedNow);
    if (!n) continue;
    states.push(n.state);
    if (n.hint.registration || n.hint.typeCode) hints.push(n.hint);
  }

  return { states, hints };
}
