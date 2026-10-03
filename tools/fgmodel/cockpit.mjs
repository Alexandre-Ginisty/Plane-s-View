/**
 * FlightGear interiors -> PlanesView interior models: flight decks
 * (`<id>-cockpit.pvm`), passenger cabins (`<id>-cabin.pvm`) and cargo holds
 * (`<id>-cargo.pvm`).
 *
 * Build-time only, run by hand:
 *
 *   node tools/fgmodel/cockpit.mjs [aircraft or interior id ...]
 *
 * After `convert.mjs` and `combat.mjs`: a full `convert.mjs` run clears
 * `public/models`, and the eye is placed from the exterior model's header.
 *
 * The exterior converter throws the cockpit away — from outside it is weight
 * nobody sees. From the seat it is the whole view, and a procedural stand-in
 * reads as a dashboard drawn by a programmer. FGAddon's fighters carry
 * properly modelled, textured cockpits, so this assembles one from upstream.
 *
 * ## Assembly
 *
 * A FlightGear cockpit is a tree of XML files placing dozens of `.ac` files:
 * the tub, each console, each instrument, the seat, the stick. `xmltree.mjs`
 * walks that tree; each `.ac` is triangulated under the transform it
 * resolves to, and its textures are looked up beside it. Animations are not
 * run, so every switch and needle is in its rest pose, and variants the
 * simulator would pick between by condition are chosen here by `skip`.
 *
 * ## Frame
 *
 * Written about the pilot's design eye — the simulator's own internal view
 * offsets — in the frame the cockpit pass draws in: +X right, +Y up, +Z aft
 * (the camera looks down −Z), metres. The eye is also given in the exterior
 * model's normalised frame, so the airframe around the cockpit can be placed
 * from the same point instead of from a guess.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

import { applyTransform, flatten, parseAc3d } from './ac3d.mjs';
import { FGADDON, computeNormals, fetchCached, index, shrink } from './convert.mjs';
import { bakeOcclusion } from './occlusion.mjs';
import { decodeSgi, isSgi } from './sgi.mjs';
import { packPvm } from './pvmpack.mjs';
import { resolveModelTree } from './xmltree.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'public', 'models');
/** Shared instruments (`Aircraft/Instruments-3d/...`) live in FGData, not FGAddon. */
const FGDATA = 'https://gitlab.com/flightgear/fgdata/-/raw/next/Aircraft';
const FGDATA_DIRS = /^(Instruments-3d|Instruments|Generic)\//;

/*
 * Each entry is a whole aircraft model: its flight deck (`within`) is taken
 * complete, and the rest of the airframe — fuselage walls, floor, roof,
 * window frames, the nose — only where it is near the eye (`HULL`). The deck
 * alone is a set of panels floating in the sky; with the hull round it, the
 * only way to see out is through the windows.
 *
 * `displays` names the objects the live PFD, ND and EICAS are laid over
 * (`pick`: which of several, counted from the left); `drop`, objects left out.
 *
 * `eye` is the simulator's internal view 0 from the `-set.xml`: x right,
 * y up, z aft there; written here in the body frame, x aft, y right, z up.
 */
/** Matches no file: no part of the model is taken whole, all of it is cut to `HULL`. */
const NOTHING = /^$/;

/*
 * Objects that stand in the pilot's view here and not in the simulator's —
 * drawn there by a shader, or hidden by an animation this does not run.
 */
const DROP = {
  // Rows of rivet heads on a plain white card, meant for a bump-mapping effect.
  f15: /Fasteners/,
};

