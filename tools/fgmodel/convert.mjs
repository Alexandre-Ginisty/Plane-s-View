/**
 * FlightGear aircraft -> PlanesView model (.pvm).
 *
 * Build-time only, run by hand when the model set changes. Nothing here ships.
 *
 *   node tools/fgmodel/convert.mjs [id ...]
 *
 * ## What it does, and why each step is needed
 *
 * **Axes.** FlightGear models are +X aft, +Y up, +Z port, in metres from an
 * arbitrary datum. This app is +Y nose, +X starboard, +Z up, normalised to
 * length 1 so one geometry can be scaled to the real airframe. The mapping is
 * x = -z, y = -x, z = y, which is a rotation rather than a reflection — its
 * determinant is +1. That matters: a reflection would look almost right and
 * silently mirror every piece of lettering on the livery.
 *
 * **Roles.** A FlightGear model is one file containing the exterior, the
 * cabin, the flight deck, the ground equipment and the pushback tug. Most of
 * that is invisible from outside and all of it costs download. The object
 * names are semantic — `fuselage`, `fuselage.int`, `propL`, `gearF`,
 * `WheelN` — so the parts are sorted by name into what the renderer already
 * distinguishes: hull, retractable gear, and spinners that turn.
 *
 * **Validation.** Each entry declares the real aircraft's length, and the
 * converter refuses a model whose bounding box disagrees by more than a few
 * percent. A model that parsed cleanly but came out at half scale, or with the
 * span read as the length, is the failure this catches — and it is invisible
 * in a viewer, because everything in the file is wrong together.
 */

import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyTransform, flatten, parseAc3d } from './ac3d.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CACHE = join(HERE, '.cache');

/**
 * Texture ceiling, pixels on the long edge.
 *
 * Simulator liveries are authored at 4096 for a cockpit walk-around. This app
 * draws the aeroplane at a few hundred pixels — the widest it is ever seen is
 * the front page, and the model is normalised to unit length even there — so
 * everything above 2048 is detail that is downsampled on the GPU on every
 * frame after being downloaded once. The raw set came to 88 MB, which is not a
 * thing to put in a repository or in front of a phone tether.
 */
const MAX_TEXTURE_PX = 2048;
const OUT = join(ROOT, 'public', 'models');

const FGADDON = 'https://svn.code.sf.net/p/flightgear/fgaddon/trunk/Aircraft';

/**
 * Objects that exist in the file but never appear in this app's shots.
 *
 * Two families, for two different reasons.
 *
 * The **interior** is the big one by size: a FlightGear airliner carries a
 * full cabin and flight deck, which is most of the vertex count and is only
 * ever seen from a seat this app does not put you in.
 *
 * The **light beams** are the big one by consequence. Landing and taxi lights
 * are modelled as long translucent cones projecting from the airframe, and on
 * the 777 they reach sixty metres ahead of the nose — so the bounding box came
 * out at 128 m for a 73.9 m aeroplane, and scaling to that box would have
 * shrunk the actual aircraft to half size. The validation below caught it;
 * this is the fix.
 */
const DISCARD =
  /\.int$|interior|cabin|cockpit|flightdeck|panel|seat|yoke|pedestal|instrument|jack|tug|pushback|stair|chock|cone$|service|crew|human|pilot|shadow|\.hide|\.spot$|beam|halo|flare/i;

/**
 * Undercarriage, hidden above circuit height.
 *
 * Deliberately *not* anchored, which the first version was. Model authors put
 * the side before the part far more often than after it, so `^gear` misses
 * `rightgear.hyd2` and `^wheel` misses `NoseWheel` — and on the 787 that is
 * every gear part there is. The result was an airliner whose wheels were
 * welded to the fuselage: down at cruise, and no longer retractable, in the
 * app as well as anywhere else the model is drawn.
 *
 * The texture rule below catches the rest. Aircraft authors put the whole
 * undercarriage on one sheet, so a part painted with it is gear whatever the
 * object happens to be called — which is how the main bogies (`Mesh.395` and
 * friends) are found at all.
 */
const GEAR = /(gear|wheel|bogie|tyre|tire|oleo)/i;
const GEAR_TEXTURE = /(gear|wheel|bogie|tyre|tire)/i;

/** Turning parts, emitted as spinners the renderer drives. */
const PROP = /^prop(?!disc)/i;
const PROPDISC = /^propdisc/i;
const ROTOR = /^(mainrotor|rotor|blade)(?!.*tail)/i;
const TAILROTOR = /^(tailrotor|rotortail)/i;

