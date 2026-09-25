/**
 * Provider payload -> `AircraftState`.
 *
 * Two wire formats cover all four providers:
 *
 *  - **readsb / tar1090 JSON** (adsb.lol v2, airplanes.live v2, adsb.fi v2):
 *    `{ ac: [...] }`, one object per aircraft, aviation units.
 *  - **OpenSky "state vector"**: `{ states: [[...]] }`, positional arrays, SI
 *    units, with `null` in most slots most of the time.
 *
 * Note on two fields the project brief described differently: in the real
 * readsb schema `r` is the **registration** and `t` is the **type code** (not
 * receiver distance and timestamp). Distance to the receiver is `dst`, and the
 * timestamp is the top-level `now`. Mapping them correctly means the
 * registration and airframe type arrive with the position, so the common case
 * needs no adsbdb round-trip at all.
 */

import {
  FEET_TO_METRES,
  MPS_TO_KNOTS,
  wrapHeading,
  wrapLongitude,
} from '@/core/math/geo';
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
  // adsb.lol answers under `ac`, adsb.fi under `aircraft`.
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

// ---------------------------------------------------------------------------
// OpenSky
// ---------------------------------------------------------------------------

/**
 * OpenSky state vector, by index:
 * 0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
 * 5 longitude, 6 latitude, 7 baro_altitude(m), 8 on_ground, 9 velocity(m/s),
 * 10 true_track, 11 vertical_rate(m/s), 12 sensors, 13 geo_altitude(m),
 * 14 squawk, 15 spi, 16 position_source, 17 category (optional).
 */
type OpenSkyStateVector = readonly unknown[];

export interface OpenSkyResponse {
  time?: number;
  states?: OpenSkyStateVector[] | null;
}

/** OpenSky reports categories as an integer; this is the ADS-B mapping. */
const OPENSKY_CATEGORY: readonly (string | null)[] = [
  null, // 0 = no information
  'A0', // 1 = no ADS-B emitter category information
  'A1', // light
  'A2', // small
  'A3', // large
  'A4', // high-vortex large
  'A5', // heavy
  'A6', // high performance
  'A7', // rotorcraft
  'B1', // glider
  'B2', // lighter-than-air
  'B3', // parachutist
  'B4', // ultralight
  null, // 13 reserved
  'B6', // UAV
  'B7', // space vehicle
  'C1', // surface emergency vehicle
  'C2', // surface service vehicle
  'C3', // point obstacle
];

function normalizeOpenSkyState(
  v: OpenSkyStateVector,
  receivedAt: number,
  feedTimeSec: number | null,
): AircraftState | null {
  const hex = str(v[0])?.toLowerCase();
  if (!hex) return null;

  const lon = num(v[5]);
  const lat = num(v[6]);
  if (!validPosition(lat, lon)) return null;

  const timePosition = num(v[3]);
  const onGround = v[8] === true;
  const baroAltM = num(v[7]);
  const geoAltM = num(v[13]);
  const velocityMs = num(v[9]);
  const verticalMs = num(v[11]);
  const track = num(v[10]);
  const categoryIdx = num(v[17]);

  const fixTime = timePosition !== null ? timePosition * 1000 : receivedAt;
  const feedNowMs = feedTimeSec !== null ? feedTimeSec * 1000 : receivedAt;

  return {
    hex,
    callsign: str(v[1]),
    lat: lat as number,
    lon: wrapLongitude(lon as number),
    altBaroFt: onGround ? 0 : baroAltM === null ? null : baroAltM / FEET_TO_METRES,
    altGeomFt: geoAltM === null ? null : geoAltM / FEET_TO_METRES,
    groundSpeedKt: velocityMs === null ? null : velocityMs * MPS_TO_KNOTS,
    trackDeg: track === null ? null : wrapHeading(track),
    headingDeg: null,
    // OpenSky reports m/s; the rest of the app speaks ft/min.
    baroRateFpm: verticalMs === null ? null : (verticalMs / FEET_TO_METRES) * 60,
    geomRateFpm: null,
    squawk: str(v[14]),
    category:
      categoryIdx !== null && categoryIdx >= 0 && categoryIdx < OPENSKY_CATEGORY.length
        ? OPENSKY_CATEGORY[categoryIdx] ?? null
        : null,
    emergency: null,
    onGround,
    navAltitudeMcpFt: null,
    navHeadingDeg: null,
    navQnhHpa: null,
    // OpenSky's state vector carries no flight-dynamics fields at all.
    iasKt: null,
    tasKt: null,
    mach: null,
    rollDeg: null,
    trackRateDegSec: null,
    windDirectionDeg: null,
    windSpeedKt: null,
    oatC: null,
    tatC: null,
    navModes: null,
    navAltitudeFmsFt: null,
    isMlat: false,
    isTisb: false,
    seenPosSec: timePosition !== null ? Math.max(0, (feedNowMs - fixTime) / 1000) : null,
    rssi: null,
    receiverDistanceNm: null,
    source: 'opensky',
    observedAt: receivedAt,
    fixTime,
  };
}

export function normalizeOpenSkyResponse(
  body: OpenSkyResponse,
  receivedAt: number,
): AircraftState[] {
  const out: AircraftState[] = [];
  // OpenSky documents `time` in seconds, but run it through the same guard so
  // a format change cannot silently empty the map.
  const normalised = usableFeedClock(feedClockToMs(body.time), receivedAt);
  const feedTime = normalised === null ? null : normalised / 1000;
  for (const v of body.states ?? []) {
    const s = normalizeOpenSkyState(v, receivedAt, feedTime);
    if (s) out.push(s);
  }
  return out;
}

/** Exported for tests: the units guard that keeps the fleet from vanishing. */