const COCKPITS = [
  {
    // The exterior model it belongs to (`public/models/<aircraft>.pvm`).
    aircraft: 'f16',
    types: ['F16', 'F16X'],
    root: 'f16/Models/F-16.xml',
    within: /Cockpit\/Main\/cockpit\.xml$/,
    /*
     * The simulator picks one of each pair by condition; this is the Block
     * 50/52 MLU fit. The helmet sight, the kneeboards and the pilot's own
     * body are left out: the camera is where his head is.
     */
    skip: /hmcs|pilot_internalview|pilot_externalview|kneeboard|hud_basic|f16_war|stick-B10|US_threat|EHSI|Effects|mfd-ext|chocks|irst|lights|Generic|nozzle|Armament/,
    // f16-base.xml, view 0.
    eye: { x: -4.105, y: 0, z: 0.8579 },
  },
  {
    aircraft: 'c750',
    types: ['C750', 'C56X', 'C68A', 'C525', 'C510'],
    root: 'CitationX/Models/Citation-X.xml',
    within: /flightdeck\.xml$|cabin\.xml$/,
    skip: /Effects|registration|shadow/,
    // CitationX-set.xml, view 0: the left seat.
    eye: { x: -7.0, y: -0.375, z: 0.41 },
  },
  {
    aircraft: 'b738',
    types: ['B738', 'B737', 'B739', 'B38M'],
    root: '737-800/Models/738.xml',
    within: /Models\/cockpit\.xml$/,
    skip: /Effects|lights|Services|Pushback|landinglight/,
    displays: [
      { id: 'pfd', name: /^pfdScreen$/ },
      { id: 'nd', name: /^ndScreenL$/ },
      { id: 'eicas', name: /^upperEICASScreen$/ },
    ],
    // 738-set.xml, view 0.
    eye: { x: -17.18, y: -0.51, z: 1.28 },
  },
  {
    aircraft: 'a320',
    types: ['A320', 'A319', 'A321', 'A20N', 'A21N'],
    root: 'A320-family/Models/A320-200-CFM.xml',
    within: /A320-interior\.xml$/,
    skip: /Effects|Lights|Services|Pushback|groundservices|marker|Airport|Generic/,
    // The optional head-up display: its "INOP" legend would hang in the sky.
    drop: /^hud/i,
    displays: [
      { id: 'pfd', name: /^pfd1\.screen$/ },
      { id: 'nd', name: /^ND\.screen$/ },
      { id: 'eicas', name: /^uecam\.screen$/ },
    ],
    // A320-200-CFM-set.xml, view 0.
    eye: { x: -16.193, y: -0.45, z: 1.403 },
  },
  {
    aircraft: 'at72',
    types: ['AT72', 'AT75', 'AT76'],
    root: 'ATR-72-500/Models/ATR-72-500.xml',
    within: /Flightdeck\/ATR-72-flightdeck\.xml$/,
    skip: /Lights|Generic|Airport|interior\.cargo/,
    displays: [{ id: 'nd', name: /^EHSI\.screen$/ }],
    // ATR-72-500-set.xml, view 0.
    eye: { x: -11, y: -0.6, z: -1.15 },
  },
  {
    aircraft: 'da40',
    types: ['DA40', 'DA42', 'DV20'],
    root: 'DA40/Models/da40ng.xml',
    within: /Interior\/interior\.xml$/,
    // The club panel (round gauges); the G1000 alternative would sit on top of it.
    skip: /Generic|lights\.xml|passenger|panel-g1000/,
    // Systems/views.xml, view 0.
    eye: { x: -1.64564, y: -0.25429, z: 0.63 },
  },
  {
    aircraft: 'ec35',
    types: ['EC35', 'EC45', 'H135', 'H145'],
    root: 'ec135/Models/ec135.xml',
    within: /analogflightdeck\.xml$|Models\/interior\.xml$/,
    skip: /HEMS|SX16|particle|RembrandtLights|rotoranimation|Generic|cpdsa_single/,
    // ec135p2-set.xml, view 0: the right seat, where it is flown from.
    eye: { x: 1.25, y: 0.42, z: 0.6 },
  },
  {
    aircraft: 'crj7',
    types: ['CRJ7', 'CRJ9', 'CRJX', 'CRJ2', 'CRJ1'],
    root: 'CRJ700-family/Models/CRJ700.xml',
    within: /Flightdeck\/CRJ700-flightdeck\.xml$|Interior\/CRJ700-interior\.xml$/,
    skip: /Effects|Lights|Generic|Airport|Pushback|Services/,
    displays: [
      { id: 'pfd', name: /^EFIS1$/ },
      { id: 'nd', name: /^EFIS2$/ },
      { id: 'eicas', name: /^EFIS3$/ },
    ],
    // CRJ700-set.xml, view 0.
    eye: { x: -13.305, y: -0.528, z: -0.48 },
  },
  {
    aircraft: 'e145',
    types: ['E145', 'E135', 'E140', 'E45X', 'E170', 'E75L', 'E75S', 'E190', 'E195'],
    root: 'Embraer-ERJ-145/Models/erj145.xml',
    within: /Interior\/interior\.xml$/,
    skip: /Effects|Lights|Generic|Airport|Pushback|Services/,
    displays: [
      { id: 'pfd', name: /^PFD\.back$/ },
      { id: 'nd', name: /^MFD\.back$/ },
      { id: 'eicas', name: /^EICAS\.back$/ },
    ],
    // No view 0 is written; the copilot's view (n=100) mirrored to the left seat.
    eye: { x: -11.18815, y: -0.54056, z: -0.09532 },
  },
  {
    aircraft: 'mrj9',
    types: ['MRJ'],
    root: 'MRJ/Models/MRJ90.xml',
    within: /Instruments\/panel\.xml$|cabin\.xml$/,
    skip: /Effects|Lights|Generic/,
    // MRJ90-STD-set.xml, view 0.
    eye: { x: -15.2, y: -0.5, z: 1.59 },
  },
  /*
   * The military aircraft. A fighter's cockpit is spread over its main
   * model and a dozen instrument files, and all of it is within arm's reach:
   * `within` is left at nothing and the whole airframe is cut to the space
   * about the seat. Eyes from each aircraft's view 0.
   */
  ...[
    ['ah64', ['H64'], 'apache/Models/apachemodel/apache-model.xml', { x: 3.7, y: -0.23, z: 2.65 }],
    ['f15', ['F15'], 'F-15/Models/F-15C.xml', { x: -5, y: 0, z: 1.401951318 }],
    ['f14', ['F14'], 'f-14b/Models/f-14b.xml', { x: -5.3, y: 0, z: 0.35 }],
    ['f18', ['F18', 'F18H', 'F18S'], 'f18/Models/f18.xml', { x: -3.4, y: 0, z: 0.97 }],
    ['m2k', ['MIR2'], 'Mirage-2000/Models/m2000-5.xml', { x: -2.9, y: 0, z: 0.0093 }],
    ['jas39', ['GRIF'], 'JAS39-Gripen/Models/gripen.xml', { x: -2.966, y: 0, z: 0.051 }],
    ['mig29', ['MG29'], 'Mig-29/Models/Mig-29.xml', { x: 4.6, y: 0, z: 1.2 }],
    ['su25', ['SU25'], 'Su-25/Models/Su-25.xml', { x: -3.45, y: 0, z: 2.7 }],
    ['mig21', ['MG21'], 'MiG-21bis/Models/MiG-21bis.xml', { x: -3.3, y: 0, z: 1.08 }],
    ['p51', ['P51'], 'p51d/Models/P-51D-25-NA.xml', { x: 3.28972, y: 0, z: 0.675 }],
    ['a10', ['A10'], 'A-10/Models/A-10-model.xml', { x: 3.2, y: 0, z: 1.5 }],
    ['f4u', ['F4U'], 'F4U/Models/F4U-1.xml', { x: 5.1, y: 0, z: 1.0 }],
  ].map(([aircraft, types, root, eye]) => ({
    aircraft,
    types,
    root,
    within: NOTHING,
    skip: /Effects|Lights\/|lights\/|lighting|lights?-(internal|external)|Generic|Airport|Pushback|Armament\/|[Ww]eapons\/|[Ss]tores\/|Payload|smoke|vapou?r|flame|exhaust|contrail|mainrotor|tailrotor|rotors?\/|trailer|bowser/,
    drop: DROP[aircraft],
    eye,
  })),
];