export const AIRCRAFT = [
  {
    id: 'dh8d',
    path: 'DHC-8',
    model: 'Models/DH8D.ac',
    types: ['DH8D', 'DH8C', 'DH8B', 'DH8A'],
    lengthM: 32.8,
    credit: 'DHC-8 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'b788',
    path: '787-8',
    model: 'Models/787-8.ac',
    types: ['B788', 'B789', 'B78X'],
    lengthM: 56.7,
    credit: '787-8 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'a388',
    path: 'A380',
    model: 'Models/a380.ac',
    types: ['A388'],
    lengthM: 72.7,
    credit: 'A380 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'b77w',
    path: '777',
    model: 'Models/777-300ER.ac',
    types: ['B77W', 'B77L', 'B773', 'B772', 'B77F'],
    lengthM: 73.9,
    credit: '777 — FlightGear FGAddon, GPL-2.0',
    /*
     * Operator liveries.
     *
     * The 777 is the one aircraft in the hangar whose liveries are filed under
     * ICAO airline designators, which is exactly what the first three letters
     * of an ADS-B callsign are. That makes the correct airline reachable
     * rather than guessable, and it is what fixes the complaint that started
     * this: a single baked-in JAL paint scheme was being shown on every 777 in
     * the sky, including everyone else's.
     *
     * `neutral` is the fallback and it matters more than any single airline.
     * Falling back to *another* operator's livery would be worse than having
     * none — a plain white aircraft is honest about not knowing, and a Qatar
     * 777 painted as Emirates is not.
     */
    liveries: {
      dir: 'Models/Liveries-300ER',
      /** The texture in the base model that a livery replaces. */
      replaces: 'paint1.png',
      neutral: 'white',
      /*
       * The busiest 777 operators, plus the file each one is under — the
       * upstream names are not all bare designators. Curated rather than
       * exhaustive because every entry is about half a megabyte, and the
       * long tail is answered perfectly well by `neutral`.
       */
      byOperator: {
        AAL: 'AAL',
        ACA: 'ACA-New-livery',
        AFL: 'AFL',
        AFR: 'AFR-New-livery',
        ANA: 'ANA',
        ANZ: 'ANZ',
        BAW: 'BAW',
        CCA: 'CCA',
        CES: 'CES',
        CPA: 'CPA',
        CSN: 'CSN',
        ETD: 'ETD',
        EVA: 'EVA',
        GIA: 'GIA',
        JAL: 'JAL-one',
        KLM: 'KLM-New-livery',
        MSR: 'MSR',
        PIA: 'PIA',
        QTR: 'QTR',
        SAA: 'SAA',
        SIA: 'SIA',
        SVA: 'SVA',
        SWR: 'SWR',
        THY: 'THY',
        UAE: 'UAE',
        VOZ: 'VOZ',
      },
    },
  },
  {
    id: 'b763',
    path: '767-300',
    model: 'Models/767-300.ac',
    types: ['B763', 'B762', 'B764', 'B76F'],
    lengthM: 54.9,
    credit: '767-300 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'b752',
    path: '757-200',
    model: 'Models/757-200.ac',
    types: ['B752', 'B753'],
    lengthM: 47.3,
    credit: '757-200 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'crj7',
    path: 'CRJ700-family',
    model: 'Models/CRJ700.ac',
    types: ['CRJ7', 'CRJ9', 'CRJX', 'CRJ2', 'CRJ1'],
    lengthM: 32.3,
    credit: 'CRJ700 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'e145',
    path: 'Embraer-ERJ-145',
    model: 'Models/erj145.ac',
    types: ['E145', 'E135', 'E140', 'E45X'],
    lengthM: 29.9,
    credit: 'ERJ-145 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'at72',
    path: 'ATR-72-500',
    model: 'Models/ATR-72-500.ac',
    types: ['AT72', 'AT75', 'AT76', 'AT73', 'AT45', 'AT46', 'AT43'],
    lengthM: 27.2,
    credit: 'ATR 72-500 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'md80',
    path: 'MD-80',
    model: 'Models/mesh_airframe.ac',
    types: ['MD82', 'MD83', 'MD88', 'MD81', 'MD90'],
    lengthM: 45.1,
    credit: 'MD-80 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'b190',
    path: 'b1900d',
    model: 'Models/b1900d.ac',
    types: ['B190', 'BE19'],
    lengthM: 17.6,
    credit: 'Beechcraft 1900D — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'be20',
    path: 'Beechcraft-King-Air',
    model: 'Models/kingair.ac',
    types: ['BE20', 'BE9L', 'BE10', 'B350'],
    lengthM: 14.2,
    credit: 'King Air — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'c208',
    path: 'Cessna-208-Caravan',
    model: 'Models/caravan.ac',
    types: ['C208', 'C20T'],
    lengthM: 12.6,
    credit: 'Cessna 208 Caravan — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'pc12',
    path: 'Pilatus-PC-12',
    model: 'Models/pc12.ac',
    types: ['PC12'],
    lengthM: 14.4,
    credit: 'Pilatus PC-12 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'd228',
    path: 'do228',
    model: 'Models/do228.ac',
    types: ['D228'],
    lengthM: 16.6,
    credit: 'Dornier 228 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'l410',
    path: 'Let-L410',
    model: 'Models/l410.ac',
    types: ['L410'],
    lengthM: 14.4,
    credit: 'Let L-410 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'c750',
    path: 'CitationX',
    model: 'Models/CitationX.ac',
    types: ['C750', 'C56X', 'C68A', 'C525', 'C510'],
    lengthM: 22.0,
    credit: 'Citation X — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'c172',
    path: 'c172r',
    model: 'Models/c172-dpm.ac',
    types: ['C172', 'C182', 'C152', 'C150', 'C177'],
    lengthM: 8.28,
    credit: 'Cessna 172 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'da40',
    path: 'DA40',
    model: 'Models/da40.ac',
    types: ['DA40', 'DA42', 'DV20'],
    lengthM: 8.06,
    credit: 'Diamond DA40 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'ec35',
    path: 'ec135',
    model: 'Models/ec135.ac',
    types: ['EC35', 'EC45', 'H135', 'H145'],
    lengthM: 10.9,
    rotorcraft: true,
    credit: 'Eurocopter EC135 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'bo05',
    path: 'bo105',
    model: 'Models/bo105.ac',
    types: ['BO05', 'EC20', 'H120'],
    lengthM: 11.9,
    rotorcraft: true,
    credit: 'Bo 105 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'r44',
    path: 'R44',
    model: 'Models/r44.ac',
    types: ['R44', 'R22', 'R66'],
    lengthM: 9.0,
    rotorcraft: true,
    credit: 'Robinson R44 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 's76c',
    path: 'Sikorsky-76C',
    model: 'Models/s76c.ac',
    types: ['S76', 'S92', 'A139', 'AW39'],
    lengthM: 16.0,
    rotorcraft: true,
    credit: 'Sikorsky S-76C — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'as32',
    path: 'as332',
    model: 'Models/as332.ac',
    types: ['AS32', 'H225', 'EC25', 'S61'],
    lengthM: 19.5,
    rotorcraft: true,
    credit: 'Aerospatiale AS332 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'uh1',
    path: 'UH-1',
    model: 'Models/uh1.ac',
    types: ['UH1', 'B412', 'B212', 'B206', 'B407', 'B429'],
    lengthM: 12.9,
    rotorcraft: true,
    credit: 'UH-1 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'b738',
    path: '737-800',
    model: 'Models/737-800.ac',
    types: ['B738', 'B737', 'B739', 'B38M', 'B39M', 'B736', 'B735', 'B733', 'B734', 'B73H'],
    lengthM: 39.5,
    credit: '737-800 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'f27',
    path: 'Fokker-F.27',
    model: 'Models/f27.ac',
    types: ['F27', 'F50'],
    lengthM: 25.1,
    credit: 'Fokker F.27 — FlightGear FGAddon, GPL-2.0',
  },
];

