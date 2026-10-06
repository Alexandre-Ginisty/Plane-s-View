/**
 * Aerodrome weather: the METAR at each end of the flight.
 *
 * From the Aviation Weather Center (NOAA), whose data is US government work
 * and in the public domain, through the relay (it sends no CORS header). One
 * request covers both ends — the service takes a list of aerodromes — and a
 * report is kept for five minutes: a METAR is issued every half hour, so
 * asking more often only spends someone else's bandwidth.
 *
 * What is shown is what a pilot reads first: the flight category (VFR, MVFR,
 * IFR, LIFR, the colour code every briefing uses), the wind, the visibility,
 * the lowest ceiling, temperature and dew point, and the QNH — and the raw
 * report, which an enthusiast will want to read for themselves.
 */

import { relayUrl } from '@/data/endpoints';
import { HttpError, fetchJson } from '@/data/http';

type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR';

export interface Metar {
  icao: string;
  /** The report as issued. */
  raw: string;
  /** Observation time, ms since the epoch. */
  observedAt: number | null;
  tempC: number | null;
  dewC: number | null;
  /** Degrees true; null when variable or calm. */
  windDirDeg: number | null;
  windVariable: boolean;
  windKt: number | null;
  gustKt: number | null;
  /** As reported: statute miles, "6+" for unlimited. */
  visibility: string | null;
  /** hPa. */
  qnhHpa: number | null;
  /** The lowest broken or overcast layer, feet above the aerodrome; null when none. */
  ceilingFt: number | null;
  /** CAVOK, FEW, SCT…: the most significant layer's cover. */
  cover: string | null;
  category: FlightCategory | null;
}

const FRESH_MS = 5 * 60_000;
const ICAO = /^[A-Z0-9]{4}$/;

interface AwcLayer {
  cover?: unknown;
  base?: unknown;
}
interface AwcMetar {
  icaoId?: unknown;
  rawOb?: unknown;
  obsTime?: unknown;
  temp?: unknown;
  dewp?: unknown;
  wdir?: unknown;
  wspd?: unknown;
  wgst?: unknown;
  visib?: unknown;
  altim?: unknown;
  clouds?: unknown;
  cover?: unknown;
  fltCat?: unknown;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** One report from the service's JSON, or null when it is not one. */
export function parseMetar(row: unknown): Metar | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as AwcMetar;
  const icao = str(r.icaoId)?.toUpperCase();
  const raw = str(r.rawOb);
  if (!icao || !ICAO.test(icao) || !raw) return null;

  const layers = Array.isArray(r.clouds) ? (r.clouds as AwcLayer[]) : [];
  let ceilingFt: number | null = null;
  for (const layer of layers) {
    const cover = str(layer.cover);
    const base = num(layer.base);
    if ((cover === 'BKN' || cover === 'OVC' || cover === 'OVX') && base !== null) {
      ceilingFt = ceilingFt === null ? base : Math.min(ceilingFt, base);
    }
  }

  const obs = num(r.obsTime);
  const cat = str(r.fltCat);
  const visib = r.visib;
  return {
    icao,
    raw,
    observedAt: obs === null ? null : obs * 1000,
    tempC: num(r.temp),
    dewC: num(r.dewp),
    windDirDeg: num(r.wdir),
    windVariable: r.wdir === 'VRB',
    windKt: num(r.wspd),
    gustKt: num(r.wgst),
    visibility: typeof visib === 'number' ? String(visib) : str(visib),
    qnhHpa: num(r.altim),
    ceilingFt,
    cover: str(r.cover),
    category: cat === 'VFR' || cat === 'MVFR' || cat === 'IFR' || cat === 'LIFR' ? cat : null,
  };
}

/** The sky in a word, for someone who does not read METARs. */
export type Sky =
  | 'storm'
  | 'snow'
  | 'rain'
  | 'fog'
  | 'haze'
  | 'clear'
  | 'mostlyClear'
  | 'partlyCloudy'
  | 'cloudy'
  | 'overcast';