/*
 * Cabins: the same assembly about a passenger's eye, in a window seat. Only the
 * interior file is taken (`hull: false`): the airframe's skin is painted with
 * its windows, and from inside it would close every one of them. The cabin's
 * own sidewall carries the window openings, and the exterior model drawn round
 * it (see `shell.ts`) supplies the wing and the engine seen through them.
 *
 * `look` is where the view rests, radians: `yaw` to the left of the nose (the
 * simulator's heading offset), `pitch` above the horizon.
 */
const CABINS = [
  {
    aircraft: 'crj7',
    id: 'crj7-cabin',
    types: ['CRJ7', 'CRJ9', 'CRJX', 'CRJ2', 'CRJ1'],
    label: 'passenger cabin',
    root: 'CRJ700-family/Models/CRJ700.xml',
    within: /Interior\/CRJ700-interior\.xml$/,
    skip: /Effects|Lights|Generic|Airport|Pushback|Services/,
    hull: false,
    // crj700-views.xml's cabin view, moved aft to the row by the wing root.
    eye: { x: 0.6, y: 0, z: -0.47 },
    seat: {},
    /*
     * Also seated in airframes whose own cabins cannot be looked out of —
     * the ATR paints its windows on the sidewall, the 737-800 and the A320
     * have no cabin at all, the 757's seats are untextured black blocks: over the wing, where their wing and engine fill
     * the window. Eyes in each one's body frame.
     */
    exteriors: [
      // ATR-72-500-set.xml's cabin view, moved to the window row behind the propeller.
      { aircraft: 'at72', root: 'ATR-72-500/Models/ATR-72-500.xml', eye: { x: -0.5, y: -0.9, z: -1.15 } },
      // 738-set.xml's eye height, over the wing box.
      { aircraft: 'b738', root: '737-800/Models/738.xml', eye: { x: -1.0, y: -1.36, z: 1.3 } },
      // A320-200-CFM-set.xml's eye height, the overwing exit row.
      { aircraft: 'a320', root: 'A320-family/Models/A320-200-CFM.xml', eye: { x: -4.5, y: -1.45, z: 1.4 } },
      /*
       * The widebodies: the MD-11's own cabin is a bare tube without a seat in
       * it. A window seat over the wing root, its height found in that tube.
       */
      { aircraft: 'md11', root: 'MD-11/Models/MD-11-GE.xml', eye: { x: -4.4, y: -2.35, z: 6.98 } },
    ],
  },
  {
    aircraft: 'c750',
    id: 'c750-cabin',
    types: ['C750', 'C56X', 'C68A', 'C525', 'C510'],
    label: 'passenger cabin',
    root: 'CitationX/Models/Citation-X.xml',
    within: /cabin\.xml$/,
    skip: /Effects|registration|shadow/,
    hull: false,
    // CitationX-set.xml, "Passenger 1".
    eye: { x: -3.33, y: 0, z: 0.4 },
    seat: {},
  },
  {
    aircraft: 'md11',
    id: 'md11-cargo',
    types: ['MD11'],
    label: 'cargo hold',
    root: 'MD-11/Models/MD-11F-GE.xml',
    within: /Cabin\/cargo\.xml$/,
    skip: /Effects|Lights|Generic|Airport|Pushback|Services|Autopush|cabin\.xml/,
    hull: false,
    eye: { x: 0, y: 0, z: 0 },
    seat: { at: 0.5, standing: true, look: { yaw: 0.35, pitch: -0.12 } },
  },
];

const CREW_FILES = /pilots?\.xml|pilot_|crew|walker|Human/;
/*
 * Glass drawn with a reflection sheet — opaque in the file, blended by the
 * simulator's glass shader. Here it is plain glass, or the pilot looks at a
 * grey wall.
 */
const GLASS_TEXTURE = /glass|reflect/i;
/** Glass by name: a HUD's combiner, authored as an opaque white sheet. */
const GLASS_NAME = /combiner|hud.?(glass|screen|reflector)|glass/i;
/** A sheet the simulator draws a live picture into, blank until it does: left out. */
const BLANK_TEXTURE = /^tranbg\./i;

/*
 * Lining for what the author left bare. A wall, a roof or a post with no
 * texture renders as one flat colour, which from a seat reads as a cardboard
 * box; the simulator's lighting hides that, a plain Lambert shader does not.
 * Such surfaces get a fine, tileable grain — the texture of a moulded panel or
 * a cloth lining — at their authored colour, mapped by projection onto the
 * face's own plane so it needs no UVs. And the airframe's skin seen from the
 * inside, which would otherwise show the livery's white paint, is lined too.
 */
const LINING = '\0lining';
const LINING_FILE = 'cockpit-lining.webp';
const LINING_TILE_M = 0.25;
/** The skin's inner face: a mid cabin grey. */
const TRIM = [0.34, 0.35, 0.36];
/*
 * A bare surface's colour, no brighter than cabin trim ever is. Authors paint
 * walls and posts pure white and let the simulator's lighting grey them; under
 * a direct sun here they burn out to a white card.
 */
