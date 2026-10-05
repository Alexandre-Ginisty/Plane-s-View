/**
 * Passenger cabins by airframe class, built from real cabin dimensions.
 *
 * Build-time only, run by hand:
 *
 *   node tools/cabin/generate.mjs [class ...]
 *
 * Writes `public/models/<class>-cabin.pvm` and the three small texture sheets
 * they share. Original work under the project licence: nothing here comes
 * from a simulator's model, so there is nothing to attribute and no hull that
 * has no windows cut in it.
 *
 * ## Why generate them
 *
 * FlightGear's airliner cabins are either missing, bare tubes, or tubes with
 * the windows painted on. One regional-jet cabin had been standing in for
 * every airliner, so an A380 passenger sat in a 2-2 cabin 2.5 m wide. A real
 * cabin is a handful of numbers — width, abreast, seat and window pitch,
 * ceiling height — which is what this takes per class.
 *
 * ## Frame
 *
 * Written about the passenger's eye, the frame the cockpit pass draws in:
 * +X right, +Y up, +Z aft (the camera looks down −Z), metres. The eye is the
 * left window seat's: 0.48 m from the sidewall, 1.13 m above the floor, at the
 * row's window. Outside the windows is nothing: the airframe's own model is
 * drawn about the eye (see `shell.ts`) and shows through them.
 *
 * ## What is in it
 *
 * `cabin.mjs` builds the shell, the windows (rounded, with a reveal, a bezel
 * and shades), the seats (white headrest covers, a lit screen on each back, a
 * tray, a pocket), the overhead bins and the ceiling, and seats a cast in them:
 * `people.mjs` makes the passengers — stylised, a little exaggerated, and funny
 * — and a flight attendant with her trolley. `geometry.mjs` is the soft-solid
 * toolkit they are made with. `gallery.html` shows the people alone, under an
 * orbit camera, from the dev server:
 *
 *   /tools/cabin/gallery.html?only=sleeper,kid,cowboy&yaw=0.3&dist=3
 *
 * Everything is written about the eye, in the model's own frame, and baked with
 * a little occlusion so nothing is flat.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { bakeOcclusion } from '../fgmodel/occlusion.mjs';
import { packPvm } from '../fgmodel/pvmpack.mjs';
import { buildCabin, rng } from './cabin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'public', 'models');

/*
 * Each class: what a passenger of that cabin sees. `windowSill` is the
 * opening's lower edge above the floor; `ceiling` the height at the
 * centreline. `exteriors` is each airframe the cabin is drawn in, with the
 * eye in it (normalised, nose +Y, up +Z, about its centre): over the wing, in
 * the left window seat, at the height of that airframe's floor.
 */
const CLASSES = {
  n33: {
    label: 'single-aisle, 3-3',
    layout: [3, 3],
    aisle: 0.5,
    pitch: 0.79,
    ceiling: 2.2,
    windowSill: 0.86,
    windowH: 0.37,
    windowW: 0.25,
    types: 'A320 family, 737, 757, MD-80',
    exteriors: { a320: [-0.03853, 0.11966, -0.00884], b738: [-0.0345, 0.02284, -0.05466] },
  },
  r22: {
    label: 'regional, 2-2',
    layout: [2, 2],
    aisle: 0.4,
    pitch: 0.79,
    ceiling: 1.92,
    windowSill: 0.78,
    windowH: 0.33,
    windowW: 0.23,
    types: 'CRJ, ERJ, E-Jets, ATR, Dash 8 and the other regionals',
    exteriors: { crj7: [-0.0238, -0.02355, -0.02766], at72: [-0.03313, 0.01844, -0.04167] },
  },
  w242: {
    label: 'twin-aisle, 2-4-2',
    layout: [2, 4, 2],
    aisle: 0.55,
    pitch: 0.81,
    ceiling: 2.38,
    windowSill: 0.9,
    windowH: 0.38,
    windowW: 0.26,
    types: 'A330, A340, A300/310, MD-11, DC-10',
    exteriors: { md11: [-0.0383, 0.09707, -0.04379] },
  },
  w343: {
    label: 'twin-aisle, 3-4-3',
    layout: [3, 4, 3],
    aisle: 0.55,
    pitch: 0.81,
    ceiling: 2.45,
    windowSill: 0.92,
    windowH: 0.4,
    windowW: 0.27,
    types: '777, 747',
    exteriors: { b77w: [-0.0339, 0.04, -0.03365], b748: [-0.0342, 0.05, -0.048] },
  },
};

