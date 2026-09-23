/**
 * adsbdb — airframe registry and callsign -> route lookup.
 *
 * One of the few services in this stack that sends `Access-Control-Allow-Origin: *`,
 * so it is called straight from the page with no relay. Free, no key, no account.
 *
 * A 404 is a normal answer meaning "not in the database", not a failure; it is
 * reported as `null` and cached so the same miss is not re-requested.
 */

import { DIRECT } from '@/data/endpoints';
import { fetchJson, HttpError } from '@/data/http';
import type { Airline, Airport, AircraftMeta, FlightRoute } from '@/data/types';

interface AdsbdbAirport {
  country_iso_name?: string;
  country_name?: string;
  elevation?: number;
  iata_code?: string;
  icao_code?: string;
  latitude?: number;
  longitude?: number;
  municipality?: string;
  name?: string;
}

interface AdsbdbAircraftResponse {
  response?: {
    aircraft?: {
      type?: string;
      icao_type?: string;
      manufacturer?: string;
      mode_s?: string;
      registration?: string;
      registered_owner_country_iso_name?: string;
      registered_owner_country_name?: string;
      registered_owner_operator_flag_code?: string;
      registered_owner?: string;
      url_photo?: string;
      url_photo_thumbnail?: string;
    };
  } | string;
}

interface AdsbdbCallsignResponse {
  response?: {
    flightroute?: {
      callsign?: string;
      callsign_icao?: string;
      callsign_iata?: string;
      airline?: {
        name?: string;
        icao?: string;
        iata?: string;
        country?: string;
        country_iso?: string;
        callsign?: string;
      };
      origin?: AdsbdbAirport;
      destination?: AdsbdbAirport;
      midpoint?: AdsbdbAirport;
    };
  } | string;
}

const s = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

const n = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function toAirport(a: AdsbdbAirport | undefined): Airport | null {
  if (!a) return null;
  return {
    iata: s(a.iata_code),
    icao: s(a.icao_code),
    name: s(a.name),
    municipality: s(a.municipality),
    countryIso: s(a.country_iso_name),
    lat: n(a.latitude),
    lon: n(a.longitude),
    elevationFt: n(a.elevation),
  };
}

/** 404 means "not in the registry" — an answer, not an error. */
async function getOrNull<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    return await fetchJson<T>(url, { timeoutMs: 8000, retries: 1, signal });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

export async function fetchAirframe(
  hex: string,
  signal?: AbortSignal,
): Promise<AircraftMeta | null> {
  const body = await getOrNull<AdsbdbAircraftResponse>(
    `${DIRECT.adsbdb}/v0/aircraft/${encodeURIComponent(hex)}`,
    signal,
  );

  // On a miss the API answers `{"response": "unknown aircraft"}` — a string
  // where an object normally sits, so the shape must be checked.
  const r = body?.response;
  const a = typeof r === 'object' && r !== null ? r.aircraft : undefined;
  if (!a) return null;

  return {
    hex: hex.toLowerCase(),
    registration: s(a.registration),
    typeCode: s(a.icao_type),
    typeName: s(a.type),
    manufacturer: s(a.manufacturer),
    owner: s(a.registered_owner),
    registeredCountry: s(a.registered_owner_country_name),
    registeredCountryIso: s(a.registered_owner_country_iso_name),
    icaoTypeCode: s(a.icao_type),
    operatorFlagCode: s(a.registered_owner_operator_flag_code),
    photoUrl: s(a.url_photo),
    photoThumbnailUrl: s(a.url_photo_thumbnail),
  };
}

export async function fetchRoute(
  callsign: string,
  signal?: AbortSignal,
): Promise<FlightRoute | null> {
  const clean = callsign.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(clean)) return null;

  const body = await getOrNull<AdsbdbCallsignResponse>(
    `${DIRECT.adsbdb}/v0/callsign/${encodeURIComponent(clean)}`,
    signal,
  );

  const r = body?.response;
  const fr = typeof r === 'object' && r !== null ? r.flightroute : undefined;
  if (!fr) return null;

  const al = fr.airline;
  const airline: Airline | null = al
    ? {
        name: s(al.name),
        icao: s(al.icao),
        iata: s(al.iata),
        country: s(al.country),
        countryIso: s(al.country_iso),
        radioCallsign: s(al.callsign),
      }
    : null;

  return {
    callsign: s(fr.callsign_icao) ?? s(fr.callsign) ?? clean,
    callsignIata: s(fr.callsign_iata),
    airline,
    origin: toAirport(fr.origin),
    destination: toAirport(fr.destination),
    midpoint: toAirport(fr.midpoint),
  };
}