const CABIN_MAX = 0.62;
const cabin = (rgb) => {
  const peak = Math.max(...rgb);
  return peak > CABIN_MAX ? rgb.map((c) => (c * CABIN_MAX) / peak) : rgb;
};

async function liningTexture() {
  const size = 256;
  const px = Buffer.alloc(size * size);
  // Value noise over three octaves, wrapped so the tile repeats seamlessly.
  const hash = (x, y) => {
    const h = Math.sin(((x % 256) + 256) % 256 * 127.1 + (((y % 256) + 256) % 256) * 311.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const smooth = (x, y, cell) => {
    const n = size / cell;
    const gx = (x / size) * n;
    const gy = (y / size) * n;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const at = (i, j) => hash(((x0 + i) % n) + cell * 1000, ((y0 + j) % n) + cell * 2000);
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (at(0, 0) * (1 - sx) + at(1, 0) * sx) * (1 - sy) + (at(0, 1) * (1 - sx) + at(1, 1) * sx) * sy;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Mostly fine grain, a little mottle: moulded trim, not a cloudy sky.
      const v = 0.15 * smooth(x, y, 32) + 0.35 * smooth(x, y, 4) + 0.5 * hash(x, y);
      px[y * size + x] = Math.round(255 * (0.88 + 0.12 * v));
    }
  }
  return sharp(px, { raw: { width: size, height: size, channels: 1 } }).webp({ quality: 80 }).toBuffer();
}

/** The airframe kept about the eye, cockpit axes (+X right, +Y up, +Z aft), metres. */
const HULL = { x: [-2.2, 2.2], y: [-2.2, 1.8], z: [-4, 2.5] };
/** Never part of a cockpit: the crew (the camera is in the pilot's head), effects. */
const HULL_DROP = /pilot|crew|passenger|human|shadow|halo|flare|glow|corona|beam|contrail|exhaust|^prop|blade/i;

const CANVAS_PLACEHOLDER = /^canvas\.(png|rgb)$/i;
/** A display with nothing on it: dark glass. */
const SCREEN_OFF = [0.03, 0.035, 0.04];

const source = (path) => (FGDATA_DIRS.test(path) ? `${FGDATA}/${path}` : `${FGADDON}/${path}`);
const fetchPath = (path) => fetchCached(source(path), `cockpit/${path}`);

/** AC3D axes (y up, z toward the viewer) to cockpit axes about the eye. */
function toCockpit(p, eye) {
  // Body = (x, -z, y); cockpit = (body y, body z, body x) − eye.
  return [-p[2] - eye.y, p[1] - eye.z, p[0] - eye.x];
}

/*
 * Detail nobody can see from the seat. Some decks model every knob's knurling
 * — the A320's is 400,000 triangles, twenty megabytes — so a heavy group is
 * simplified to within a millimetre and a half of its shape, which at arm's
 * length is under a pixel. A deck still over `BUDGET` after that has every
 * sizeable group cut in proportion, at a looser two and a half millimetres.
 */
const HEAVY = 12_000;
const TOLERANCE_M = 0.0015;
const BUDGET = 120_000;
await MeshoptSimplifier.ready;

function simplified(mesh, target = HEAVY, tolerance = TOLERANCE_M) {
  const triangles = mesh.indices.length / 3;
  if (triangles <= target) return mesh;
  const positions = Float32Array.from(mesh.positions);
  const indices = Uint32Array.from(mesh.indices);
  // Collapses may cross texture seams (`Permissive`): the seams are what cut
  // a knob into a hundred islands, and the error bound still holds.
  const [kept] = MeshoptSimplifier.simplify(indices, positions, 3, Math.round(target * 3), tolerance, ['ErrorAbsolute', 'Permissive']);
  // Only the vertices still used, renumbered.
  const remap = new Map();
  const out = { positions: [], normals: [], uvs: [], indices: [] };
  for (const i of kept) {
    let j = remap.get(i);
    if (j === undefined) {
      j = remap.size;
      remap.set(i, j);
      out.positions.push(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
      out.normals.push(mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]);
      out.uvs.push(mesh.uvs[i * 2], mesh.uvs[i * 2 + 1]);
    }
    out.indices.push(j);
  }
  return out;
}

/**
 * A display face from its corners: centre, width and height in its own plane,
 * and the turn that faces a plane square to the boresight the same way
 * (`tilt` about x — positive leans the top towards the eye — then `yaw`).
 */
function measureFace(points) {
  if (points.length < 3) return null;
  const c = [0, 1, 2].map((a) => (Math.min(...points.map((p) => p[a])) + Math.max(...points.map((p) => p[a]))) / 2);
  // The plane's normal: the largest cross product about the centre, turned to the eye.
  let n = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i].map((v, k) => v - c[k]);
    const b = points[(i + 1) % points.length].map((v, k) => v - c[k]);
    const x = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const s = Math.sign(x[0] * n[0] + x[1] * n[1] + x[2] * n[2]) || 1;
    n = n.map((v, k) => v + s * x[k]);
  }
  const len = Math.hypot(...n);
  if (!len) return null;
  n = n.map((v) => v / len);
  if (n[0] * -c[0] + n[1] * -c[1] + n[2] * -c[2] < 0) n = n.map((v) => -v);
  const tilt = -Math.asin(Math.max(-1, Math.min(1, n[1])));
  const yaw = Math.atan2(n[0], n[2]);
  // The face's own axes: right = up(world) × n, normalised; up = n × right.
  let r = [n[2], 0, -n[0]];
  const rl = Math.hypot(...r) || 1;
  r = r.map((v) => v / rl);
  const u = [n[1] * r[2] - n[2] * r[1], n[2] * r[0] - n[0] * r[2], n[0] * r[1] - n[1] * r[0]];
  const along = (axis) => points.map((p) => (p[0] - c[0]) * axis[0] + (p[1] - c[1]) * axis[1] + (p[2] - c[2]) * axis[2]);
  const w = Math.max(...along(r)) - Math.min(...along(r));
  const h = Math.max(...along(u)) - Math.min(...along(u));
  const round = (v) => +v.toFixed(4);
  return { x: round(c[0]), y: round(c[1]), z: round(c[2]), w: round(w), h: round(h), tilt: round(tilt), yaw: round(yaw) };
}

