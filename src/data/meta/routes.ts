/**
 * Flight routes and airline names, from files shipped with the app.
 *
 * `public/routes` is built by `tools/routes/build-routes.mjs` from the CC0
 * Virtual Radar Server standing data. A lookup is one static file per airline
 * (`/routes/AFR.json`), fetched on demand and cached by the browser, so there
 * is no third party in the path and nothing to rate-limit.
 */

import { fetchJson, HttpError } from '@/data/http';
import type { Airline, Airport, FlightRoute } from '@/data/types';

/** `[IATA, name, municipality, country, lat, lon, elevationFt]` */
type AirportRow = readonly [string, string, string, string, number, number, number];

const base = (): string => new URL('routes/', new URL(import.meta.env.BASE_URL ?? '/', window.location.href)).toString();

const fileCache = new Map<string, Promise<unknown | null>>();

/** Fetch a static data file once; a missing file is `null`, not an error. */
function load<T>(name: string, signal?: AbortSignal): Promise<T | null> {
  let p = fileCache.get(name) as Promise<T | null> | undefined;
  if (!p) {
    p = fetchJson<T>(`${base()}${name}.json`, { timeoutMs: 10_000, retries: 1, signal }).catch((err: unknown) => {
      // Forgotten, so a transient failure is retried by the next lookup. A 404
      // is a real answer (that airline has no routes) and is kept.
      if (!(err instanceof HttpError && err.status === 404)) fileCache.delete(name);
      return null;
    });
    fileCache.set(name, p);
  }
  return p;
}

/**
 * The airline code and flight number of a callsign, normalised as the data is:
 * `AFR0012` is `AFR` and `12`. Null for anything that is not an airline's
 * three-letter code followed by a number (registrations, military callsigns).
 */
export function parseCallsign(callsign: string): { airline: string; number: string } | null {
  const m = /^([A-Z]{3})(\d[A-Z0-9]{0,5})$/.exec(callsign.trim().toUpperCase());
  if (!m) return null;
  let number = m[2]!.replace(/^0+/, '');
  if (number === '' || /^[A-Z]+$/.test(number)) number = `0${number}`;
  return { airline: m[1]!, number };
}

const s = (v: string | undefined): string | null => (v ? v : null);

function toAirport(row: AirportRow | undefined, code: string): Airport {
  if (!row) {
    return { iata: null, icao: code.length === 4 ? code : null, name: null, municipality: null, countryIso: null, lat: null, lon: null, elevationFt: null };
  }
  return {
    iata: s(row[0]),
    icao: code.length === 4 ? code : null,
    name: s(row[1]),
    municipality: s(row[2]),
    countryIso: s(row[3]),
    lat: row[4],
    lon: row[5],
    elevationFt: row[6],
  };
}

/** The airline behind a callsign, whether or not its flights have a route. */
export async function lookupAirline(callsign: string, signal?: AbortSignal): Promise<Airline | null> {
  const parsed = parseCallsign(callsign);
  if (!parsed) return null;
  const airlines = await load<Record<string, [string, string]>>('airlines', signal);
  const row = airlines?.[parsed.airline];
  if (!row) return null;
  return { name: row[0], icao: parsed.airline, iata: s(row[1]), country: null, countryIso: null, radioCallsign: null };
}

export async function fetchRoute(callsign: string, signal?: AbortSignal): Promise<FlightRoute | null> {
  const parsed = parseCallsign(callsign);
  if (!parsed) return null;

  const flights = await load<Record<string, string>>(parsed.airline, signal);
  const stops = flights?.[parsed.number]?.split('-');
  if (!stops || stops.length < 2) return null;

  const [airports, airline] = await Promise.all([
    load<Record<string, AirportRow>>('airports', signal),
    lookupAirline(callsign, signal),
  ]);
  const at = (code: string): Airport => toAirport(airports?.[code], code);

  return {
    callsign: callsign.trim().toUpperCase(),
    callsignIata: null,
    airline,
    origin: at(stops[0]!),
    destination: at(stops[stops.length - 1]!),
    // A three-airport entry is a flight with a stop; longer ones are
    // rotations whose current leg cannot be told from the callsign.
    midpoint: stops.length === 3 ? at(stops[1]!) : null,
  };
}
