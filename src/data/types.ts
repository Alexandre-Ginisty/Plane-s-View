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

export type ProviderId = 'adsb.lol' | 'airplanes.live' | 'adsb.fi' | 'opensky';

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
  // on older equipment and on every OpenSky record, hence all nullable.
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

/** Static airframe metadata, from adsbdb / OpenSky. */
export interface AircraftMeta {
  hex: string;
  registration: string | null;
  typeCode: string | null;
  typeName: string | null;
  manufacturer: string | null;
  owner: string | null;
  registeredCountry: string | null;
  registeredCountryIso: string | null;
  /** ICAO type designator, e.g. "B738". */
  icaoTypeCode: string | null;
  /** Operator flag code, useful for picking an airline livery colour. */
  operatorFlagCode: string | null;
  /** Fallback photo bundled with the airframe record. */
  photoUrl: string | null;
  photoThumbnailUrl: string | null;
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
  /** Intermediate stop on multi-leg callsigns, when adsbdb reports one. */
  midpoint: Airport | null;
}

export interface AircraftPhoto {
  thumbnailUrl: string;
  largeUrl: string;
  photographer: string | null;
  /** Link back to the photo page — required by the Planespotters terms. */
  link: string | null;
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
  pressureMslHpa: number | null;
  visibilityM: number | null;
  isDay: boolean | null;
  observedAt: number;
}