// --- textures -----------------------------------------------------------------

/** Three small tiling sheets: carpet, seat fabric, wall lining. Made, not borrowed. */
async function writeTextures() {
  const sheet = async (name, size, pixel) => {
    const data = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [r, g, b] = pixel(x, y);
        const i = (y * size + x) * 3;
        data[i] = Math.max(0, Math.min(255, r));
        data[i + 1] = Math.max(0, Math.min(255, g));
        data[i + 2] = Math.max(0, Math.min(255, b));
      }
    }
    await sharp(data, { raw: { width: size, height: size, channels: 3 } }).webp({ quality: 90 }).toFile(join(OUT, name));
  };
  const rand = rng(7);
  const noise = new Float32Array(256 * 256).map(() => rand());
  const n = (x, y, size) => noise[((y % size) * 256 + (x % size)) % noise.length];
  // Carpet: a dark blue-grey diamond pattern with a fleck of lighter yarn.
  await sheet('cabin-carpet.webp', 256, (x, y) => {
    const d = (Math.abs(((x % 64) - 32)) + Math.abs(((y % 64) - 32))) / 64;
    const base = d < 0.42 ? 1 : 0;
    const fleck = (n(x, y, 256) - 0.5) * 22;
    return [46 + base * 12 + fleck, 54 + base * 14 + fleck, 72 + base * 18 + fleck];
  });
  // Seat fabric: a blue weave.
  await sheet('cabin-fabric.webp', 256, (x, y) => {
    const warp = ((x >> 1) + (y >> 1)) % 2 ? 10 : -6;
    const fleck = (n(x, y, 256) - 0.5) * 26;
    return [30 + warp * 0.4 + fleck, 62 + warp + fleck, 118 + warp * 1.4 + fleck];
  });
  // Lining: warm off-white, faintly mottled.
  await sheet('cabin-wall.webp', 128, (x, y) => {
    const m = (n(x, y, 128) - 0.5) * 9;
    return [236 + m, 230 + m, 218 + m];
  });
}

// --- mesh building --------------------------------------------------------------

const MATERIALS = {
  carpet: { color: [1, 1, 1], texture: 'cabin-carpet.webp', repeat: true },
  runner: { color: [0.62, 0.62, 0.7], texture: 'cabin-carpet.webp', repeat: true },
  fabric: { color: [1, 1, 1], texture: 'cabin-fabric.webp', repeat: true },
  wall: { color: [1, 1, 1], texture: 'cabin-wall.webp', repeat: true },
  lower: { color: [0.62, 0.6, 0.56], texture: 'cabin-wall.webp', repeat: true },
  ceiling: { color: [0.94, 0.93, 0.9], texture: 'cabin-wall.webp', repeat: true },
  bin: { color: [0.9, 0.89, 0.86], texture: 'cabin-wall.webp', repeat: true },
  plastic: { color: [0.55, 0.56, 0.58] },
  dark: { color: [0.1, 0.1, 0.11] },
  frame: { color: [0.82, 0.81, 0.78] },
  curtain: { color: [0.18, 0.28, 0.5] },
  light: { color: [0.95, 0.95, 0.9], emissive: [0.55, 0.55, 0.5] },
  ceilingLight: { color: [0.95, 0.95, 0.9], emissive: [0.35, 0.35, 0.32] },
  cover: { color: [0.93, 0.93, 0.92] },
  seam: { color: [0.62, 0.61, 0.57] },
  belt: { color: [0.75, 0.74, 0.7] },
  metal: { color: [0.7, 0.7, 0.74] },
  steel: { color: [0.72, 0.73, 0.76] },
  white: { color: [0.95, 0.95, 0.95] },
  // A shade part way down lets some light through; one all the way down glows.
  shade: { color: [0.86, 0.85, 0.8], emissive: [0.22, 0.22, 0.2] },
  shadeClosed: { color: [0.88, 0.87, 0.82], emissive: [0.4, 0.4, 0.36] },
};

