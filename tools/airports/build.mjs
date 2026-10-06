/**
 * Real airport buildings, from the FlightGear scenery database.
 *
 * The FlightGear community has modelled the terminals, piers, towers, hangars
 * and jetways of most of the world's big airports — Orly's west terminal and
 * its tower, the Roissy terminals, Heathrow's T5 — from photographs, textures
 * included. The models are GPL-2.0, like the aircraft this project already
 * converts from FGAddon, and are published at https://scenery.flightgear.org
 * with their author and their exact placement.
 *
 * That server allows only its own pages to read it from a browser and limits
 * each client to a hundred requests a minute, so the app cannot fetch from it
 * as people fly; and it should not, for the server's sake. This script does it
 * once, politely (throttled, every answer cached under `.cache/`), and turns
 * each airport into one file the site serves itself:
 *
 *   public/models/airports/<ICAO>.pvm   the buildings, merged by texture
 *   public/models/airports/tex/…        their textures, WebP, shared
 *   public/models/airports/index.json   which airports, where, and by whom
 *   public/models/airports/CREDITS.md   every model and its author
 *
 * Only architecture is kept: buildings, terminals, piers, jetways, towers.
 * Fences, trees, vehicles, signs and parked aircraft are left out — the
 * traffic on the apron is the real one — and so are the pavement sheets some
 * models carry.
 *
 * The database's placements are not all made the same way (see `toEnu`), so
 * each building is oriented against OpenStreetMap's footprints (OpenFreeMap
 * vector tiles, cached under `.cache/osm`, used here only and never shipped),
 * and a big one that matches nothing mapped is left out as misplaced.
 *
 * ## Coordinates
 *
 * A pack is in metres about the airport's reference point: x east, y north,
 * z up from the ground under each building; see `toEnu` for how a model's
 * own axes and the database's heading come to that, checked against the
 * imagery at Orly. Each vertex carries the index of the building
 * it belongs to (`inst`), and the header lists every building's position, so
 * the app can stand each one on its own patch of ground.
 *
 *   node tools/airports/build.mjs            every airport in AIRPORTS
 *   node tools/airports/build.mjs LFPO EGLL  just these
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VectorTile } from '@mapbox/vector-tile';
import { MeshoptSimplifier } from 'meshoptimizer';
import { PbfReader } from 'pbf';
import sharp from 'sharp';

import { applyTransform, flatten, parseAc3d } from '../fgmodel/ac3d.mjs';
import { packPvm } from '../fgmodel/pvmpack.mjs';
import { decodeSgi, isSgi } from '../fgmodel/sgi.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CACHE = join(HERE, '.cache');
const OUT = join(ROOT, 'public', 'models', 'airports');
/** What the index leaves out, kept for the next partial run: authors and sheets per airport. */
const BUILT = join(HERE, 'built.json');
const API = 'https://scenery.flightgear.org/api';

/** Longest texture side shipped. A terminal façade seen from a cockpit needs no more. */
const MAX_TEXTURE_PX = 1024;
/** An airport with fewer buildings than this is not worth a download. */
const MIN_BUILDINGS = 12;
/**
 * Triangles per airport. Some models are modelled to the door handle — Nice's
 * 81 buildings came to 112,000 — which from an aircraft is weight nobody
 * sees: past this, every part is simplified in proportion, to within
 * `SIMPLIFY_M` of its shape.
 */
const BUDGET_TRIANGLES = 60_000;
const SIMPLIFY_M = 0.15;
/** A level face lower than this above a building's ground is pavement, metres. */
const GROUND_SHEET_M = 0.8;

/**
 * The airports, by reference point. Half-size of the area searched, km: the
 * big ones sprawl.
 */
