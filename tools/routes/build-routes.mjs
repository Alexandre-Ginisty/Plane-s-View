#!/usr/bin/env node
/**
 * Flight routes, airlines and airports, as static files the app serves itself.
 *
 *   node tools/routes/build-routes.mjs /path/to/standing-data
 *
 * Source: the Virtual Radar Server standing data,
 * https://github.com/vradarserver/standing-data — released under CC0 1.0, so it
 * may be copied, changed and shipped in a commercial product with no credit
 * owed (it is given anyway, in `public/routes/CREDITS.md`).
 *
 * This replaces the adsbdb lookup. adsbdb republishes the same kind of data
 * but states that its route data "may not be copied, published, or
 * incorporated into other databases" without its author's permission, which a
 * product that caches responses for its visitors cannot honour. Shipping a CC0
 * snapshot also means a route lookup is one static file: no third party in the
 * request path, nothing to rate-limit, nothing that can go down.
 *
 * Output, in `public/routes/`:
 *   airlines.json   { ICAO: [name, IATA] }
 *   airports.json   { code: [IATA, name, municipality, country, lat, lon, elevationFt] }
 *   <ICAO>.json     { flightNumber: "KJFK-EPWA" }   one file per airline
 *
 * A callsign is the airline's ICAO code and the flight number
 * (`AFR1` = Air France 1), normalised exactly as VRS does it: leading zeros
 * dropped from the number. Airports are keyed by the code the routes use.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/routes/build-routes.mjs <standing-data checkout>');
  process.exit(1);
}
const out = fileURLToPath(new URL('../../public/routes/', import.meta.url));

/** Minimal CSV: the VRS files quote fields with commas and start with a BOM. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const csvFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.csv'))
    .map((e) => join(e.parentPath ?? e.path, e.name));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// --- Routes ---------------------------------------------------------------
const byAirline = new Map();
const usedAirports = new Set();
let routes = 0;
for (const file of csvFiles(join(src, 'routes/schema-01'))) {
  for (const r of parseCsv(readFileSync(file, 'utf8'))) {
    const code = r.AirlineCode || r.Code;
    if (!/^[A-Z]{3}$/.test(code) || !r.Number || !r.AirportCodes) continue;
    let flights = byAirline.get(code);
    if (!flights) byAirline.set(code, (flights = {}));
    flights[r.Number] = r.AirportCodes;
    for (const a of r.AirportCodes.split('-')) usedAirports.add(a);
    routes++;
  }
}
for (const [code, flights] of byAirline) writeFileSync(join(out, `${code}.json`), JSON.stringify(flights));

// --- Airlines -------------------------------------------------------------
const airlines = {};
for (const file of csvFiles(join(src, 'airlines/schema-01'))) {
  for (const r of parseCsv(readFileSync(file, 'utf8'))) {
    if (/^[A-Z]{3}$/.test(r.ICAO) && r.Name) airlines[r.ICAO] = [r.Name, r.IATA || ''];
  }
}
writeFileSync(join(out, 'airlines.json'), JSON.stringify(airlines));

// --- Airports (only those a route mentions) ---------------------------------
const airports = {};
for (const file of csvFiles(join(src, 'airports/schema-01'))) {
  for (const r of parseCsv(readFileSync(file, 'utf8'))) {
    for (const key of new Set([r.Code, r.ICAO])) {
      if (!key || !usedAirports.has(key) || airports[key]) continue;
      airports[key] = [
        r.IATA || '',
        r.Name,
        r.Location,
        r.CountryISO2,
        Math.round(Number(r.Latitude) * 1e4) / 1e4,
        Math.round(Number(r.Longitude) * 1e4) / 1e4,
        Number(r.AltitudeFeet) || 0,
      ];
    }
  }
}
writeFileSync(join(out, 'airports.json'), JSON.stringify(airports));

const missing = [...usedAirports].filter((a) => !airports[a]);
const commit = execFileSync('git', ['-C', src, 'log', '-1', '--format=%H %cs'], { encoding: 'utf8' }).trim();
writeFileSync(
  join(out, 'CREDITS.md'),
  `# Flight routes

Built by \`tools/routes/build-routes.mjs\` from the Virtual Radar Server
standing data — <https://github.com/vradarserver/standing-data> — at commit
\`${commit}\`.

The data is released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/),
a public-domain dedication: no licence conditions apply. The routes were
submitted by the Virtual Radar Server community; thank you to them.

- \`<ICAO>.json\` — flight number to airport sequence, per airline
- \`airlines.json\` — airline names
- \`airports.json\` — airports the routes mention
`,
);

console.log(`${routes} routes in ${byAirline.size} airlines, ${Object.keys(airlines).length} airline names, ${Object.keys(airports).length} airports`);
if (missing.length) console.log(`${missing.length} route airports have no airport record (e.g. ${missing.slice(0, 5).join(', ')})`);
