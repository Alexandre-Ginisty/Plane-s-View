#!/usr/bin/env node
/**
 * Where each national aerial-imagery layer has pictures: `src/tiles/coverage.json`.
 *
 *   node tools/tiles/build-coverage.mjs ne_10m_admin_0_countries.geojson ne_10m_admin_1_states_provinces.geojson
 *
 * Source: Natural Earth, public domain (naturalearthdata.com), from
 * github.com/nvkelso/natural-earth-vector/tree/master/geojson.
 *
 * `src/tiles/regional.ts` asks "is this tile inside the country?" for every
 * tile the globe draws, so what it gets is the outline, thinned to about
 * 400 m: finer than that costs lookups and buys nothing, because the real
 * edge of an agency's coverage is not the border to the metre either (a tile
 * that straddles it is passed over, see `regional.ts`).
 *
 * Only the mainland of each country, where the agency's service actually
 * answers: France without its overseas departments, the Netherlands without
 * the Caribbean, the United States without Alaska and Hawaii — whose
 * orthoimagery is commercially licensed and not free to use.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [countriesFile, adminFile] = process.argv.slice(2);
if (!countriesFile || !adminFile) {
  console.error('usage: build-coverage.mjs <admin_0_countries.geojson> <admin_1_states_provinces.geojson>');
  process.exit(1);
}

/** id -> where to look and which of its polygons to keep. */
const REGIONS = {
  fr: { from: 'country', key: 'FRA', box: [-6, 41, 10, 52] },
  nl: { from: 'country', key: 'NLD', box: [3, 50, 8, 54] },
  at: { from: 'country', key: 'AUT' },
  es: { from: 'country', key: 'ESP', box: [-19, 27, 5, 44] },
  ch: { from: 'country', key: 'CHE' },
  lu: { from: 'country', key: 'LUX' },
  ee: { from: 'country', key: 'EST' },
  us: { from: 'country', key: 'USA', box: [-125, 24, -66, 50] },
  'de-nw': { from: 'admin1', key: 'Nordrhein-Westfalen' },
  'de-by': { from: 'admin1', key: 'Bayern' },
};

/**
 * Douglas-Peucker on a closed ring of [lon, lat], tolerance in degrees.
 * A closed ring starts and ends at the same point, which has no direction to
 * measure distance from, so it is cut at its farthest point first.
 */
function simplify(ring, tol) {
  let far = 1;
  for (let i = 1; i < ring.length - 1; i++) {
    if (Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]) > Math.hypot(ring[far][0] - ring[0][0], ring[far][1] - ring[0][1])) far = i;
  }
  const a = line(ring.slice(0, far + 1), tol);
  const b = line(ring.slice(far), tol);
  return [...a, ...b.slice(1)];
}

function line(points, tol) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + bx * ay - by * ax) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

const area = (ring) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(s / 2);
};

const countries = JSON.parse(readFileSync(countriesFile, 'utf8')).features;
const admin = JSON.parse(readFileSync(adminFile, 'utf8')).features;

const out = {};
for (const [id, spec] of Object.entries(REGIONS)) {
  const feature =
    spec.from === 'country'
      ? countries.find((f) => f.properties.ADM0_A3 === spec.key)
      : admin.find((f) => f.properties.name === spec.key && f.properties.iso_a2 === 'DE');
  if (!feature) throw new Error(`${id}: ${spec.key} not found`);

  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const rings = [];
  for (const polygon of polygons) {
    const ring = polygon[0];
    // Islets cost lookups and carry no tiles worth swapping. The floor is low
    // enough to keep Manhattan (about 0.006 square degrees), which matters.
    if (area(ring) < 0.004) continue;
    if (spec.box) {
      const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      const [w, s, e, n] = spec.box;
      if (lon < w || lon > e || lat < s || lat > n) continue;
    }
    rings.push(simplify(ring, 0.004).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]));
  }
  out[id] = rings;
  console.log(id, rings.length, 'rings,', rings.reduce((n, r) => n + r.length, 0), 'points');
}

writeFileSync(fileURLToPath(new URL('../../src/tiles/coverage.json', import.meta.url)), JSON.stringify(out));