const AIRPORTS = [
  ['LFPG', 49.0097, 2.5479, 4.5],
  ['LFPO', 48.7262, 2.3652, 3.5],
  ['LFMN', 43.6584, 7.2159, 2.5],
  ['LFLL', 45.7256, 5.0811, 3],
  ['LFML', 43.4393, 5.2214, 3],
  ['LFBO', 43.6291, 1.3638, 3],
  ['LFSB', 47.59, 7.5291, 2.5],
  ['LFBD', 44.8283, -0.7156, 3],
  ['LFRS', 47.1532, -1.6107, 2.5],
  ['EGLL', 51.47, -0.4543, 4],
  ['EGKK', 51.1537, -0.1821, 3],
  ['EGSS', 51.885, 0.235, 3],
  ['EGCC', 53.3537, -2.275, 3],
  ['EDDF', 50.0379, 8.5622, 4],
  ['EDDM', 48.3538, 11.7861, 4],
  ['EDDB', 52.3667, 13.5033, 3.5],
  ['EDDH', 53.6304, 9.9882, 3],
  ['EDDL', 51.2895, 6.7668, 3],
  ['EDDK', 50.8659, 7.1427, 3],
  ['EDDS', 48.6899, 9.2219, 3],
  ['EHAM', 52.3105, 4.7683, 4.5],
  ['EBBR', 50.901, 4.4844, 3.5],
  ['ELLX', 49.6233, 6.2044, 2.5],
  ['LSZH', 47.4582, 8.5555, 3.5],
  ['LSGG', 46.2381, 6.109, 3],
  ['LOWW', 48.1103, 16.5697, 3.5],
  ['LEMD', 40.4719, -3.5626, 4.5],
  ['LEBL', 41.2974, 2.0833, 3.5],
  ['LEPA', 39.5517, 2.7388, 3],
  ['LPPT', 38.7742, -9.1342, 3],
  // LIRF left out: its terminals are untextured, two of them placed twice
  // over each other at different angles, and they match the ground poorly.
  ['LIMC', 45.63, 8.7231, 4],
  ['LGAV', 37.9364, 23.9445, 3.5],
  ['EKCH', 55.618, 12.656, 3.5],
  ['ENGM', 60.1976, 11.1004, 3.5],
  ['ESSA', 59.6519, 17.9186, 3.5],
  ['EFHK', 60.3172, 24.9633, 3.5],
  ['EIDW', 53.4213, -6.2701, 3],
  ['EPWA', 52.1657, 20.9671, 3],
  ['LKPR', 50.1008, 14.26, 3],
  ['LHBP', 47.4298, 19.2611, 3],
  ['LTFM', 41.2753, 28.7519, 5],
  ['OMDB', 25.2532, 55.3657, 4],
  ['OTHH', 25.2731, 51.6081, 4],
  ['KJFK', 40.6413, -73.7781, 4],
  ['KEWR', 40.6895, -74.1745, 3.5],
  ['KLAX', 33.9416, -118.4085, 4],
  ['KSFO', 37.6213, -122.379, 4],
  ['KORD', 41.9742, -87.9073, 4.5],
  ['KATL', 33.6407, -84.4277, 4.5],
  ['KDFW', 32.8998, -97.0403, 5],
  ['KDEN', 39.8561, -104.6737, 5],
  ['KSEA', 47.4502, -122.3088, 3.5],
  ['KBOS', 42.3656, -71.0096, 3.5],
  ['KMIA', 25.7959, -80.287, 3.5],
  ['KIAD', 38.9531, -77.4565, 4],
  ['CYYZ', 43.6777, -79.6248, 4],
  ['CYVR', 49.1967, -123.1815, 3.5],
  ['CYUL', 45.4706, -73.7408, 3.5],
  ['RJTT', 35.5494, 139.7798, 4],
  ['RJAA', 35.772, 140.3929, 4],
  ['WSSS', 1.3644, 103.9915, 4.5],
  ['VHHH', 22.308, 113.9185, 4.5],
  ['YSSY', -33.9399, 151.1753, 4],
  ['SBGR', -23.4356, -46.4731, 3.5],
  ['FAOR', -26.1367, 28.2411, 3.5],
  ['PHNL', 21.3187, -157.9225, 3.5],
];

/** What counts as architecture, by the database's model groups. */
const KEEP_TYPE = /Airport Architecture|Terminal Jetways|^Static$|Commercial Buildings|Industrial|Towers|Hangar/i;
/** Inside those, what is still not a building. */
const DROP_NAME =
  /\b(?:fences?|trees?|signs?|lights?|lamps?|poles?|cones?|windsocks?|markers?|bush(?:es)?|hedges?|vehicles?|cars?|trucks?|bus(?:es)?|people|workers?|persons?|containers?|caisses?\d*|chariot|antennas?|masts?|vor|dme|ils|gs|loc|ndb|glide ?slope)\b|lichtmast|light ?volume|light ?cone|beam|halo|glow|flare|floodlight/i;

// ---------------------------------------------------------------------------
// The database, politely