/** A flat colour, registered on first use: the people and what they hold are many colours of one kind of thing. */
function paint(rgb, opts = {}) {
  const hex = (c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0');
  const key = `p${rgb.map(hex).join('')}${opts.emissive ? `e${opts.emissive.map(hex).join('')}` : ''}`;
  MATERIALS[key] ??= { color: rgb, ...(opts.emissive ? { emissive: opts.emissive } : {}) };
  return key;
}

// --- packing --------------------------------------------------------------------

function packModel(id, cls, meshes) {
  const textures = [...new Set(Object.values(MATERIALS).map((m) => m.texture).filter(Boolean))];
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
  const pushBytes = (bytes) => {
    const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
    padded.set(bytes);
    const at = offset;
    chunks.push(padded);
    offset += padded.length;
    return { offset: at, count: bytes.length };
  };
  const live = Object.entries(meshes).filter(([, m]) => m.idx.length);
  // Contact shadow and the soft darkening where surfaces meet: baked, so the cabin is not flat.
  const casters = live.map(([, m]) => ({ positions: m.pos, normals: m.nrm, indices: m.idx }));
  const ao = bakeOcclusion(casters, casters.map(() => true));
  live.forEach(([key, m], i) => {
    const mat = MATERIALS[key];
    parts.push({
      role: 'hull',
      name: key,
      texture: mat.texture ? textures.indexOf(mat.texture) : -1,
      alpha: false,
      repeat: mat.repeat === true,
      color: mat.color,
      emissive: mat.emissive ?? [0, 0, 0],
      opacity: 1,
      origin: [0, 0, 0],
      axis: [0, 1, 0],
      position: push(m.pos, Float32Array),
      normal: push(m.nrm, Float32Array),
      uv: push(m.uv, Float32Array),
      index: push(m.idx, Uint32Array),
      ao: pushBytes(ao[i]),
    });
  });
  // The first airframe's eye is the file's own; every one is in `shellEyes`.
  const shellEyes = cls.exteriors;
  const header = {
    id,
    source: 'PlanesView, generated by tools/cabin/generate.mjs',
    license: 'MIT',
    notices: [],
    lengthM: 1,
    textures,
    liveryTexture: -1,
    rotorcraft: false,
    shellEye: Object.values(shellEyes)[0],
    displays: [],
    // Out of the window and a little down, at the wing and the ground.
    look: { yaw: 1.68, pitch: -0.26 },
    shellEyes,
    parts,
  };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const head = Buffer.alloc(8);
  head.write('PVM1', 0, 'ascii');
  head.writeUInt32LE(json.length + pad, 4);
  return { blob: packPvm(Buffer.concat([head, json, Buffer.alloc(pad), ...chunks])), triangles: parts.reduce((s, p) => s + p.index.count / 3, 0) };
}

await mkdir(OUT, { recursive: true });
await writeTextures();
const wanted = process.argv.slice(2);
for (const [name, cls] of Object.entries(CLASSES)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const id = `${name}-cabin`;
  const { blob, triangles } = packModel(id, cls, buildCabin(cls, id, paint).meshes);
  await writeFile(join(OUT, `${id}.pvm`), blob);
  console.log(`${id}: ${cls.label}, ${triangles.toLocaleString()} triangles, ${(blob.length / 1024).toFixed(0)} kB — ${cls.types}`);
}
