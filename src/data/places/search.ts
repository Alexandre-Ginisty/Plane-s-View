/**
 * Finding a place on Earth by name: a city, a town, an airport.
 *
 * Offline, from an index built by `tools/map/build-search.mjs` out of GeoNames
 * (CC BY 4.0) and OurAirports (public domain): nothing typed leaves the page,
 * and there is no geocoding service with a key, a quota or terms to keep to.
 *
 * Ranked the way people mean a name: the whole name before the start of it,
 * the start of it before the start of a later word, and between equals the
 * bigger place — "Paris" is the French capital, not Paris, Texas — with an
 * airport's code (CDG, LFPG) beating everything.
 */

export interface PlaceResult {
  kind: 'place' | 'airport';
  name: string;
  /** Under the name: the country, or the airport's city and codes. */
  detail: string;
  lat: number;
  lon: number;
  /** How far in the map should go to show it, MapLibre zoom. */
  zoom: number;
}

type PlaceRow = [name: string, alts: string, country: string, lon: number, lat: number, pop: number];
type AirportRow = [name: string, iata: string, icao: string, country: string, lon: number, lat: number, city: string, size: number];

interface Entry {
  /** Folded names it answers to, the first its own. */
  keys: string[];
  /** Codes, upper case (airports). */
  codes: string[];
  weight: number;
  result: () => PlaceResult;
}

const BASE = import.meta.env.BASE_URL ?? '/';

export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

let regionNames: Intl.DisplayNames | null = null;
function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames([navigator.language || 'en', 'en'], { type: 'region' });
    return (code && regionNames.of(code)) || code;
  } catch {
    return code;
  }
}

function placeEntry(r: PlaceRow): Entry {
  const [name, alts, country, lon, lat, pop] = r;
  return {
    keys: [fold(name), ...(alts ? alts.split('|').map(fold) : [])],
    codes: [],
    weight: Math.log10(Math.max(pop, 1000)) * 6,
    result: () => ({
      kind: 'place',
      name,
      detail: countryName(country),
      lat,
      lon,
      zoom: pop > 2_000_000 ? 9 : pop > 200_000 ? 10 : 11,
    }),
  };
}

function airportEntry(r: AirportRow): Entry {
  const [name, iata, icao, country, lon, lat, city, size] = r;
  return {
    keys: [fold(name), ...(city ? [fold(city)] : [])],
    codes: [iata, icao].filter(Boolean),
    // A city's airport ranks with the city, a little below a big city itself.
    weight: [36, 30, 18][size] ?? 18,
    result: () => ({
      kind: 'airport',
      name,
      detail: [city, countryName(country), [iata, icao].filter(Boolean).join(' / ')].filter(Boolean).join(' · '),
      lat,
      lon,
      zoom: 11,
    }),
  };
}

/** How well a folded query matches an entry, 0 for not at all. */
export function matchScore(q: string, keys: readonly string[], codes: readonly string[]): number {
  const upper = q.toUpperCase();
  if (codes.some((c) => c === upper)) return 120;
  let best = 0;
  keys.forEach((k, i) => {
    // Its own name a little ahead of its other names.
    const own = i === 0 ? 0 : -8;
    let s = 0;
    if (k === q) s = 100;
    else if (k.startsWith(q)) s = 70;
    else if (k.includes(` ${q}`) || k.includes(`-${q}`)) s = 45;
    if (s > 0) best = Math.max(best, s + own);
  });
  return best;
}

let entries: Entry[] = [];
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Called whenever more of the index has arrived, so a search box can run its query again. */
export function onPlaceIndex(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const announce = (): void => listeners.forEach((l) => l());

async function load(file: string): Promise<{ places: PlaceRow[]; airports: AirportRow[] }> {
  const res = await fetch(`${BASE}map/${file}`);
  if (!res.ok) throw new Error(`place index: ${res.status}`);
  return res.json();
}

/**
 * Load the index: the cities and airports at once, the towns behind them.
 * Safe to call repeatedly; resolves once the first part is searchable.
 */
export function preparePlaceSearch(): Promise<void> {
  loading ??= load('search-major.json').then((major) => {
    entries = [...major.airports.map(airportEntry), ...major.places.map(placeEntry)];
    announce();
    void load('search-towns.json')
      .then((towns) => {
        entries = entries.concat(towns.places.map(placeEntry));
        announce();
      })
      // The towns are a refinement; the cities still answer without them.
      .catch(() => undefined);
  });
  loading.catch(() => (loading = null));
  return loading;
}

/** The best matches for what has been typed, best first. */
export function searchPlaces(query: string, limit = 8): PlaceResult[] {
  const q = fold(query);
  if (q.length < 2) return [];
  const scored: { e: Entry; s: number }[] = [];
  for (const e of entries) {
    const m = matchScore(q, e.keys, e.codes);
    if (m > 0) scored.push({ e, s: m + e.weight });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map(({ e }) => e.result());
}
