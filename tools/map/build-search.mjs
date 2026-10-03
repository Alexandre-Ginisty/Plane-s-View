#!/usr/bin/env node
/**
 * Build the place search index into `public/map/search-*.json`.
 *
 *   node tools/map/build-search.mjs <download-dir>
 *
 * <download-dir> must hold, unmodified:
 *   cities1000.txt   GeoNames (CC BY 4.0) — download.geonames.org/export/dump/cities1000.zip
 *   airports.csv     OurAirports (public domain) — davidmegginson.github.io/ourairports-data/airports.csv
 *
 * Searched in the browser, offline: no geocoding service is called, so there
 * is no key, no quota, no terms of use to keep to and nothing a user types
 * leaves the page. Every place of 2,000 people or more, the big cities also
 * under their other names (Londres, Mailand, Pékin), and the airports with a
 * code, under the code as well as the name.
 *
 * Two files: `search-major.json` (cities of 20,000 or more and the airports,
 * a couple of hundred kilobytes, loaded when the search box is first used)
 * and `search-towns.json` (the rest, loaded behind it).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/map/build-search.mjs <download-dir>');
  process.exit(1);
}
const out = fileURLToPath(new URL('../../public/map/', import.meta.url));
/** Places this big go in the first file. */
const MAJOR_POP = 20_000;

const r = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Latin script only: the search box is typed on a Latin keyboard. */
const latin = (s) => /^[\p{Script=Latin}\p{N}\s'’.\-()]+$/u.test(s);

// --- Places (GeoNames) ------------------------------------------------------

/** Alternative names only for cities this big: the rest are known by one. */
const ALT_FROM = 100_000;
const MAX_ALTS = 10;
/** Smaller places would double the file for villages nobody flies over to look at. */
const MIN_POP = 2000;

const places = [];
for (const line of readFileSync(join(src, 'cities1000.txt'), 'utf8').split('\n')) {
  const c = line.split('\t');
  if (c.length < 15) continue;
  const [, name, ascii, alternates, lat, lon, , , country] = c;
  const pop = Number(c[14]) || 0;
  if (pop < MIN_POP) continue;
  let alts = '';
  if (pop >= ALT_FROM && alternates) {
    const seen = new Set([fold(name), fold(ascii)]);
    const keep = [];
    for (const a of alternates.split(',')) {
      // Codes and links live in the same column; skip them.
      if (a.length < 3 || a.length > 40 || /^[A-Z]{3,4}$/.test(a) || a.includes('http') || !latin(a)) continue;
      const f = fold(a);
      if (seen.has(f)) continue;
      seen.add(f);
      keep.push(a);
      if (keep.length >= MAX_ALTS) break;
    }
    alts = keep.join('|');
  }
  // A kilometre is close enough to fly the map to.
  places.push([name, alts, country, r(Number(lon), 2), r(Number(lat), 2), pop]);
}
places.sort((a, b) => b[5] - a[5]);

// --- Airports (OurAirports) -------------------------------------------------

/** One CSV line into fields: quoted fields may hold commas. */
function csv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') out.push(cur), (cur = '');
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const SIZE = { large_airport: 0, medium_airport: 1, small_airport: 2 };
const lines = readFileSync(join(src, 'airports.csv'), 'utf8').split('\n');
const head = csv(lines[0]);
const col = (n) => head.indexOf(n);
const [cType, cName, cLat, cLon, cCountry, cCity, cIcao, cIata, cGps] = [
  'type', 'name', 'latitude_deg', 'longitude_deg', 'iso_country', 'municipality', 'icao_code', 'iata_code', 'gps_code',
].map(col);
const airports = [];
for (const line of lines.slice(1)) {
  if (!line) continue;
  const f = csv(line);
  const size = SIZE[f[cType]];
  if (size === undefined) continue;
  const iata = f[cIata] || '';
  const icao = f[cIcao] || f[cGps] || '';
  // The small fields with neither code are not what anyone searches for by name.
  if (size === 2 && !iata) continue;
  if (!iata && !/^[A-Z]{4}$/.test(icao)) continue;
  airports.push([f[cName], iata, icao, f[cCountry], r(Number(f[cLon]), 3), r(Number(f[cLat]), 3), f[cCity] || '', size]);
}
airports.sort((a, b) => a[7] - b[7]);

const major = places.filter((p) => p[5] >= MAJOR_POP);
const towns = places.filter((p) => p[5] < MAJOR_POP);
writeFileSync(join(out, 'search-major.json'), JSON.stringify({ places: major, airports }));
writeFileSync(join(out, 'search-towns.json'), JSON.stringify({ places: towns, airports: [] }));
console.log(`${major.length} + ${towns.length} places, ${airports.length} airports → ${out}`);
