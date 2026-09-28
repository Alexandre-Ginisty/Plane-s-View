#!/usr/bin/env node
/**
 * Build the selection map's place names and borders into `public/map/`.
 *
 *   node tools/map/build-places.mjs <download-dir>
 *
 * <download-dir> must hold, unmodified:
 *   ne_10m_populated_places_simple.geojson   Natural Earth (public domain)
 *   ne_50m_admin_0_countries.geojson         Natural Earth
 *   ne_50m_admin_0_boundary_lines_land.geojson  Natural Earth
 *   cities1000.txt                           GeoNames (CC BY 4.0)
 *
 * Natural Earth from github.com/nvkelso/natural-earth-vector/tree/master/geojson,
 * GeoNames from download.geonames.org/export/dump/cities1000.zip.
 *
 * Two tiers, because the two jobs are different. `places.json` is countries
 * and the cities Natural Earth thinks a world map should name — small enough
 * to load up front. `towns/<cx>_<cy>.json` is every other place of 1,000+
 * people, cut into square cells and fetched only when the map is zoomed into
 * one, so the detail costs nothing until someone looks for it.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/map/build-places.mjs <download-dir>');
  process.exit(1);
}
// fileURLToPath, not `.pathname`: the latter leaves a space in the checkout
// path as `%20` and writes somewhere else entirely.
const out = fileURLToPath(new URL('../../public/map/', import.meta.url));

/** Town cell size, degrees. Written into places.json so the app reads it. */
const TOWN_CELL = 3;

const geo = (f) => JSON.parse(readFileSync(join(src, f), 'utf8')).features;
const r = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// --- Tier 1: countries and major cities (Natural Earth) --------------------

const cities = geo('ne_10m_populated_places_simple.geojson')
  .map((f) => f.properties)
  .filter((p) => p.min_zoom <= 7)
  .sort((a, b) => a.min_zoom - b.min_zoom || (b.pop_max ?? 0) - (a.pop_max ?? 0))
  .map((p) => [p.name, r(p.longitude, 3), r(p.latitude, 3), p.min_zoom, p.adm0cap ? 1 : 0]);

const countries = geo('ne_50m_admin_0_countries.geojson')
  .map((f) => f.properties)
  .sort((a, b) => a.MIN_LABEL - b.MIN_LABEL)
  .map((p) => [p.NAME, r(p.LABEL_X, 2), r(p.LABEL_Y, 2), p.MIN_LABEL]);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'places.json'), JSON.stringify({ townCell: TOWN_CELL, countries, cities }));

// --- Borders ---------------------------------------------------------------

const lines = [];
for (const f of geo('ne_50m_admin_0_boundary_lines_land.geojson')) {
  const g = f.geometry;
  for (const line of g.type === 'MultiLineString' ? g.coordinates : [g.coordinates]) {
    const pts = [];
    for (const [x, y] of line) {
      const p = [r(x, 2), r(y, 2)];
      const last = pts[pts.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
    }
    if (pts.length > 1) lines.push(pts);
  }
}
writeFileSync(
  join(out, 'borders.json'),
  JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } }),
);

// --- Tier 2: towns (GeoNames), cut into cells -----------------------------

/**
 * MapLibre zoom from which a town may be named. The collision pass thins
 * further wherever the map is crowded; this only sets the earliest moment.
 */
function townZoom(pop) {
  if (pop >= 50_000) return 7;
  if (pop >= 20_000) return 8;
  if (pop >= 10_000) return 9;
  if (pop >= 5_000) return 10;
  if (pop >= 2_000) return 11;
  return 12;
}

// Tier 1 already names these; a GeoNames duplicate would only fight it for
// the same spot. Same name nearby, or anything almost on top of it.
const tier1 = new Map();
const bucket = (lon, lat) => `${Math.floor(lon * 2)}:${Math.floor(lat * 2)}`;
for (const [name, lon, lat] of cities) {
  const k = bucket(lon, lat);
  if (!tier1.has(k)) tier1.set(k, []);
  tier1.get(k).push([norm(name), lon, lat]);
}
function inTier1(name, lon, lat) {
  const n = norm(name);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const k = `${Math.floor(lon * 2) + dx}:${Math.floor(lat * 2) + dy}`;
      for (const [cn, cx, cy] of tier1.get(k) ?? []) {
        const d = Math.hypot(cx - lon, cy - lat);
        if (d < 0.02 || (d < 0.3 && cn === n)) return true;
      }
    }
  }
  return false;
}

// Sections of a city, and places that no longer exist, are not towns.
const SKIP = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH']);

const cells = new Map();
let kept = 0;
for (const row of readFileSync(join(src, 'cities1000.txt'), 'utf8').split('\n')) {
  if (!row) continue;
  const c = row.split('\t');
  if (SKIP.has(c[7])) continue;
  const name = c[1];
  const lat = Number(c[4]);
  const lon = Number(c[5]);
  const pop = Number(c[14]) || 0;
  if (inTier1(name, lon, lat)) continue;
  const key = `${Math.floor((lon + 180) / TOWN_CELL)}_${Math.floor((lat + 90) / TOWN_CELL)}`;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push([pop, name, r(lon, 3), r(lat, 3)]);
  kept++;
}

const townDir = join(out, 'towns');
rmSync(townDir, { recursive: true, force: true });
mkdirSync(townDir);
for (const [key, rows] of cells) {
  rows.sort((a, b) => b[0] - a[0]);
  writeFileSync(
    join(townDir, `${key}.json`),
    JSON.stringify(rows.map(([pop, name, lon, lat]) => [name, lon, lat, townZoom(pop)])),
  );
}

console.log(`${countries.length} countries, ${cities.length} cities, ${kept} towns in ${cells.size} cells`);