// ---------------------------------------------------------------------------

/**
 * Downscale and re-encode a texture.
 *
 * WebP rather than PNG: these are photographic paint schemes, not line art, and
 * lossless PNG spends most of its bytes on noise the eye cannot see at this
 * size. Quality 82 is where the difference stops being findable by flicking
 * between the two at full zoom, and it is roughly a tenth of the bytes.
 *
 * `withoutEnlargement` matters — a 512-pixel placards sheet must not be blown
 * up to 2048 on the way through.
 */
async function shrink(data, base) {
  try {
    const encoded = await sharp(data)
      .resize({
        width: MAX_TEXTURE_PX,
        height: MAX_TEXTURE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer();
    return { data: encoded, name: `${base.replace(/\.[^.]+$/, '')}.webp` };
  } catch {
    /*
     * Pass it through untouched.
     *
     * A handful of FGAddon textures are in formats this encoder does not read
     * — old interlaced PNGs and the occasional mislabelled file. Losing the
     * whole aircraft over a texture that the *browser* can very likely still
     * decode is the wrong trade, and if it cannot, the pipeline already draws
     * that part in flat colour rather than failing.
     */
    return { data, name: base };
  }
}

async function fetchCached(url, file) {
  const target = join(CACHE, file);
  if (existsSync(target)) return readFile(target);

  await mkdir(dirname(target), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(target, buffer);
  return buffer;
}

/** Authors named in the aircraft's FlightGear `-set.xml`, if any. */
async function readSetAuthors(path) {
  try {
    const listing = (await fetchCached(`${FGADDON}/${path}/`, `${path}/listing.html`)).toString();
    const setFile = /<li><a href="([^"]+-set\.xml)">/.exec(listing)?.[1];
    if (!setFile) return null;

    const xml = (await fetchCached(`${FGADDON}/${path}/${setFile}`, `${path}/${setFile}`)).toString();
    const author = /<author>([\s\S]*?)<\/author>/i.exec(xml)?.[1];
    return author ? author.replace(/\s+/g, ' ').trim() : null;
  } catch {
    return null;
  }
}

/** FlightGear axes to ours. See the note at the top. */
function toAppAxes(v) {
  return [-v[2], -v[0], v[1]];
}

function roleOf(name, texture) {
  if (PROPDISC.test(name)) return 'disc';
  if (PROP.test(name)) return 'prop';
  if (TAILROTOR.test(name)) return 'tailRotor';
  if (ROTOR.test(name)) return 'mainRotor';
  if (GEAR.test(name)) return 'gear';
  if (texture && GEAR_TEXTURE.test(texture)) return 'gear';
  return 'hull';
}

/**
 * Turn one AC3D object into triangles in app axes.
 *
 * AC3D surfaces are n-gons; they are fanned. Normals are not stored in the
 * format at all, so they are computed here — averaged across faces that share
 * a position when the surface asks for smooth shading, and left per-face
 * otherwise. Skipping that and letting every face keep its own normal turns a
 * fuselage into a faceted tube.
 */
function triangulate(object, transform) {
  const world = object.verts.map((v) => toAppAxes(applyTransform(transform, v)));
  const tris = [];

  for (const surface of object.surfaces) {
    // Low nibble 0 is a filled polygon; 1 and 2 are construction lines.
    if ((surface.flags & 0x0f) !== 0) continue;
    if (surface.refs.length < 3) continue;
    const smooth = (surface.flags & 0x10) !== 0;

    for (let k = 1; k < surface.refs.length - 1; k++) {
      const a = surface.refs[0];
      const b = surface.refs[k];
      const c = surface.refs[k + 1];
      if (!a || !b || !c) continue;
      tris.push({
        smooth,
        v: [world[a.v], world[b.v], world[c.v]],
        uv: [
          [a.u, a.t],
          [b.u, b.t],
          [c.u, c.t],
        ],
      });
    }
  }
  return tris;
}

function faceNormal(p, q, r) {
  const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
  const vx = r[0] - q[0], vy = r[1] - q[1], vz = r[2] - q[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Average face normals across shared positions, for the smooth-shaded faces. */
function computeNormals(tris) {
  const accum = new Map();
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;

  for (const tri of tris) {
    if (!tri.smooth) continue;
    const n = faceNormal(tri.v[0], tri.v[1], tri.v[2]);
    for (const p of tri.v) {
      const k = key(p);
      const a = accum.get(k) ?? [0, 0, 0];
      a[0] += n[0];
      a[1] += n[1];
      a[2] += n[2];
      accum.set(k, a);
    }
  }

  for (const tri of tris) {
    const flat = faceNormal(tri.v[0], tri.v[1], tri.v[2]);
    tri.n = tri.v.map((p) => {
      const n = tri.smooth ? accum.get(key(p)) ?? flat : flat;
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      return [n[0] / len, n[1] / len, n[2] / len];
    });
  }
}

/** Weld identical (position, normal, uv) triples into an indexed mesh. */
function index(tris) {
  const map = new Map();
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (const tri of tris) {
    for (let c = 0; c < 3; c++) {
      const p = tri.v[c];
      const n = tri.n[c];
      const t = tri.uv[c];
      const k = `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)},${n[0].toFixed(2)},${n[1].toFixed(2)},${n[2].toFixed(2)},${t[0].toFixed(4)},${t[1].toFixed(4)}`;
      let id = map.get(k);
      if (id === undefined) {
        id = positions.length / 3;
        map.set(k, id);
        positions.push(p[0], p[1], p[2]);
        normals.push(n[0], n[1], n[2]);
        uvs.push(t[0], t[1]);
      }
      indices.push(id);
    }
  }
  return { positions, normals, uvs, indices };
}

export async function convert(entry, { quiet = false } = {}) {
  const say = (...a) => {
    if (!quiet) console.log(...a);
  };

  const acPath = `${entry.path}/${entry.model}`;
  const text = (await fetchCached(`${FGADDON}/${acPath}`, `${entry.id}/model.ac`)).toString('utf8');
  const { materials, root } = parseAc3d(text);

  // --- collect, grouped by role + texture + material ------------------------
  const groups = new Map();
  const textures = [];
  let discarded = 0;

  for (const { object, transform } of flatten(root)) {
    if (object.verts.length === 0) continue;
    if (DISCARD.test(object.name)) {
      discarded += object.verts.length;
      continue;
    }

    const tris = triangulate(object, transform);
    if (tris.length === 0) continue;

    const material = object.surfaces[0]?.material ?? 0;
    const texture = object.texture;
    const role = roleOf(object.name, texture);
    if (texture && !textures.includes(texture)) textures.push(texture);

    // Spinners are kept whole and separate: each one turns about its own hub.
    const side = role === 'hull' || role === 'gear' ? '' : `:${object.name}`;
    const key = `${role}${side}|${texture ?? ''}|${material}`;

    const group = groups.get(key) ?? { role, texture, material, name: object.name, tris: [] };
    group.tris.push(...tris);
    groups.set(key, group);
  }

  // --- validate the scale before anything is written ------------------------
  const box = [
    [Infinity, -Infinity],
    [Infinity, -Infinity],
    [Infinity, -Infinity],
  ];
  for (const group of groups.values()) {
    for (const tri of group.tris) {
      for (const p of tri.v) {
        for (let a = 0; a < 3; a++) {
          box[a][0] = Math.min(box[a][0], p[a]);
          box[a][1] = Math.max(box[a][1], p[a]);
        }
      }
    }
  }
  const measured = box[1][1] - box[1][0];
  const error = Math.abs(measured - entry.lengthM) / entry.lengthM;
  if (error > 0.06) {
    throw new Error(
      `${entry.id}: model is ${measured.toFixed(2)} m along the fuselage axis but the type is ` +
        `${entry.lengthM} m (${(error * 100).toFixed(1)}% out) — axes or units are wrong`,
    );

  /*
   * And the wings.
   *
   * The length check alone passes a fuselage with no wings, because a fuselage
   * is exactly as long as the aeroplane. Several FGAddon aircraft keep the
   * wings, stabilisers and engines in separate `.ac` files that the simulator
   * assembles from XML offsets — the 737-800 is one — and converting only the
   * main file yields a tube, correctly scaled, with nothing sticking out.
   *
   * No fixed-wing aircraft has a span under 60% of its length; most airliners
   * are near parity and gliders are several times over. A tube measures about
   * 10%, so the two populations are nowhere near each other and the threshold
   * needs no per-type data.
   */
  if (!entry.rotorcraft) {
    const span = box[0][1] - box[0][0];
    const ratio = span / measured;
    if (ratio < 0.6) {
      throw new Error(
        `${entry.id}: span is only ${(ratio * 100).toFixed(0)}% of length ` +
          `(${span.toFixed(1)} m across ${measured.toFixed(1)} m) — the wings are ` +
          `probably in a separate file this converter does not assemble`,
      );
    }
  }
  }

  /*
   * Centre on the airframe and scale to length 1.
   *
   * Centred on the *bounding box*, because that is what the procedural models
   * are centred on and what `shape.length` scales; the FlightGear datum is
   * usually the nose or an arbitrary station and using it would hang every
   * aircraft off its own nose.
   */
  const centre = [
    (box[0][0] + box[0][1]) / 2,
    (box[1][0] + box[1][1]) / 2,
    (box[2][0] + box[2][1]) / 2,
  ];
  const scale = 1 / measured;

  const parts = [];
  const chunks = [];
  let offset = 0;

  const push = (array, Ctor) => {
    const typed = Ctor.from(array);
    const buffer = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const at = offset;
    chunks.push(buffer);
    offset += buffer.length;
    return { offset: at, count: array.length };
  };

  for (const group of groups.values()) {
    for (const tri of group.tris) {
      tri.v = tri.v.map((p) => [
        (p[0] - centre[0]) * scale,
        (p[1] - centre[1]) * scale,
        (p[2] - centre[2]) * scale,
      ]);
    }
    computeNormals(group.tris);
    const mesh = index(group.tris);

    /*
     * Drop the flat helper sheets.
     *
     * FlightGear models carry a cast-shadow plane and sometimes a fog card:
     * untextured quads with exactly zero extent in one axis, lying under or
     * through the airframe. In a simulator that projects them onto the ground
     * they are invisible; here they render as a large black wedge across the
     * wing, which is what the 777 was doing — its was 62 m by 6 m and named
     * `Fuselage.001`, so no name rule would have caught it.
     *
     * The test is geometric and safe: a real surface on an aeroplane is never
     * a perfectly planar sheet with no texture. A wing is thin, not zero.
     */
    if (!group.texture) {
      const extent = [0, 1, 2].map((axis) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = axis; i < mesh.positions.length; i += 3) {
          lo = Math.min(lo, mesh.positions[i]);
          hi = Math.max(hi, mesh.positions[i]);
        }
        return hi - lo;
      });
      if (Math.min(...extent) < 1e-6) {
        say(`  ${entry.id}: dropped flat helper "${group.name}" (${extent.map((e) => e.toFixed(2)).join(' x ')})`);
        continue;
      }
    }

    // A spinner's geometry is moved to its own origin so it can be rotated in
    // place; everything else stays in airframe space.
    let origin = [0, 0, 0];
    const spins = group.role === 'prop' || group.role === 'mainRotor' || group.role === 'tailRotor';
    if (spins || group.role === 'disc') {
      const n = mesh.positions.length / 3;
      for (let i = 0; i < n; i++) {
        origin[0] += mesh.positions[i * 3];
        origin[1] += mesh.positions[i * 3 + 1];
        origin[2] += mesh.positions[i * 3 + 2];
      }
      origin = origin.map((c) => c / n);
      for (let i = 0; i < n; i++) {
        mesh.positions[i * 3] -= origin[0];
        mesh.positions[i * 3 + 1] -= origin[1];
        mesh.positions[i * 3 + 2] -= origin[2];
      }
    }

    const mat = materials[group.material] ?? { rgb: [1, 1, 1], emis: [0, 0, 0], trans: 0 };
    parts.push({
      role: group.role,
      name: group.name,
      texture: group.texture ? textures.indexOf(group.texture) : -1,
      color: mat.rgb.map((c) => +c.toFixed(4)),
      emissive: mat.emis.map((c) => +c.toFixed(4)),
      opacity: +(1 - mat.trans).toFixed(3),
      origin: origin.map((c) => +c.toFixed(6)),
      // Props turn about the nose axis; main rotors about the vertical.
      axis: group.role === 'mainRotor' ? [0, 0, 1] : group.role === 'tailRotor' ? [1, 0, 0] : [0, 1, 0],
      position: push(mesh.positions, Float32Array),
      normal: push(mesh.normals, Float32Array),
      uv: push(mesh.uvs, Float32Array),
      index: push(mesh.indices, Uint32Array),
    });
  }

  /*
   * --- textures -------------------------------------------------------------
   *
   * A texture name in an .ac file is relative to wherever the author happened
   * to have the file, so the same name lives under `Models/` on one aircraft
   * and in a `Liveries/` folder on the next. Each candidate is tried in turn,
   * and a texture that is nowhere to be found leaves its parts untextured
   * rather than failing the aircraft — a plain-coloured 380 is worth having,
   * and the alternative is no 380.
   */
  await mkdir(OUT, { recursive: true });
  const textureFiles = [];
  const missing = [];

  for (const texture of textures) {
    const base = texture.replace(/^.*[\\/]/, '');
    const candidates = [
      `${entry.path}/Models/${texture}`,
      `${entry.path}/${texture}`,
      `${entry.path}/Models/${base}`,
      `${entry.path}/Models/Liveries/${base}`,
      `${entry.path}/Liveries/${base}`,
      `${entry.path}/Models/Effects/${base}`,
      `${entry.path}/Textures/${base}`,
      `${entry.path}/Models/Textures/${base}`,
    ];

    let data = null;
    for (const candidate of candidates) {
      try {
        data = await fetchCached(`${FGADDON}/${candidate}`, `${entry.id}/${base}`);
        break;
      } catch {
        // Try the next place it might be.
      }
    }

    if (!data) {
      missing.push(texture);
      textureFiles.push(null);
      continue;
    }

    const hash = createHash('sha1').update(data).digest('hex').slice(0, 8);
    const encoded = await shrink(data, base.replace(/[^\w.-]/g, '_'));
    const name = `${entry.id}-${hash}-${encoded.name}`;
    await writeFile(join(OUT, name), encoded.data);
    textureFiles.push({ name, bytes: encoded.data.length });
  }

  // Renumber around anything that could not be found.
  const kept = [];
  const remap = textureFiles.map((t) => (t ? kept.push(t) - 1 : -1));
  for (const part of parts) part.texture = part.texture >= 0 ? remap[part.texture] ?? -1 : -1;
  if (missing.length) say(`  ${entry.id}: no texture found for ${missing.join(', ')}`);

  /*
   * --- operator liveries ----------------------------------------------------
   *
   * Emitted as loose files beside the model rather than packed into it: they
   * are alternatives, only ever one is wanted, and a visitor who never flies a
   * Qatar 777 should never download Qatar's paint. The renderer swaps the one
   * texture slot the livery occupies and keeps every geometry it already has.
   */
  const liveries = {};
  let liveryTexture = -1;

  if (entry.liveries) {
    const slot = textures.findIndex((t) => t.replace(/^.*[\\/]/, '') === entry.liveries.replaces);
    liveryTexture = slot >= 0 ? remap[slot] ?? -1 : -1;

    if (liveryTexture < 0) {
      say(`  ${entry.id}: livery slot ${entry.liveries.replaces} not in the model — skipped`);
    } else {
      const wanted = { NEUTRAL: entry.liveries.neutral, ...entry.liveries.byOperator };
      for (const [operator, file] of Object.entries(wanted)) {
        try {
          const data = await fetchCached(
            `${FGADDON}/${entry.path}/${entry.liveries.dir}/${file}.png`,
            `${entry.id}/livery-${file}.png`,
          );
          const encoded = await shrink(data, `${operator}.png`);
          const name = `${entry.id}-livery-${encoded.name}`;
          await writeFile(join(OUT, name), encoded.data);
          liveries[operator] = name;
        } catch {
          say(`  ${entry.id}: livery ${operator} (${file}) unavailable`);
        }
      }
      say(`  ${entry.id}: ${Object.keys(liveries).length} liveries`);
    }
  }

  /*
   * --- attribution ----------------------------------------------------------
   *
   * Not a nicety. These models are GPL-2.0, and the licence requires that the
   * copyright notices travel with them — so every notice file the upstream
   * aircraft carries is fetched and shipped beside the converted model. An
   * aircraft that has none is reported rather than silently accepted, because
   * a GPL work with no attributable author is a thing to look at by hand
   * before redistributing it.
   */
  const notices = [];
  for (const file of ['LICENSE', 'COPYING', 'AUTHORS', 'README', 'README.md', 'Thanks']) {
    try {
      const data = await fetchCached(
        `${FGADDON}/${entry.path}/${file}`,
        `${entry.id}/notice-${file}`,
      );
      const name = `credits/${entry.id}/${file}`;
      await mkdir(dirname(join(OUT, name)), { recursive: true });
      await writeFile(join(OUT, name), data);
      notices.push(name);
    } catch {
      // Not every aircraft carries every file.
    }
  }
  /*
   * Several aircraft carry no notice file at all and name their authors only
   * in the FlightGear `-set.xml`. That is still an attributable copyright
   * notice and still has to travel with the model, so it is pulled out and
   * written as one. An aircraft with neither is reported loudly: a GPL work
   * with no attributable author is something to look at by hand rather than
   * quietly redistribute.
   */
  if (notices.length === 0) {
    const authors = await readSetAuthors(entry.path);
    if (authors) {
      const name = `credits/${entry.id}/AUTHORS`;
      await mkdir(dirname(join(OUT, name)), { recursive: true });
      await writeFile(
        join(OUT, name),
        `${entry.path} — FlightGear FGAddon\n\nAuthors: ${authors}\n\n` +
          `Licensed GPL-2.0 as part of FGAddon. Attribution taken from the\n` +
          `aircraft's FlightGear -set.xml, which is the only notice upstream carries.\n`,
      );
      notices.push(name);
    } else {
      say(`  ${entry.id}: WARNING — no licence or author information upstream`);
    }
  }

  const header = {
    id: entry.id,
    source: `FlightGear FGAddon Aircraft/${entry.path}`,
    license: 'GPL-2.0',
    notices,
    lengthM: +measured.toFixed(3),
    textures: kept.map((t) => t.name),
    /** Texture slot an operator livery replaces, or -1 if the model has none. */
    liveryTexture,
    parts,
  };

  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const head = Buffer.alloc(8);
  head.write('PVM1', 0, 'ascii');
  head.writeUInt32LE(json.length + pad, 4);

  const blob = Buffer.concat([head, json, Buffer.alloc(pad), ...chunks]);
  await writeFile(join(OUT, `${entry.id}.pvm`), blob);

  const triangles = parts.reduce((s, p) => s + p.index.count / 3, 0);
  say(
    `${entry.id}: ${parts.length} parts, ${triangles.toLocaleString()} triangles, ` +
      `${(blob.length / 1024).toFixed(0)} kB + ${(kept.reduce((s, t) => s + t.bytes, 0) / 1024).toFixed(0)} kB textures ` +
      `(dropped ${discarded.toLocaleString()} interior verts)`,
  );

  return { header, bytes: blob.length, textureFiles: kept, triangles, notices, liveries };
}

/** The attribution page shipped beside the models. */
function creditsMarkdown(rows) {
  const lines = [
    '# 3D aircraft models',
    '',
    'The textured airframes in this directory are converted from the',
    '[FlightGear](https://www.flightgear.org/) add-on hangar (FGAddon) by',
    '`tools/fgmodel/convert.mjs`. They are **not** original to this project.',
    '',
    'Each is licensed **GPL-2.0** by its original authors. The converted form is a',
    'derivative work and carries the same licence; the upstream licence and author',
    'files are reproduced under `credits/<id>/`, and the full GPL text is in',
    '`LICENSE-GPL-2.0.txt`.',
    '',
    'Aircraft types with no model here are drawn by the procedural generator in',
    '`src/render/aircraft`, which is original work under the project licence.',
    '',
    '| Model | Types | Upstream | Licence | Notices |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const row of rows) {
    const url = `https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/${row.path}/`;
    lines.push(
      `| \`${row.id}\` | ${row.types.join(', ')} | [Aircraft/${row.path}](${url}) | GPL-2.0 | ${
        row.notices.length ? row.notices.map((n) => `\`${n}\``).join(', ') : '**none upstream**'
      } |`,
    );
  }

  lines.push('', 'To regenerate: `node tools/fgmodel/convert.mjs`.', '');
  return lines.join('\n');
}

async function main() {
  const wanted = process.argv.slice(2);
  const list = wanted.length ? AIRCRAFT.filter((a) => wanted.includes(a.id)) : AIRCRAFT;

  /*
   * The catalogue.
   *
   * `types` maps an ICAO type designator to a model id; `liveries` maps a model
   * id to the operator paint schemes that exist for it. Two maps rather than
   * one nested structure because the client reads them at different moments —
   * the type is needed to decide whether to download anything at all, and the
   * livery only once the operator is known.
   */
  /*
   * What to draw when the exact type has no model.
   *
   * Six hundred designators exist and two dozen have a converted airframe, so
   * the common case is a miss — and until now a miss meant the procedural
   * generator, which is a decent silhouette and unmistakably not a photograph
   * of an aeroplane. A real model of the wrong variant is closer to the truth
   * than an accurate drawing of a generic one: an unknown narrowbody jet looks
   * far more like a 737 than like anything a mesh generator produces.
   *
   * Keyed by airframe kind rather than by type, because that is the most the
   * client knows about a designator it has never heard of. Gliders have no
   * entry on purpose — the generated one is a long thin wing and a pod, which
   * is genuinely what they all look like, and no glider in the hangar is a
   * better stand-in for the rest than that.
   */
  const FALLBACKS = {
    jet: 'b738',
    turboprop: 'at72',
    piston: 'c172',
    rotorcraft: 'ec35',
  };

  const index = { types: {}, liveries: {}, fallback: {} };
  const rows = [];
  const skipped = [];
  for (const entry of list) {
    /*
     * One aircraft failing must not take the catalogue with it.
     *
     * The bounding-box check exists to catch a model whose wings live in a
     * separate file, or whose axes are wrong — both of which produce an
     * aeroplane scaled to nonsense. With a handful of aircraft, throwing was
     * the right response. With two dozen, it means one bad entry in the middle
     * of the list silently costs every entry after it, and the run that
     * reports the problem is also the run that shipped nothing.
     */
    let converted;
    try {
      converted = await convert(entry);
    } catch (error) {
      console.log(`  ${entry.id}: SKIPPED — ${error instanceof Error ? error.message : String(error)}`);
      skipped.push(entry.id);
      continue;
    }
    const { notices, liveries } = converted;
    index.types[entry.id] = index.types[entry.id] ?? entry.id;
    for (const type of entry.types) index.types[type] = entry.id;
    if (Object.keys(liveries).length > 0) index.liveries[entry.id] = liveries;
    rows.push({ ...entry, notices });
  }

  // Only offer a fallback that actually converted this run.
  for (const [kind, id] of Object.entries(FALLBACKS)) {
    if (rows.some((row) => row.id === id)) index.fallback[kind] = id;
    else console.log(`  fallback for ${kind} (${id}) did not convert — omitted`);
  }

  await writeFile(join(OUT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  await writeFile(join(OUT, 'CREDITS.md'), creditsMarkdown(rows));

  // The licence text itself, fetched once from an aircraft that ships it.
  const gpl = await fetchCached(`${FGADDON}/${list[0].path}/LICENSE`, 'gpl-2.0.txt').catch(
    () => null,
  );
  if (gpl) await writeFile(join(OUT, 'LICENSE-GPL-2.0.txt'), gpl);

  console.log(`wrote index.json, CREDITS.md and ${rows.length} model(s) to public/models`);
  if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