/** A triangle whose face (by its winding) points away from the eye at the origin. */
function facesAway([p, q, r]) {
  const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const c = [(p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3, (p[2] + q[2] + r[2]) / 3];
  return n[0] * c[0] + n[1] * c[1] + n[2] * c[2] > 0;
}

/** Lining coordinates: the corners projected onto the face's dominant plane. */
function projected([p, q, r]) {
  const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
  const n = [Math.abs(u[1] * w[2] - u[2] * w[1]), Math.abs(u[2] * w[0] - u[0] * w[2]), Math.abs(u[0] * w[1] - u[1] * w[0])];
  const axis = n[0] >= n[1] && n[0] >= n[2] ? 0 : n[1] >= n[2] ? 1 : 2;
  const [i, j] = axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [0, 1];
  return [p, q, r].map((x) => [x[i] / LINING_TILE_M, x[j] / LINING_TILE_M]);
}

/*
 * A passenger's seat, found in the cabin rather than guessed. The simulator's
 * cabin views are placed for looking down the aisle, and its window seats
 * (where there are any) sit with the head in the wall; so the converter looks:
 * a ray down the centreline finds the floor, rays out of the side at eye
 * height along the cabin find the sidewall and the gaps in it — the windows —
 * and the eye is put in the seat beside the window nearest the station asked
 * for, a little aft of it, as far off the wall as a seated head is.
 */
const SEATED_EYE_M = 1.13;
const STANDING_EYE_M = 1.62;
const HEAD_OFF_WALL_M = 0.48;

function rayHit(tris, o, d, far = 6) {
  let best = far;
  for (const [a, b, c] of tris) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const t0 = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
    const u = (t0[0] * p[0] + t0[1] * p[1] + t0[2] * p[2]) * inv;
    if (u < 0 || u > 1) continue;
    const q = [t0[1] * e1[2] - t0[2] * e1[1], t0[2] * e1[0] - t0[0] * e1[2], t0[0] * e1[1] - t0[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
    if (t > 1e-4 && t < best) best = t;
  }
  return best < far ? best : Infinity;
}

/**
 * Where the eye goes, cockpit axes about the rough eye, and where it looks.
 * Null when the cabin has no floor under the centreline to stand on.
 */
function findSeat(spec, solid) {
  const seat = spec.seat;
  let cx = -spec.eye.y;
  let cy = 0;
  let want = seat.station ?? 0;
  if (seat.at !== undefined) {
    // A fraction of the cabin's length from its front: the rough eye need not be known.
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const tri of solid) for (const p of tri) for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], p[k])), (hi[k] = Math.max(hi[k], p[k]));
    cx = (lo[0] + hi[0]) / 2;
    cy = (lo[1] + hi[1]) / 2;
    want = lo[2] + seat.at * (hi[2] - lo[2]);
  }
  const floor = rayHit(solid, [cx, cy, want], [0, -1, 0]);
  if (!Number.isFinite(floor)) return null;
  const y = cy - floor + (seat.standing ? STANDING_EYE_M : SEATED_EYE_M);
  if (seat.standing) return { eye: [cx, y, want], look: seat.look ?? { yaw: 0, pitch: -0.1 }, windows: 0 };

  const side = seat.side ?? -1;
  const span = seat.span ?? 3;
  const reach = [];
  for (let z = want - span; z <= want + span + 1e-9; z += 0.02) reach.push([z, rayHit(solid, [cx, y - 0.04, z], [side, 0, 0])]);
  const walls = reach.map(([, t]) => t).filter(Number.isFinite).sort((a, b) => a - b);
  if (!walls.length) return null;
  const wall = walls[Math.floor(walls.length * 0.3)];
  // Open where the ray gets out, or goes well past the wall (into a window's reveal).
  const windows = [];
  let start = null;
  reach.forEach(([z, t], i) => {
    const open = !Number.isFinite(t) || t > wall + 0.12;
    if (open && start === null) start = z;
    if ((!open || i === reach.length - 1) && start !== null) {
      const end = open ? z : z - 0.02;
      if (end - start >= 0.12 && end - start <= 0.7) windows.push((start + end) / 2);
      start = null;
    }
  });
  const window = windows.sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0];
  if (window === undefined) console.log(`  ${spec.id}: no window found in the sidewall — the eye is placed by the wall`);
  const z = (window ?? want) + (seat.aft ?? 0.06);
  const eye = [cx + side * (wall - HEAD_OFF_WALL_M), y, z];
  /*
   * Out of the window and a little down and back, the way a passenger looks
   * out: at the wing and the ground rather than the horizon.
   */
  const yaw = -side * (seat.yaw ?? 1.68);
  return { eye, look: { yaw: +yaw.toFixed(3), pitch: seat.pitch ?? -0.26 }, windows: windows.length, wall };
}

const within = (box) => (p) => p[0] >= box.x[0] && p[0] <= box.x[1] && p[1] >= box.y[0] && p[1] <= box.y[1] && p[2] >= box.z[0] && p[2] <= box.z[1];