/**
 * What the weather looks like, from the report: the weather groups first
 * (rain, fog… are what anyone would say before the clouds), then the cover.
 * Recent weather (`RERA`) and weather in the vicinity (`VCSH`) are not the
 * weather at the field, and are skipped.
 */
export function skyOf(m: Metar): Sky | null {
  // The present-weather groups sit between the visibility and the clouds; any token of
  // intensity, descriptor and phenomenon codes will do.
  const groups = m.raw
    .split(/\s+/)
    .filter((w) => /^[-+]?(?:MI|BC|PR|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+$/.test(w) || /^[-+]?TS$/.test(w));
  const has = (code: string): boolean => groups.some((g) => g.includes(code));
  if (has('TS')) return 'storm';
  if (has('SN') || has('SG') || has('PL')) return 'snow';
  if (has('RA') || has('DZ') || has('GR') || has('GS') || has('UP')) return 'rain';
  if (has('FG')) return 'fog';
  if (has('BR') || has('HZ') || has('FU') || has('DU') || has('SA')) return 'haze';
  switch (m.cover) {
    case 'CAVOK':
    case 'SKC':
    case 'CLR':
    case 'NSC':
    case 'NCD':
      return 'clear';
    case 'FEW':
      return 'mostlyClear';
    case 'SCT':
      return 'partlyCloudy';
    case 'BKN':
      return 'cloudy';
    case 'OVC':
    case 'OVX':
      return 'overcast';
    default:
      return null;
  }
}

const cache = new Map<string, { at: number; metar: Metar | null }>();
const inFlight = new Map<string, Promise<void>>();

/**
 * The latest METAR for each aerodrome asked for that has one. Never throws:
 * weather is a garnish on the dossier, and a failure leaves it off.
 */
export async function fetchMetars(icaos: readonly (string | null | undefined)[]): Promise<Map<string, Metar>> {
  const now = Date.now();
  const wanted = [...new Set(icaos.filter((c): c is string => !!c).map((c) => c.toUpperCase()))].filter((c) => ICAO.test(c));
  const stale = wanted.filter((c) => {
    const hit = cache.get(c);
    return (!hit || now - hit.at > FRESH_MS) && !inFlight.has(c);
  });

  if (stale.length > 0) {
    const request = (async () => {
      try {
        const params = new URLSearchParams({ ids: stale.slice(0, 4).join(','), format: 'json' });
        // No report for any of them is an empty 204, not an error.
        const body = await fetchJson<unknown>(relayUrl('awc', `/api/data/metar?${params}`), { timeoutMs: 8000, retries: 0 }).catch((err: unknown) => {
          if (err instanceof HttpError && err.status === 204) return [];
          throw err;
        });
        const rows = Array.isArray(body) ? body : [];
        const found = new Map<string, Metar>();
        for (const row of rows) {
          const metar = parseMetar(row);
          // The newest report per aerodrome: the service can return several.
          if (metar && (found.get(metar.icao)?.observedAt ?? -Infinity) < (metar.observedAt ?? 0)) found.set(metar.icao, metar);
        }
        // An aerodrome that issues no METAR is remembered as having none, so it is not asked again at once.
        for (const icao of stale) cache.set(icao, { at: Date.now(), metar: found.get(icao) ?? null });
      } catch {
        // Unreachable: asked again after the freshness window, not in a loop.
        for (const icao of stale) cache.set(icao, { at: Date.now() - FRESH_MS + 60_000, metar: cache.get(icao)?.metar ?? null });
      }
    })();
    for (const icao of stale) inFlight.set(icao, request);
    try {
      await request;
    } finally {
      for (const icao of stale) inFlight.delete(icao);
    }
  }
  await Promise.all(wanted.map((c) => inFlight.get(c)));

  const out = new Map<string, Metar>();
  for (const icao of wanted) {
    const metar = cache.get(icao)?.metar;
    if (metar) out.set(icao, metar);
  }
  return out;
}
