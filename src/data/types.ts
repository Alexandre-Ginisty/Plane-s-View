/**
 * Canonical domain types.
 *
 * Every ADS-B provider has its own field names and its own idea of units.
 * Normalisers in `data/adsb/normalize.ts` funnel all of them into
 * `AircraftState`, so nothing downstream ever branches on the provider.
 *
 * Unit convention: aviation units are kept where they are the lingua franca
 * (feet, knots, feet/minute) and the field name always says which. Anything in
 * SI carries no suffix beyond the obvious.
 */

/**
 * Traffic feeds the app calls. adsb.lol is the one whose terms allow a
 * commercial product (ODbL); adsb.fi is for personal and non-commercial use,
 * which is what the site is while it is a demonstration. Two feeds because
 * adsb.lol answers 429 to more than about one request in three from one
 * address, and a relay shares one address among every visitor: with a single
 * feed the aircraft went "signal lost" all the time.
 */
export type ProviderId = 'adsb.lol' | 'adsb.fi';

/** A single decoded aircraft position report. */
export interface AircraftState {
  /** ICAO 24-bit address, lowercase hex, no prefix. The stable identity. */
  hex: string;
  /** Callsign / flight number, trimmed. Null when not transmitted. */
  callsign: string | null;

  lat: number;
  lon: number;

  /** Barometric altitude. Null if unknown; 0 with `onGround` for "ground". */
  altBaroFt: number | null;
  /** GNSS altitude, when transmitted. Preferred for terrain clearance. */
  altGeomFt: number | null;

  groundSpeedKt: number | null;
  /** True track over ground, degrees clockwise from true north. */
  trackDeg: number | null;
  /** Magnetic heading, when transmitted; differs from track in wind. */
  headingDeg: number | null;

  baroRateFpm: number | null;
  geomRateFpm: number | null;

  // --- Flight dynamics -----------------------------------------------------
  // Broadcast by ADS-B version 2 transponders (BDS 6,0 / 5,0 derived). Absent
  // on older equipment, hence all nullable.
  // These are what make the cockpit view honest instead of a guess: `rollDeg`
  // is the aircraft's *actual* bank angle, so the horizon tilts for real.

  /** Indicated airspeed, knots. */
  iasKt: number | null;
  /** True airspeed, knots. */
  tasKt: number | null;
  mach: number | null;
  /** Bank angle, degrees. Positive = right wing down. */
  rollDeg: number | null;
  /** Rate of turn, degrees per second. */
  trackRateDegSec: number | null;

  /** Wind measured by the aircraft itself — better than any forecast model. */
  windDirectionDeg: number | null;
  windSpeedKt: number | null;
  /** Outside / total air temperature, Celsius. */
  oatC: number | null;
  tatC: number | null;

  /** Autopilot engaged modes, e.g. ["autopilot", "vnav", "lnav"]. */
  navModes: string[] | null;
  navAltitudeFmsFt: number | null;

  /** Position came from multilateration, not ADS-B — noticeably less precise. */
  isMlat: boolean;
  /** Position was rebroadcast by ground radar (TIS-B). */
  isTisb: boolean;

  squawk: string | null;
  /** ADS-B emitter category, e.g. "A3" for a medium airliner. */
  category: string | null;
  emergency: string | null;

  onGround: boolean;

  /** Selected altitude from the autopilot, when broadcast. */
  navAltitudeMcpFt: number | null;
  navHeadingDeg: number | null;
  navQnhHpa: number | null;

  /** Seconds since the position was last updated, as reported by the feed. */
  seenPosSec: number | null;
  /** Signal strength in dBFS, receiver-network feeds only. */
  rssi: number | null;
  /** Distance to the reporting receiver, nautical miles. */
  receiverDistanceNm: number | null;

  /** Which feed this came from. */
  source: ProviderId;
  /** Epoch ms at which *we* received the report. */
  observedAt: number;
  /** Best estimate of the epoch ms the fix itself was taken. */
  fixTime: number;
}

/** What is known of one airframe: what the feed sent, and the airline from the callsign. */
export interface AircraftMeta {
  hex: string;
  registration: string | null;
  /** ICAO type designator, e.g. "B738". */
  icaoTypeCode: string | null;
  /** The model's name, e.g. "Boeing 737-800", where the type table knows it. */
  typeName: string | null;
  /** The airline flying it now, from the callsign. */
  owner: string | null;
}

export interface Airport {
  iata: string | null;
  icao: string | null;
  name: string | null;
  municipality: string | null;
  countryIso: string | null;
  lat: number | null;
  lon: number | null;
  elevationFt: number | null;
}

export interface Airline {
  name: string | null;
  icao: string | null;
  iata: string | null;
  country: string | null;
  countryIso: string | null;
  /** Radio callsign, e.g. "RYANAIR". */
  radioCallsign: string | null;
}

/** Flight route resolved from a callsign. */
export interface FlightRoute {
  callsign: string;
  callsignIata: string | null;
  airline: Airline | null;
  origin: Airport | null;
  destination: Airport | null;
  /** Intermediate stop on a flight with exactly one, when the route says so. */
  midpoint: Airport | null;
}

/** A photograph free to reuse commercially, with the credit its licence asks for. */
export interface AircraftPhoto {
  thumbnailUrl: string;
  largeUrl: string;
  photographer: string | null;
  /** Licence short name, e.g. "CC BY-SA 2.0". Shown with every photograph. */
  license: string;
  /** The file's page on Wikimedia Commons: author, licence text, original. */
  link: string;
}

/** Everything the detail panel shows for one aircraft. */
export interface AircraftDossier {
  hex: string;
  meta: AircraftMeta | null;
  route: FlightRoute | null;
  photo: AircraftPhoto | null;
  /** Non-fatal problems while assembling, shown as a subtle note. */
  warnings: string[];
}

/** Geographic query window for the traffic feed. */
export interface TrafficQuery {
  lat: number;
  lon: number;
  /** Search radius in nautical miles. Providers cap this (usually 250). */
  radiusNm: number;
}

export interface TrafficSnapshot {
  aircraft: AircraftState[];
  source: ProviderId;
  /** Epoch ms when the fetch completed. */
  receivedAt: number;
  /** Wall-clock duration of the successful request, ms. */
  latencyMs: number;
}

export interface CurrentWeather {
  temperatureC: number | null;
  windSpeedMs: number | null;
  windDirectionDeg: number | null;
  /** Total cloud cover, percent. */
  cloudCoverPct: number | null;
  /** Cover by layer, percent: low (to ~2 km), mid (~2–6 km), high (above). */
  cloudLowPct: number | null;
  cloudMidPct: number | null;
  cloudHighPct: number | null;
  /** Dew point two metres up, °C: with the temperature, where the cloud base is. */
  dewPointC: number | null;
  pressureMslHpa: number | null;
  /** Estimated: the source reports fog, not visibility. */
  visibilityM: number | null;
  observedAt: number;
}