async function convertCockpit(spec) {
  const id = spec.id ?? `${spec.aircraft}-cockpit`;
  const inHull = spec.hull === false ? () => false : within(spec.hull ?? HULL);
  // The crew is never modelled into a cockpit seen from a seat: the camera is where a head is.
  const skip = new RegExp(`${spec.skip.source}|${CREW_FILES.source}`, 'i');
  const tree = await resolveModelTree(spec.root, async (p) => (await fetchPath(p)).toString('utf8'), { skip, within: spec.within });

  const groups = new Map();
  const textures = [];
  let hidden = 0;
  /** Display faces found, by spec entry: each a list of objects' corners. */
  const faces = (spec.displays ?? []).map(() => []);

  for (const { ac, transform, inside } of tree) {
    if (!inside && spec.hull === false) continue;
    let parsed;
    try {
      parsed = parseAc3d((await fetchPath(ac)).toString('utf8'));
    } catch (error) {
      console.log(`  ${id}: ${ac} unavailable (${error.message})`);
      continue;
    }
    const folder = posix.dirname(ac);

    for (const { object, transform: local } of flatten(parsed.root)) {
      if (object.verts.length === 0) continue;
      if (!inside && (HULL_DROP.test(object.name) || HULL_DROP.test(object.texture ?? ''))) continue;
      if (spec.drop?.test(object.name)) continue;
      const world = object.verts.map((v) => toCockpit(applyTransform(transform, applyTransform(local, v)), spec.eye));
      if (inside) (spec.displays ?? []).forEach((d, i) => d.name.test(object.name) && faces[i].push(world));
      if (process.env.COCKPIT_FRONT) {
        // Debugging aid: what stands in the view ahead.
        const ahead = world.filter(([x, y, z]) => z < -0.1 && z > -1.2 && Math.abs(x) < 0.35 && y < 0 && y > -0.9).length;
        if (ahead > 0) console.log(`  ahead: ${String(ahead).padStart(4)} ${object.name} ${object.texture ?? "-"} ${ac} mats ${[...new Set(object.surfaces.map((f) => f.material))].map((m) => parsed.materials[m]?.rgb.join("/")).join(" ")}`);
      }
      // A Canvas display's stand-in sheet ("CDU", "DED panel") is what the
      // simulator draws the live page over; here the screen is simply off.
      const placeholder = Boolean(object.texture && CANVAS_PLACEHOLDER.test(posix.basename(object.texture)));
      const texture = object.texture && !placeholder ? posix.normalize(posix.join(folder, object.texture)) : null;

      for (const surface of object.surfaces) {
        if ((surface.flags & 0x0f) !== 0 || surface.refs.length < 3) continue;
        const authored = parsed.materials[surface.material] ?? { rgb: [1, 1, 1], emis: [0, 0, 0], trans: 0 };
        if (object.texture && BLANK_TEXTURE.test(posix.basename(object.texture))) continue;
        const glass = object.texture ? GLASS_TEXTURE.test(posix.basename(object.texture)) : GLASS_NAME.test(object.name);
        const mat = placeholder ? { ...authored, rgb: SCREEN_OFF } : glass ? { ...authored, trans: Math.max(authored.trans, 0.9) } : authored;
        // Pick boxes and hot spots: fully transparent, there to be clicked.
        if (mat.trans >= 0.99) {
          hidden++;
          continue;
        }
        const opaque = mat.trans <= 0.02;
        const groupFor = (tex, m) => {
          const key = `${tex ?? ''}|${m.rgb}|${m.emis}|${m.trans}`;
          let group = groups.get(key);
          if (!group) {
            if (tex && !textures.includes(tex)) textures.push(tex);
            group = { name: object.name, texture: tex, mat: m, tris: [] };
            groups.set(key, group);
          }
          return group;
        };
        const bare = !texture && opaque && !placeholder;
        const own = groupFor(bare ? LINING : texture, bare ? { ...mat, rgb: cabin(mat.rgb) } : mat);
        const smooth = (surface.flags & 0x10) !== 0;
        const [a, ...rest] = surface.refs;
        for (let k = 0; k < rest.length - 1; k++) {
          const b = rest[k];
          const c = rest[k + 1];
          // The airframe only near the eye; any corner in keeps a triangle whole.
          if (!inside && !inHull(world[a.v]) && !inHull(world[b.v]) && !inHull(world[c.v])) continue;
          const v = [world[a.v], world[b.v], world[c.v]];
          let group = own;
          let uv = [
            [a.u, a.t],
            [b.u, b.t],
            [c.u, c.t],
          ];
          // The skin from inside: its face turned away from the eye.
          const skin = !inside && opaque && facesAway(v);
          if (skin) group = groupFor(LINING, { rgb: TRIM, emis: [0, 0, 0], trans: 0 });
          if (group.texture === LINING) uv = projected(v);
          group.tris.push({ smooth, v, uv });
        }
      }
    }
  }

  // --- a passenger's seat ------------------------------------------------------
  let look = spec.look ?? null;
  if (spec.seat) {
    const solid = [...groups.values()].filter((g) => g.mat.trans <= 0.02).flatMap((g) => g.tris.map((t) => t.v));
    const found = findSeat(spec, solid);
    if (!found) {
      console.log(`  ${id}: no floor under the centreline — the eye stays where it was given`);
    } else {
      const [dx, dy, dz] = found.eye;
      for (const g of groups.values()) for (const t of g.tris) t.v = t.v.map(([x, y, z]) => [x - dx, y - dy, z - dz]);
      // Cockpit axes (x right, y up, z aft) are body (y, z, x).
      spec.eye = { x: spec.eye.x + dz, y: spec.eye.y + dx, z: spec.eye.z + dy };
      look = found.look;
      console.log(`  ${id}: seat at ${found.eye.map((v) => v.toFixed(2)).join(', ')} (${found.windows} windows, wall ${found.wall?.toFixed(2) ?? '-'} m off the centreline)`);
    }
  }

  // --- textures, beside the .ac that names them -----------------------------
  await mkdir(OUT, { recursive: true });
  // Last run's textures go first: a sheet no longer used must not ship.
  for (const f of await readdir(OUT)) if (f.startsWith(`${id}-`)) await rm(join(OUT, f));
  const folders = [...new Set(tree.map((t) => posix.dirname(t.ac)))];
  if (spec.within !== NOTHING && tree.some((t) => !t.inside) && !tree.some((t) => t.inside)) console.log(`  ${id}: nothing matched \`within\` — the flight deck is missing`);
  const files = [];
  for (const texture of textures) {
    if (texture === LINING) {
      const data = await liningTexture();
      await writeFile(join(OUT, LINING_FILE), data);
      files.push({ name: LINING_FILE, alpha: false, bytes: data.length });
      continue;
    }
    const base = posix.basename(texture);
    const dir = posix.dirname(texture);
    // Authors' relative paths are often wrong and the simulator's texture
    // search hides it; search the same way, through every folder of the tree.
    const candidates = [...new Set([texture, `${dir}/Textures/${base}`, `${posix.dirname(dir)}/Textures/${base}`, ...folders.map((f) => `${f}/${base}`)])];
    let data = null;
    for (const candidate of candidates) {
      try {
        data = await fetchPath(candidate);
        break;
      } catch {
        // Try the next place it might be.
      }
    }
    if (!data) {
      console.log(`  ${id}: no texture ${texture}`);
      files.push(null);
      continue;
    }
    let image = data;
    if (isSgi(data)) {
      const { width, height, rgba } = decodeSgi(data);
      image = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
    }
    let alpha = false;
    try {
      alpha = !(await sharp(image).stats()).isOpaque;
    } catch {
      // Unreadable here; shipped as it is.
    }
    const hash = createHash('sha1').update(data).digest('hex').slice(0, 8);
    const encoded = await shrink(image, base.replace(/\.rgba?$/i, '.png').replace(/[^\w.-]/g, '_'));
    const name = `${id}-${hash}-${encoded.name}`;
    await writeFile(join(OUT, name), encoded.data);
    files.push({ name, alpha, bytes: encoded.data.length });
  }
  const kept = [];
  const remap = files.map((f) => (f ? kept.push(f) - 1 : -1));

  // --- geometry -------------------------------------------------------------
  const parts = [];
  const chunks = [];
  let offset = 0;
  const push = (array, Ctor) => {
    const typed = Ctor.from(array);
    const at = offset;
    chunks.push(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength));
    offset += typed.byteLength;
    return { offset: at, count: array.length };
  };
  // Bytes, padded to four so the next float array stays aligned.
  const pushBytes = (bytes) => {
    const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
    padded.set(bytes);
    const at = offset;
    chunks.push(padded);
    offset += padded.length;
    return { offset: at, count: bytes.length };
  };

  const meshes = new Map();
  for (const group of groups.values()) {
    if (group.tris.length === 0) continue;
    computeNormals(group.tris);
    // A cabin is seen from further off than a panel, and repeats its seats by the hundred: a looser bound.
    meshes.set(group, spec.seat ? simplified(index(group.tris), 6000, 0.004) : simplified(index(group.tris)));
  }
  const total = [...meshes.values()].reduce((n, m) => n + m.indices.length / 3, 0);
  if (total > BUDGET) {
    const ratio = BUDGET / total;
    for (const [group, m] of meshes) {
      const n = m.indices.length / 3;
      if (n > 1500) meshes.set(group, simplified(m, Math.max(1500, Math.round(n * ratio)), 0.0025));
    }
  }

  // Contact shadow: glass neither casts it nor receives it.
  const solid = [...meshes.keys()].map((g) => g.mat.trans <= 0.02);
  const casters = [...meshes.values()].map((m, i) => (solid[i] ? m : { positions: m.positions, normals: m.normals, indices: [] }));
  const started = Date.now();
  const occlusion = bakeOcclusion(casters, solid);
  console.log(`  ${id}: occlusion baked in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  let meshIndex = 0;
  for (const [group, mesh] of meshes) {
    const ao = occlusion[meshIndex++];
    const slot = group.texture ? remap[textures.indexOf(group.texture)] : -1;
    parts.push({
      role: 'hull',
      name: group.name,
      texture: slot,
      alpha: slot >= 0 && kept[slot].alpha,
      /** Tiled: the lining's coordinates run on past 0–1. */
      repeat: group.texture === LINING,
      /*
       * Lamps off, and no perfect black. Warning lights and backlit legends
       * are authored glowing and switched off by animations this does not
       * run, so in the rest pose every one of them would be lit white. And a
       * pure black material shows no shading at all — the simulator lifts it
       * with an ambient term this renderer does not have — so the HUD posts
       * and the coaming read as holes in the picture.
       */
      color: group.mat.rgb.map((c) => +Math.max(c, 0.06).toFixed(4)),
      emissive: [0, 0, 0],
      // Glass stays glass: the simulator's windscreens are tinted for its
      // lighting, and at their authored opacity they read as fog here.
      opacity: group.mat.trans > 0.02 ? +Math.min(0.22, Math.max(0.06, 1 - group.mat.trans)).toFixed(3) : 1,
      origin: [0, 0, 0],
      axis: [0, 1, 0],
      position: push(mesh.positions, Float32Array),
      normal: push(mesh.normals, Float32Array),
      uv: push(mesh.uvs, Float32Array),
      index: push(mesh.indices, Uint32Array),
      /** Openness to the sky per vertex, 0–255: multiplied into the colour. */
      ao: pushBytes(ao),
    });
  }

  // --- display faces ----------------------------------------------------------
  const displays = [];
  (spec.displays ?? []).forEach((d, i) => {
    const found = faces[i].map(measureFace).filter(Boolean).sort((a, b) => a.x - b.x);
    const face = found[d.pick ?? 0];
    if (face) displays.push({ id: d.id, ...face });
    else console.log(`  ${id}: display ${d.id} (${d.name}) not found`);
  });

  // --- the eye in the exterior model's frame --------------------------------
  async function eyeIn(aircraft, eye, rootFrame) {
    const exterior = join(OUT, `${aircraft}.pvm`);
    if (!existsSync(exterior)) return null;
    const buf = await readFile(exterior);
    const header = JSON.parse(buf.subarray(8, 8 + buf.readUInt32LE(4)).toString('utf8').replace(/\0+$/, ''));
    if (!header.centreM) {
      console.log(`  ${id}: ${aircraft}.pvm has no centreM — reconvert it to place the airframe`);
      return null;
    }
    // The exterior was converted from the root `.ac` as it is, without the
    // root file's own offsets: take the eye back into that frame.
    const { r, l } = rootFrame;
    const d = [eye.x - l[0], eye.z - l[1], -eye.y - l[2]];
    const ac = [r[0] * d[0] + r[3] * d[1] + r[6] * d[2], r[1] * d[0] + r[4] * d[1] + r[7] * d[2], r[2] * d[0] + r[5] * d[1] + r[8] * d[2]];
    // App axes: x right, y nose, z up.
    const app = [-ac[2], -ac[0], ac[1]];
    return app.map((c, i) => +((c - header.centreM[i]) / header.lengthM).toFixed(5));
  }
  const shellEye = await eyeIn(spec.aircraft, spec.eye, tree.rootFrame);
  /*
   * Other airframes this interior is seated in (`exteriors`): its windows are
   * what the eye looks through and the skin behind them is cleared, so the
   * wing outside can be another type's.
   */
  const shellEyes = {};
  for (const ext of spec.exteriors ?? []) {
    const { rootFrame } = await resolveModelTree(ext.root, async (p) => (await fetchPath(p)).toString('utf8'), { skip: { test: (p) => p !== ext.root } });
    shellEyes[ext.aircraft] = await eyeIn(ext.aircraft, ext.eye, rootFrame);
  }

  const credits = join(OUT, 'credits', spec.aircraft);
  const notices = existsSync(credits) ? (await readdir(credits)).map((f) => `credits/${spec.aircraft}/${f}`) : [];

  const header = {
    id,
    source: `FlightGear FGAddon Aircraft/${spec.root}`,
    license: 'GPL-2.0',
    notices,
    lengthM: 1,
    textures: kept.map((t) => t.name),
    liveryTexture: -1,
    rotorcraft: false,
    /** Where the eye sits in the exterior model: normalised, nose +Y, up +Z, about its centre. */
    shellEye,
    /** Where the live displays go: centre, size, tilt and yaw of each face, cockpit axes. */
    displays,
    /** Where the view rests, radians: yaw left of the nose, pitch up. */
    look,
    /** The same eye in the other airframes this interior is drawn in. */
    shellEyes,
    parts,
  };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const head = Buffer.alloc(8);
  head.write('PVM1', 0, 'ascii');
  head.writeUInt32LE(json.length + pad, 4);
  const blob = packPvm(Buffer.concat([head, json, Buffer.alloc(pad), ...chunks]));
  await writeFile(join(OUT, `${id}.pvm`), blob);

  /*
   * The attribution row. Same licence and authors as the aircraft, plus
   * FGData's shared instruments, which are GPL-2.0 as well.
   */
  const creditsPath = join(OUT, 'CREDITS.md');
  if (existsSync(creditsPath)) {
    const row =
      `| \`${id}\` | ${spec.types.join(', ')} (${spec.label ?? 'cockpit view'}) | [Aircraft/${posix.dirname(spec.root)}](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/${posix.dirname(spec.root)}/)` +
      ` and FGData \`Aircraft/Instruments-3d\` | GPL-2.0 | ${notices.map((n) => `\`${n}\``).join(', ')} |`;
    // This row replaced, and rows for files no longer shipped (an interior
    // dropped or renamed) dropped: a credit for nothing is noise.
    const shipped = (l) => {
      const m = /^\| `([^`]+)`/.exec(l);
      return !m || existsSync(join(OUT, `${m[1]}.pvm`));
    };
    const lines = (await readFile(creditsPath, 'utf8')).split('\n').filter((l) => !l.startsWith(`| \`${id}\``) && shipped(l));
    const lastRow = lines.findLastIndex((l) => l.startsWith('| `'));
    lines.splice(lastRow + 1, 0, row);
    await writeFile(creditsPath, lines.join('\n'));
  }

  const triangles = parts.reduce((s, p) => s + p.index.count / 3, 0);
  console.log(
    `${id}: ${tree.length} files, ${parts.length} parts, ${triangles.toLocaleString()} triangles, ` +
      `${(blob.length / 1024).toFixed(0)} kB + ${(kept.reduce((s, t) => s + t.bytes, 0) / 1024).toFixed(0)} kB textures ` +
      `(${hidden} hidden faces dropped), eye in airframe ${JSON.stringify(shellEye)}`,
  );
}

const wanted = process.argv.slice(2);
for (const spec of [...COCKPITS, ...CABINS].filter((c) => !wanted.length || wanted.includes(c.id ?? c.aircraft) || wanted.includes(c.aircraft))) {
  await convertCockpit(spec);
}