let lastRequest = 0;
async function api(path, file) {
  const target = join(CACHE, file);
  if (existsSync(target)) return readFile(target);
  // At most ~70 a minute, well inside the server's hundred.
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + 850 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    const response = await fetch(`${API}${path}`, {
      headers: { 'User-Agent': 'PlanesView airport build (one-off, cached)' },
    });
    if (response.status === 429 && attempt < 6) {
      const reset = Number(response.headers.get('ratelimit-reset') ?? 30);
      await new Promise((r) => setTimeout(r, (reset + 2) * 1000));
      continue;
    }
    if (!response.ok) throw new Error(`${response.status} ${path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return bytes;
  }
}

async function objectsAround(icao, lat, lon, km) {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((v) => v.toFixed(5)).join(',');
  const json = JSON.parse((await api(`/objects/map?bbox=${bbox}&limit=5000`, `objects/${icao}.json`)).toString('utf8'));
  return json.objects ?? [];
}

/** A model's files, unpacked into the cache: `{ dir, meta }`. */
async function modelFiles(id) {
  const meta = JSON.parse((await api(`/models/${id}`, `models/${id}/meta.json`)).toString('utf8'));
  const dir = join(CACHE, 'models', String(id), 'files');
  if (!existsSync(dir)) {
    const archive = await api(`/models/${id}/package`, `models/${id}/package.tar.gz`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '..', 'package.tar.gz'), archive);
    execFileSync('tar', ['xzf', join(dir, '..', 'package.tar.gz'), '-C', dir]);
  }
  return { dir, meta };
}

// ---------------------------------------------------------------------------
// Models

/** Every `.ac` a model draws, with the offset its XML places it at, and its night animations. */
async function resolveModel(dir, file, offset = { x: 0, y: 0, z: 0, heading: 0 }, depth = 0) {
  if (file.endsWith('.ac')) return [{ ac: join(dir, file), offset, night: new Map() }];
  if (!file.endsWith('.xml') || depth > 3) return [];
  const path = join(dir, file);
  if (!existsSync(path)) return [];
  const xml = (await readFile(path)).toString('utf8');
  const out = [];

  // The day/night texture swap: a texture translation driven by the sun's angle.
  const night = new Map();
  for (const block of xml.match(/<animation>[\s\S]*?<\/animation>/g) ?? []) {
    if (!/<type>\s*textranslate\s*<\/type>/.test(block) || !/sun-angle-rad/.test(block)) continue;
    const step = Number(/<step>\s*([-\d.eE]+)\s*<\/step>/.exec(block)?.[1] ?? 0);
    const factor = Number(/<factor>\s*([-\d.eE]+)\s*<\/factor>/.exec(block)?.[1] ?? 0);
    const axis = /<axis>([\s\S]*?)<\/axis>/.exec(block)?.[1] ?? '';
    const ax = Number(/<x>\s*([-\d.eE]+)/.exec(axis)?.[1] ?? 0);
    const ay = Number(/<y>\s*([-\d.eE]+)/.exec(axis)?.[1] ?? 0);
    const shift = [step * factor * ax, step * factor * ay];
    if (!shift[0] && !shift[1]) continue;
    for (const m of block.matchAll(/<object-name>\s*([^<]+?)\s*<\/object-name>/g)) night.set(m[1], shift);
  }

  const top = /<PropertyList>\s*(?:<!--[\s\S]*?-->\s*)*<path>\s*([^<]+?)\s*<\/path>/.exec(xml) ?? /^\s*<path>\s*([^<]+?)\s*<\/path>/m.exec(xml);
  const main = /<path>\s*([^<]+?\.ac)\s*<\/path>/.exec(xml);
  const first = top?.[1] ?? main?.[1];
  if (first?.endsWith('.ac')) out.push({ ac: join(dir, first), offset, night });

  for (const m of xml.matchAll(/<model>([\s\S]*?)<\/model>/g)) {
    const sub = /<path>\s*([^<]+?)\s*<\/path>/.exec(m[1])?.[1];
    if (!sub || sub.includes('/')) continue; // a shared model elsewhere in the tree: not in this package
    const o = /<offsets>([\s\S]*?)<\/offsets>/.exec(m[1])?.[1] ?? '';
    const num = (tag) => Number(new RegExp(`<${tag}>\\s*([-\\d.eE]+)`).exec(o)?.[1] ?? 0);
    const child = {
      x: offset.x + num('x-m'),
      y: offset.y + num('y-m'),
      z: offset.z + num('z-m'),
      heading: offset.heading + num('heading-deg'),
    };
    out.push(...(await resolveModel(dir, sub, child, depth + 1)));
  }
  return out;
}

/**
 * A FlightGear model point to east/north/up about its own placement.
 *
 * AC3D is y-up; FlightGear's model frame is X = AC x, Y = −AC z, Z = AC y.
 * The database's heading turns that frame about the vertical, and at heading 0
 * the model's X points south and its Y east — most of the time. Laying
 * footprints over the imagery showed the database is not consistent: Orly's
 * terminals need the heading clockwise, Roissy's anticlockwise (or their axes
 * reversed), whoever placed them and however. So each building's orientation
 * is one of eight — the turn's sense, times the four quarter turns of its axes —
 * chosen by `orientation` against the airport's mapped buildings; `DEFAULT`
 * where the map cannot tell.
 */
const ORIENTATIONS = [-1, 1].flatMap((sense) => [0, 1, 2, 3].map((quarter) => ({ sense, quarter })));
const DEFAULT = { sense: -1, quarter: 0 };

function toEnu(p, headingDeg, offset, { sense, quarter } = DEFAULT) {
  const X = p[0] + offset.x;
  const Y = -p[2] + offset.y;
  const Z = p[1] + offset.z;
  const h = (sense * (headingDeg + offset.heading) * Math.PI) / 180;
  const c = Math.cos(h);
  const s = Math.sin(h);
  const x = X * c - Y * s;
  const y = X * s + Y * c;
  // X south, Y east, Z up → east, north, up; then the quarter turn.
  switch (quarter) {
    case 1:
      return [x, y, Z];
    case 2:
      return [-y, x, Z];
    case 3:
      return [-x, -y, Z];
    default:
      return [y, -x, Z];
  }
}

// ---------------------------------------------------------------------------
// The mapped buildings, to orient the models by

const OSM_ZOOM = 14;
const OSM_CELL_M = 2;
/** How far a model may stand off its mapped building and still count as on it, cells. */
const SLACK_CELLS = 4;
/** A model reaching this far from its origin, metres, is big enough that the map must have it… */
const MISPLACED_REACH_M = 150;
/** …on at least this share of its corners, in its best orientation. */
const MISPLACED_SCORE = 0.25;
/** A warehouse-sized one standing on almost nothing mapped is a filler model, not a real building. */
const FILLER_REACH_M = 75;
const FILLER_SCORE = 0.15;
/**
 * Models of buildings that have since been torn down, by scenery model id.
 * Their sites are building sites or other buildings now, so the map check
 * alone does not catch them.
 */
/** Two copies of one model this close, metres, are one building placed twice (rows of jetways or tanks stand further apart). */
const TWIN_M = 2;
const DEMOLISHED = new Map([
  [839, 'JFK terminal 3, the Worldport — demolished 2013'],
  [846, 'JFK terminal 2 — demolished 2023, the new terminal 1 rises there'],
]);
let osmTiles = null;

/** OpenFreeMap's current tile URL template (it names a dated build). */
async function osmTemplate() {
  osmTiles ??= fetch('https://tiles.openfreemap.org/planet')
    .then((r) => r.json())
    .then((j) => j.tiles[0]);
  return osmTiles;
}

async function osmTile(x, y) {
  const target = join(CACHE, 'osm', `${OSM_ZOOM}_${x}_${y}.pbf`);
  if (existsSync(target)) return readFile(target);
  const url = (await osmTemplate()).replace('{z}', OSM_ZOOM).replace('{x}', x).replace('{y}', y);
  const response = await fetch(url);
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return bytes;
}

/**
 * Where the map has buildings about an airport: a grid of `OSM_CELL_M` cells,
 * metres east and north of the reference point, 1 inside a building.
 */
async function mappedBuildings(lat, lon, km) {
  const half = km * 1000 + 500;
  const size = Math.ceil((2 * half) / OSM_CELL_M);
  const grid = new Uint8Array(size * size);
  const mPerLat = 111_132;
  const mPerLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const n = 2 ** OSM_ZOOM;
  const tileX = (lo) => Math.floor(((lo + 180) / 360) * n);
  const tileY = (la) => Math.floor(((1 - Math.asinh(Math.tan((la * Math.PI) / 180)) / Math.PI) / 2) * n);
  const dLat = half / mPerLat;
  const dLon = half / mPerLon;
  for (let x = tileX(lon - dLon); x <= tileX(lon + dLon); x++) {
    for (let y = tileY(lat + dLat); y <= tileY(lat - dLat); y++) {
      const bytes = await osmTile(x, y);
      if (!bytes) continue;
      const layer = new VectorTile(new PbfReader(bytes)).layers.building;
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const rings = layer.feature(i).loadGeometry();
        // Rings to grid cells, then an even-odd scanline fill.
        const cells = rings.map((ring) =>
          ring.map((pt) => {
            const lo = ((x + pt.x / layer.extent) / n) * 360 - 180;
            const la = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + pt.y / layer.extent)) / n))) * 180) / Math.PI;
            return [((lo - lon) * mPerLon + half) / OSM_CELL_M, ((la - lat) * mPerLat + half) / OSM_CELL_M];
          }),
        );
        const ys = cells.flat().map((c) => c[1]);
        const y0 = Math.max(0, Math.floor(Math.min(...ys)));
        const y1 = Math.min(size - 1, Math.ceil(Math.max(...ys)));
        for (let row = y0; row <= y1; row++) {
          const yc = row + 0.5;
          const xs = [];
          for (const ring of cells) {
            for (let k = 0; k < ring.length; k++) {
              const [ax, ay] = ring[k];
              const [bx, by] = ring[(k + 1) % ring.length];
              if (ay <= yc !== by <= yc) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
            }
          }
          xs.sort((a, b) => a - b);
          for (let k = 0; k + 1 < xs.length; k += 2) {
            for (let col = Math.max(0, Math.ceil(xs[k] - 0.5)); col <= Math.min(size - 1, Math.floor(xs[k + 1] - 0.5)); col++) {
              grid[row * size + col] = 1;
            }
          }
        }
      }
    }
  }
  // Grown by the slack a model's placement has against today's map: the
  // database's positions are often ten metres or so out.
  const grown = new Uint8Array(grid.length);
  const tmp = new Uint8Array(grid.length);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let on = 0;
      for (let d = -SLACK_CELLS; d <= SLACK_CELLS && !on; d++) on = grid[y * size + Math.min(size - 1, Math.max(0, x + d))];
      tmp[y * size + x] = on;
    }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let on = 0;
      for (let d = -SLACK_CELLS; d <= SLACK_CELLS && !on; d++) on = tmp[Math.min(size - 1, Math.max(0, y + d)) * size + x];
      grown[y * size + x] = on;
    }
  return { grid: grown, size, half };
}

/**
 * The orientation that stands a model on its mapped building: of the eight,
 * the one that puts most of its walls and roofs inside the map's buildings
 * (with `SLACK_CELLS` of slack). The default unless another is clearly better,
 * and the default where the map has nothing there to compare with.
 */
function orientation(samples, heading, east, north, osm) {
  if (!osm || samples.length === 0) return { choice: DEFAULT, score: 0 };
  const inside = (e, nn) => {
    const x = Math.floor((e + osm.half) / OSM_CELL_M);
    const y = Math.floor((nn + osm.half) / OSM_CELL_M);
    return x >= 0 && y >= 0 && x < osm.size && y < osm.size && osm.grid[y * osm.size + x] === 1;
  };
  const score = (o) => {
    let hits = 0;
    for (const { p, offset } of samples) {
      const [e, nn] = toEnu(p, heading, offset, o);
      if (inside(e + east, nn + north)) hits++;
    }
    return hits / samples.length;
  };
  const base = score(DEFAULT);
  let best = { choice: DEFAULT, score: base };
  for (const o of ORIENTATIONS) {
    if (o.sense === DEFAULT.sense && o.quarter === DEFAULT.quarter) continue;
    const sc = score(o);
    if (sc > best.score) best = { choice: o, score: sc };
  }
  // A clear win only: a square block scores alike every way round.
  return best.score > base + 0.12 && best.score > 0.35 ? best : { choice: DEFAULT, score: base };
}

function faceNormal(a, b, c) {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(...n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

// ---------------------------------------------------------------------------
// Textures

const textureNames = new Map(); // content hash → shipped name
async function shipTexture(path) {
  if (!existsSync(path)) return null;
  const raw = await readFile(path);
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 16);
  if (textureNames.has(hash)) return textureNames.get(hash);
  const name = `${hash}.webp`;
  const out = join(OUT, 'tex', name);
  if (!existsSync(out)) {
    try {
      const input = isSgi(raw)
        ? await (({ width, height, rgba }) =>
            sharp(rgba, { raw: { width, height, channels: 4 } })
              .png()
              .toBuffer())(decodeSgi(raw))
        : raw;
      const webp = await sharp(input)
        .resize({
          width: MAX_TEXTURE_PX,
          height: MAX_TEXTURE_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 78 })
        .toBuffer();
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, webp);
    } catch {
      textureNames.set(hash, null);
      return null;
    }
  }
  textureNames.set(hash, name);
  return name;
}

/** A texture name as the model gives it, found in the package whatever its case or folder. */
async function findTexture(dir, name) {
  const base = name.split(/[\\/]/).pop().toLowerCase();
  const files = await readdir(dir).catch(() => []);
  const hit = files.find((f) => f.toLowerCase() === base);
  return hit ? join(dir, hit) : null;
}

// ---------------------------------------------------------------------------
// One airport

async function buildAirport([icao, lat, lon, km]) {
  const objects = (await objectsAround(icao, lat, lon, km)).filter((o) => KEEP_TYPE.test(o.type ?? '') && !DROP_NAME.test(o.description ?? ''));
  if (objects.length < MIN_BUILDINGS) {
    console.log(`${icao}: ${objects.length} buildings — skipped`);
    return null;
  }

  const mPerLat = 111_132;
  const mPerLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const osm = await mappedBuildings(lat, lon, km).catch((error) => {
    console.log(`  ${icao}: no map to orient by (${error.message})`);
    return null;
  });
  const turned = [0, 0];
  /** Parts by texture and night shift: { texture, night, positions, normals, uvs, inst, color }. */
  const parts = new Map();
  const instances = [];
  const authors = new Map();
  let triangles = 0;

  const placed = [];
  for (const object of objects) {
    if (DEMOLISHED.has(object.modelId)) {
      console.log(`  ${icao}: ${DEMOLISHED.get(object.modelId)} — left out`);
      continue;
    }
    let files;
    try {
      files = await modelFiles(object.modelId);
    } catch (error) {
      console.log(`  ${icao}: model ${object.modelId} unavailable (${error.message})`);
      continue;
    }
    if (DROP_NAME.test(files.meta.name ?? '') || DROP_NAME.test(files.meta.filename ?? '')) continue;
    const pieces = await resolveModel(files.dir, files.meta.filename ?? '');
    if (pieces.length === 0) continue;

    const east = (object.position.lon - lon) * mPerLon;
    const north = (object.position.lat - lat) * mPerLat;
    // The same building placed twice — two contributors, or one model
    // uploaded under two ids — would stand inside itself, flickering.
    const name = (files.meta.name ?? String(object.modelId)).trim().toLowerCase();
    // Same spot and same heading: two jetways turning about one rotunda are not twins.
    const facing = object.position.heading ?? 0;
    const twin = (p) =>
      p.name === name && Math.hypot(p.east - east, p.north - north) < TWIN_M && Math.abs(((p.facing - facing + 540) % 360) - 180) < 5;
    if (placed.some(twin)) {
      console.log(`  ${icao}: ${files.meta.name} placed twice — the second left out`);
      continue;
    }
    placed.push({ name, east, north, facing });
    const instance = instances.length;
    const heading = object.position.heading ?? 0;
    let drew = false;

    // The model's drawable nodes, and a sample of its corners above the ground to orient it by.
    const nodes = [];
    const samples = [];
    for (const piece of pieces) {
      if (!existsSync(piece.ac)) continue;
      let parsed;
      try {
        parsed = parseAc3d((await readFile(piece.ac)).toString('latin1'));
      } catch {
        continue;
      }
      for (const { object: node, transform } of flatten(parsed.root)) {
        if (node.verts.length === 0 || node.surfaces.length === 0) continue;
        if (DROP_NAME.test(node.name ?? '') && !piece.night.has(node.name)) continue;
        nodes.push({ node, transform, piece, parsed });
        const step = Math.max(1, Math.floor(node.verts.length / 2000));
        for (let i = 0; i < node.verts.length; i += step) {
          const p = applyTransform(transform, node.verts[i]);
          if (p[1] + piece.offset.z > 2) samples.push({ p, offset: piece.offset });
        }
      }
    }
    const { choice, score } = orientation(samples, heading, east, north, osm);
    /*
     * A large building that stands on nothing the map has, whichever way it
     * is turned, is in the wrong place — Roissy's terminal 2 model lies across
     * the aprons. Better absent than wrong; a terminal that size is always
     * mapped. Small sheds the map may simply not have are kept.
     */
    const reach = samples.reduce((m, { p, offset }) => Math.max(m, Math.hypot(p[0] + offset.x, p[2] - offset.y)), 0);
    if (osm && ((reach > MISPLACED_REACH_M && score < MISPLACED_SCORE) || (reach > FILLER_REACH_M && score < FILLER_SCORE))) {
      console.log(`  ${icao}: ${files.meta.name ?? object.modelId} left out — matches nothing on the map (${score.toFixed(2)})`);
      continue;
    }
    if (process.env.ORIENT_LOG) console.log(`  ${object.modelId} ${files.meta.name} h${heading}: ${choice.sense}/${choice.quarter} ${score.toFixed(2)} reach ${reach.toFixed(0)} m (${samples.length})`);
    turned[choice === DEFAULT ? 0 : 1]++;

    for (const { node, transform, piece, parsed } of nodes) {
      const texturePath = node.texture ? await findTexture(dirname(piece.ac), node.texture) : null;
      const texture = texturePath ? await shipTexture(texturePath) : null;
      const material = parsed.materials[node.surfaces[0].material] ?? {
        rgb: [0.8, 0.8, 0.8],
      };
      const color = texture ? [1, 1, 1] : (material.rgb ?? [0.8, 0.8, 0.8]).map((c) => +c.toFixed(2));
      const night = piece.night.get(node.name) ?? null;
      const key = `${texture ?? `#${color.join(',')}`}|${night ? night.join(',') : ''}`;
      let part = parts.get(key);
      if (!part) {
        part = {
          texture,
          night,
          color,
          positions: [],
          normals: [],
          uvs: [],
          inst: [],
          index: [],
          seen: new Map(),
        };
        parts.set(key, part);
      }
      const rep = node.texrep ?? [1, 1];
      const off = node.texoff ?? [0, 0];
      const base = object.position.offset ?? 0;
      const world = node.verts.map((v) => {
        const [e, n, u] = toEnu(applyTransform(transform, v), heading, piece.offset, choice);
        return [e + east, n + north, u + (object.position.offset ?? 0)];
      });
      for (const surface of node.surfaces) {
        if ((surface.flags & 0x0f) !== 0 || surface.refs.length < 3) continue;
        for (let k = 1; k < surface.refs.length - 1; k++) {
          const refs = [surface.refs[0], surface.refs[k], surface.refs[k + 1]];
          if (refs.some((r) => !r || !world[r.v])) continue;
          const p = refs.map((r) => world[r.v]);
          const n = faceNormal(p[0], p[1], p[2]);
          if (!Number.isFinite(n[0])) continue;
          /*
           * Pavement: some models carry their own apron or forecourt, a flat
           * sheet at ground level that here would lie over the imagery as a
           * dark slab. Level faces within a hand's breadth of the ground go;
           * roofs, however low, stand higher.
           */
          if (Math.abs(n[2]) > 0.9 && p.every((q) => q[2] - base < GROUND_SHEET_M)) continue;
          // One side only: the app draws every face from both (`DoubleSide`), so a
          // two-sided face (flag 0x20) needs no back copy.
          for (const i of [0, 1, 2]) {
            const [nx, ny, nz] = n;
            const u = refs[i].u * rep[0] + off[0],
              t = refs[i].t * rep[1] + off[1];
            // Flat-shaded, so a corner is shared only by faces in the same plane with the same mapping.
            const key = `${instance}|${p[i][0].toFixed(2)},${p[i][1].toFixed(2)},${p[i][2].toFixed(2)}|${nx.toFixed(2)},${ny.toFixed(2)},${nz.toFixed(2)}|${u.toFixed(4)},${t.toFixed(4)}`;
            let at = part.seen.get(key);
            if (at === undefined) {
              at = part.positions.length / 3;
              part.seen.set(key, at);
              part.positions.push(p[i][0], p[i][1], p[i][2]);
              part.normals.push(nx, ny, nz);
              part.uvs.push(u, t);
              part.inst.push(instance);
            }
            part.index.push(at);
          }
          triangles++;
        }
      }
      drew = true;
    }
    if (!drew) continue;
    instances.push([+object.position.lat.toFixed(7), +object.position.lon.toFixed(7)]);
    const author = files.meta.author?.name ?? 'unknown';
    const list = authors.get(author) ?? new Set();
    list.add(files.meta.name ?? files.meta.filename);
    authors.set(author, list);
  }

  if (instances.length < MIN_BUILDINGS || triangles === 0) {
    console.log(`${icao}: ${instances.length} drawable buildings — skipped`);
    return null;
  }

  // --- the budget ----------------------------------------------------------
  if (triangles > BUDGET_TRIANGLES) {
    await MeshoptSimplifier.ready;
    const ratio = BUDGET_TRIANGLES / triangles;
    triangles = 0;
    for (const part of parts.values()) {
      const n = part.index.length / 3;
      if (n > 300) {
        const [kept] = MeshoptSimplifier.simplify(
          Uint32Array.from(part.index),
          Float32Array.from(part.positions),
          3,
          Math.max(300, Math.round(n * ratio)) * 3,
          SIMPLIFY_M,
          ['ErrorAbsolute'],
        );
        // Only the corners still used, renumbered.
        const remap = new Map();
        const out = { positions: [], normals: [], uvs: [], inst: [] };
        part.index = [...kept].map((v) => {
          let at = remap.get(v);
          if (at === undefined) {
            at = remap.size;
            remap.set(v, at);
            out.positions.push(part.positions[v * 3], part.positions[v * 3 + 1], part.positions[v * 3 + 2]);
            out.normals.push(part.normals[v * 3], part.normals[v * 3 + 1], part.normals[v * 3 + 2]);
            out.uvs.push(part.uvs[v * 2], part.uvs[v * 2 + 1]);
            out.inst.push(part.inst[v]);
          }
          return at;
        });
        Object.assign(part, out);
      }
      triangles += part.index.length / 3;
    }
  }

  // --- the pack ------------------------------------------------------------
  const textures = [];
  const chunks = [];
  let offset = 0;
  const push = (typed) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const padded = Buffer.alloc((bytes.length + 3) & ~3);
    bytes.copy(padded);
    chunks.push(padded);
    const at = offset;
    offset += padded.length;
    return at;
  };
  const headerParts = [];
  for (const part of parts.values()) {
    if (part.positions.length === 0) continue;
    const index = part.index;
    let ti = -1;
    if (part.texture) {
      ti = textures.indexOf(part.texture);
      if (ti < 0) ti = textures.push(part.texture) - 1;
    }
    headerParts.push({
      role: 'hull',
      name: part.texture ?? 'flat',
      texture: ti,
      color: part.color,
      emissive: [0, 0, 0],
      opacity: 1,
      origin: [0, 0, 0],
      axis: [0, 0, 1],
      repeat: part.uvs.some((v) => v < -0.1 || v > 1.1),
      night: part.night,
      position: {
        offset: push(Float32Array.from(part.positions)),
        count: part.positions.length,
      },
      normal: {
        offset: push(Float32Array.from(part.normals)),
        count: part.normals.length,
      },
      uv: { offset: push(Float32Array.from(part.uvs)), count: part.uvs.length },
      index: { offset: push(Uint32Array.from(index)), count: index.length },
      inst: {
        offset: push(Uint16Array.from(part.inst)),
        count: part.inst.length,
        type: 'u16',
      },
    });
  }
  const header = {
    id: `airport-${icao}`,
    source: 'FlightGear scenery database, scenery.flightgear.org',
    license: 'GPL-2.0',
    lengthM: 0,
    centre: [lat, lon],
    instances,
    // As the app fetches them: from `models/`, like every model's.
    textures: textures.map((t) => `airports/tex/${t}`),
    parts: headerParts,
  };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const head = Buffer.alloc(8);
  head.write('PVM1', 0, 'ascii');
  head.writeUInt32LE(json.length + pad, 4);
  const blob = packPvm(Buffer.concat([head, json, Buffer.alloc(pad), ...chunks]));
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, `${icao}.pvm`), blob);

  console.log(
    `${icao}: ${instances.length} buildings (${turned[1]} turned by the map${osm ? '' : ', no map'}), ${triangles.toLocaleString()} triangles, ${headerParts.length} parts, ${(blob.length / 1024).toFixed(0)} kB`,
  );
  return {
    icao,
    lat,
    lon,
    radiusKm: km,
    bytes: blob.length,
    textures,
    authors: [...authors.entries()].map(([name, models]) => ({
      name,
      models: [...models].sort(),
    })),
  };
}

async function main() {
  const only = process.argv.slice(2).map((s) => s.toUpperCase());
  const list = only.length ? AIRPORTS.filter(([icao]) => only.includes(icao)) : AIRPORTS;

  const indexPath = join(OUT, 'index.json');
  const previous = existsSync(indexPath) ? JSON.parse((await readFile(indexPath)).toString('utf8')) : [];
  // Authors and textures of every airport built so far, which the shipped index leaves out.
  const sidecar = existsSync(BUILT) ? JSON.parse((await readFile(BUILT)).toString('utf8')) : {};
  // Only airports still on the list: one taken off it goes from the index, and its file with it.
  const listed = new Set(AIRPORTS.map(([icao]) => icao));
  const built = new Map(previous.filter((a) => listed.has(a.icao)).map((a) => [a.icao, { ...a, ...sidecar[a.icao] }]));
  for (const airport of list) {
    try {
      const row = await buildAirport(airport);
      if (row) built.set(row.icao, row);
      else built.delete(airport[0]);
    } catch (error) {
      console.log(`${airport[0]}: failed — ${error.message}`);
    }
  }
  const rows = [...built.values()].sort((a, b) => a.icao.localeCompare(b.icao));
  await writeFile(
    indexPath,
    `${JSON.stringify(
      rows.map(({ authors: _a, textures: _t, ...row }) => row),
      null,
      1,
    )}\n`,
  );
  await writeFile(join(OUT, 'CREDITS.md'), credits(rows));
  await writeFile(BUILT, `${JSON.stringify(Object.fromEntries(rows.map((r) => [r.icao, { authors: r.authors ?? [], textures: r.textures ?? [] }])), null, 1)}\n`);
  for (const f of await readdir(OUT)) {
    if (f.endsWith('.pvm') && !built.has(f.slice(0, -4))) await rm(join(OUT, f));
  }
  // Sheets no airport uses any more — once every airport's sheets are known.
  if (rows.every((r) => r.textures)) {
    const used = new Set(rows.flatMap((r) => r.textures));
    for (const f of await readdir(join(OUT, 'tex')).catch(() => [])) if (!used.has(f)) await rm(join(OUT, 'tex', f));
  }
  const total = rows.reduce((s, r) => s + r.bytes, 0);
  console.log(`${rows.length} airports, ${(total / 1048576).toFixed(1)} MB of buildings (textures separate)`);
}

function credits(rows) {
  const lines = [
    '# 3D airport buildings',
    '',
    'The terminals, piers, towers, hangars and jetways in this directory are',
    'converted from the [FlightGear scenery database](https://scenery.flightgear.org)',
    'by `tools/airports/build.mjs`. They are **not** original to this project.',
    '',
    'Every model is licensed **GPL-2.0** by its author, as all models in that',
    'database are; the converted form is a derivative work under the same licence',
    "(full text: `../LICENSE-GPL-2.0.txt`). Placement is the database's own.",
    '',
  ];
  for (const row of rows) {
    lines.push(`## ${row.icao}`, '');
    for (const author of row.authors ?? []) lines.push(`- **${author.name}** — ${author.models.join(', ')}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
