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
 * Seats in rows, with headrests, armrests, a tray table and a seat pocket on
 * the back of each, and passengers in most of them, sitting still. Overhead
 * bins with their door lines, a service strip with lights, a ceiling, a
 * carpeted floor with its aisle runner, a sidewall of window bays — an
 * opening, a frame and a reveal each — and, at either end, a bulkhead with
 * its curtain.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { bakeOcclusion } from '../fgmodel/occlusion.mjs';
import { packPvm } from '../fgmodel/pvmpack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'public', 'models');

const EYE_ABOVE_FLOOR = 1.13;
const WALL_FROM_EYE = 0.48;
const SEAT_W = 0.45;
const SEAT_DEPTH = 0.46;
const WINDOW_PITCH = 0.508;
/** Rows drawn ahead of and behind the eye's own. */
const ROWS_EACH_WAY = 14;

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

// --- deterministic noise ------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

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
  frame: { color: [0.78, 0.77, 0.74] },
  curtain: { color: [0.18, 0.28, 0.5] },
  light: { color: [0.95, 0.95, 0.9], emissive: [0.55, 0.55, 0.5] },
  skin1: { color: [0.86, 0.68, 0.56] },
  skin2: { color: [0.62, 0.44, 0.33] },
  skin3: { color: [0.4, 0.28, 0.2] },
  hairA: { color: [0.12, 0.09, 0.07] },
  hairB: { color: [0.45, 0.32, 0.18] },
  hairC: { color: [0.62, 0.6, 0.58] },
  cloth1: { color: [0.2, 0.25, 0.35] },
  cloth2: { color: [0.55, 0.2, 0.2] },
  cloth3: { color: [0.25, 0.4, 0.3] },
  cloth4: { color: [0.6, 0.58, 0.5] },
  cloth5: { color: [0.15, 0.15, 0.17] },
};

class Mesh {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.idx = [];
  }
  vertex(p, n, uv) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(uv[0], uv[1]);
    return this.pos.length / 3 - 1;
  }
  /** A quad a→b→c→d, seen from the side its normal points to. UVs by metres × `tile`. */
  quad(a, b, c, d, n, tile = 1) {
    const ex = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ey = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const lu = Math.hypot(...ex) * tile;
    const lv = Math.hypot(...ey) * tile;
    const i0 = this.vertex(a, n, [0, 0]);
    const i1 = this.vertex(b, n, [lu, 0]);
    const i2 = this.vertex(c, n, [lu, lv]);
    const i3 = this.vertex(d, n, [0, lv]);
    // Wound so the front faces the normal.
    const cross = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
    const facing = cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2];
    if (facing >= 0) this.idx.push(i0, i1, i2, i0, i2, i3);
    else this.idx.push(i0, i2, i1, i0, i3, i2);
  }
  /** An axis-aligned box about a centre. */
  box(cx, cy, cz, sx, sy, sz, tile = 1) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], tile);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], tile);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], tile);
    this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], tile);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], tile);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], tile);
  }
  /** A low-poly ellipsoid: an icosphere scaled, for heads and hair. */
  ellipsoid(cx, cy, cz, rx, ry, rz) {
    const t = (1 + Math.sqrt(5)) / 2;
    const base = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ].map((v) => {
      const l = Math.hypot(...v);
      return v.map((c) => c / l);
    });
    let faces = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    const verts = base.slice();
    const mid = new Map();
    const middle = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (mid.has(key)) return mid.get(key);
      const m = verts[a].map((c, i) => (c + verts[b][i]) / 2);
      const l = Math.hypot(...m);
      verts.push(m.map((c) => c / l));
      mid.set(key, verts.length - 1);
      return verts.length - 1;
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = middle(a, b), bc = middle(b, c), ca = middle(c, a);
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
    });
    const first = this.pos.length / 3;
    for (const v of verts) {
      const n = [v[0] / rx, v[1] / ry, v[2] / rz];
      const l = Math.hypot(...n);
      this.vertex([cx + v[0] * rx, cy + v[1] * ry, cz + v[2] * rz], n.map((c) => c / l), [0.5, 0.5]);
    }
    for (const [a, b, c] of faces) this.idx.push(first + a, first + b, first + c);
  }
}

// --- the cabin ------------------------------------------------------------------

function buildCabin(cls, id) {
  const meshes = Object.fromEntries(Object.keys(MATERIALS).map((k) => [k, new Mesh()]));
  const floor = -EYE_ABOVE_FLOOR;
  const left = -WALL_FROM_EYE;

  // Seat columns: x centres, left to right, from the eye's own seat.
  const columns = [];
  let x = -SEAT_W / 2;
  const aisles = [];
  cls.layout.forEach((n, g) => {
    for (let s = 0; s < n; s++) {
      columns.push(x + SEAT_W / 2);
      x += SEAT_W;
    }
    if (g < cls.layout.length - 1) {
      aisles.push([x, x + cls.aisle]);
      x += cls.aisle;
    }
  });
  const right = x + (-left - SEAT_W / 2);
  const half = (right - left) / 2;
  const mid = (right + left) / 2;
  const L = -ROWS_EACH_WAY * cls.pitch - 1.2;
  const A = ROWS_EACH_WAY * cls.pitch + 1.2;

  // Floor, with its aisle runners.
  meshes.carpet.quad([left, floor, L], [right, floor, L], [right, floor, A], [left, floor, A], [0, 1, 0], 4);
  for (const [a, b] of aisles) meshes.runner.quad([a + 0.06, floor + 0.004, L], [b - 0.06, floor + 0.004, L], [b - 0.06, floor + 0.004, A], [a + 0.06, floor + 0.004, A], [0, 1, 0], 4);

  // Cross-section of one side, floor to ceiling: [inboard of the wall, height above the floor].
  const wallAt = (v) => (v < 0.3 ? 0.1 - v * 0.2 : v < 0.7 ? 0.04 - (v - 0.3) * 0.1 : v < 1.5 ? 0 : (v - 1.5) * 0.35);
  const sillV = cls.windowSill;
  const topV = sillV + cls.windowH;
  const bandLo = 0.55;
  const bandHi = 1.5;
  const profile = (side) => (v) => ({ x: side < 0 ? left + wallAt(v) : right - wallAt(v), y: floor + v });

  // Wall strips below and above the window band, along the whole cabin.
  const strip = (side, v0, v1, mat, tile = 1.6) => {
    const p0 = profile(side)(v0);
    const p1 = profile(side)(v1);
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const l = Math.hypot(dx, dy);
    const n = side < 0 ? [dy / l, -dx / l, 0] : [-dy / l, dx / l, 0];
    // Facing into the cabin.
    const into = side < 0 ? 1 : -1;
    const nn = n[0] * into < 0 ? [-n[0], -n[1], 0] : n;
    meshes[mat].quad([p0.x, p0.y, L], [p0.x, p0.y, A], [p1.x, p1.y, A], [p1.x, p1.y, L], nn, tile);
  };
  for (const side of [-1, 1]) {
    strip(side, 0, 0.3, 'lower');
    strip(side, 0.3, bandLo, 'lower');
    // The window band: bays with openings.
    const bandStrip = (z0, z1, v0, v1, mat) => {
      if (z1 - z0 < 1e-4 || v1 - v0 < 1e-4) return;
      const a = profile(side)(v0);
      const b = profile(side)(v1);
      const n = side < 0 ? [1, 0, 0] : [-1, 0, 0];
      meshes[mat].quad([a.x, a.y, z0], [a.x, a.y, z1], [b.x, b.y, z1], [b.x, b.y, z0], n, 1.6);
    };
    strip(side, bandLo, sillV - 0.04, 'wall');
    bandStrip(L, A, sillV - 0.04, sillV, 'wall');
    const r = rng(side < 0 ? 11 : 23);
    // A window beside the eye's own seat, then one every pitch either way.
    const reach = Math.floor((Math.min(-L, A) - 0.4) / WINDOW_PITCH);
    const depth = 0.07;
    let zCursor = L;
    for (let b = -reach; b <= reach; b++) {
      const zc = -0.06 + b * WINDOW_PITCH;
      const wz0 = zc - cls.windowW / 2;
      const wz1 = zc + cls.windowW / 2;
      // Wall between the previous opening and this one.
      bandStrip(zCursor, wz0, sillV, topV, 'wall');
      zCursor = wz1;
      // The opening's reveal, a frame ring on the wall face, and a shade down on a few.
      const lo = profile(side)(sillV);
      const hi = profile(side)(topV);
      const out = side < 0 ? -depth : depth;
      const inward = side < 0 ? [1, 0, 0] : [-1, 0, 0];
      const lift = side < 0 ? 0.004 : -0.004;
      const reveal = (p, q, n) => meshes.frame.quad(p, q, [q[0] + out, q[1], q[2]], [p[0] + out, p[1], p[2]], n, 2);
      reveal([lo.x, lo.y, wz0], [lo.x, lo.y, wz1], [0, 1, 0]);
      reveal([hi.x, hi.y, wz1], [hi.x, hi.y, wz0], [0, -1, 0]);
      reveal([lo.x, lo.y, wz0], [hi.x, hi.y, wz0], [0, 0, 1]);
      reveal([hi.x, hi.y, wz1], [lo.x, lo.y, wz1], [0, 0, -1]);
      const ring = 0.03;
      const rl = profile(side)(sillV - ring);
      const rh = profile(side)(topV + ring);
      meshes.frame.quad([rl.x + lift, rl.y, wz0 - ring], [rl.x + lift, rl.y, wz1 + ring], [lo.x + lift, lo.y, wz1], [lo.x + lift, lo.y, wz0], inward, 4);
      meshes.frame.quad([hi.x + lift, hi.y, wz0], [hi.x + lift, hi.y, wz1], [rh.x + lift, rh.y, wz1 + ring], [rh.x + lift, rh.y, wz0 - ring], inward, 4);
      meshes.frame.quad([lo.x + lift, lo.y, wz0 - ring], [lo.x + lift, lo.y, wz0], [hi.x + lift, hi.y, wz0], [hi.x + lift, hi.y, wz0 - ring], inward, 4);
      meshes.frame.quad([lo.x + lift, lo.y, wz1], [lo.x + lift, lo.y, wz1 + ring], [hi.x + lift, hi.y, wz1 + ring], [hi.x + lift, hi.y, wz1], inward, 4);
      if (r() < 0.22) {
        const s0 = profile(side)(topV - (0.1 + r() * 0.12));
        meshes.plastic.quad([s0.x + lift * 2, s0.y, wz0], [s0.x + lift * 2, s0.y, wz1], [hi.x + lift * 2, hi.y, wz1], [hi.x + lift * 2, hi.y, wz0], inward, 4);
      }
    }
    bandStrip(zCursor, A, sillV, topV, 'wall');
    bandStrip(L, A, topV, bandHi, 'wall');
    strip(side, bandHi, 1.78, 'wall');
  }

  // Overhead bins and the service strip, either side of the ceiling.
  const binZ = 1.6;
  for (const side of [-1, 1]) {
    const edge = side < 0 ? left : right;
    const inner = side < 0 ? left + 0.95 : right - 0.95;
    const flip = side < 0 ? 1 : -1;
    const base = floor + 1.78;
    const top = floor + 2.14;
    for (let z = L + 0.2; z < A - binZ; z += binZ) {
      const z1 = z + binZ - 0.03;
      // Front face (a slope from the lower lip up and inboard), underside, and the end gaps stay dark.
      meshes.bin.quad([edge + flip * 0.16, base, z], [edge + flip * 0.16, base, z1], [inner, top - 0.08, z1], [inner, top - 0.08, z], [flip * 0.55, -0.4, 0], 1.6);
      meshes.bin.quad([edge + flip * 0.16, base, z], [edge + flip * 0.16, base, z1], [edge + flip * 0.04, base - 0.06, z1], [edge + flip * 0.04, base - 0.06, z], [flip * 0.2, -1, 0], 1.6);
      // Door line: a dark slot along the front of each bin.
      meshes.dark.quad([edge + flip * 0.4, base + 0.16, z], [edge + flip * 0.4, base + 0.16, z1], [edge + flip * 0.4, base + 0.17, z1], [edge + flip * 0.4, base + 0.17, z], [flip * 0.55, -0.4, 0], 1);
    }
    // Ceiling from the bin to the centre.
    meshes.ceiling.quad([inner, top - 0.08, L], [inner, top - 0.08, A], [mid, floor + cls.ceiling, A], [mid, floor + cls.ceiling, L], [0, -1, 0], 1.2);
  }
  // Service strip: reading lights and air vents along each side of the centre.
  for (const dx of [-0.72, 0.72]) {
    for (let z = L + 0.3; z < A - 0.3; z += 0.81) {
      meshes.light.box(mid + dx, floor + cls.ceiling - 0.06, z, 0.12, 0.012, 0.05);
      meshes.dark.box(mid + dx, floor + cls.ceiling - 0.055, z + 0.17, 0.05, 0.012, 0.05);
    }
  }

  // Bulkheads at either end, each with a curtain.
  for (const [z, n] of [[L, 1], [A, -1]]) {
    meshes.wall.quad([left, floor, z], [right, floor, z], [right, floor + cls.ceiling, z], [left, floor + cls.ceiling, z], [0, 0, n], 1.6);
    meshes.curtain.box(mid, floor + 1.15, z - n * 0.02, (right - left) * 0.6, 2.0, 0.02);
    meshes.dark.box(mid, floor + 0.05, z - n * 0.03, (right - left) * 0.62, 0.1, 0.03);
  }

  // Seats and the people in them.
  const rand = rng(id.length * 977 + 31);
  const skins = ['skin1', 'skin1', 'skin2', 'skin3'];
  const hairs = ['hairA', 'hairA', 'hairB', 'hairC'];
  const cloths = ['cloth1', 'cloth2', 'cloth3', 'cloth4', 'cloth5'];
  const sitting = floor + 0.44;
  for (let row = -ROWS_EACH_WAY; row <= ROWS_EACH_WAY; row++) {
    const z = row * cls.pitch;
    columns.forEach((cx, c) => {
      const own = row === 0 && c === 0;
      // The seat's cushion, back, headrest, and what hangs on the back of the seat ahead.
      meshes.fabric.box(cx, sitting, z, SEAT_W - 0.02, 0.1, SEAT_DEPTH, 2.5);
      if (!own) {
        meshes.fabric.box(cx, sitting + 0.38, z - SEAT_DEPTH / 2 + 0.03, SEAT_W - 0.02, 0.66, 0.1, 2.5);
        meshes.fabric.box(cx, sitting + 0.76, z - SEAT_DEPTH / 2 + 0.03, SEAT_W * 0.6, 0.16, 0.08, 2.5);
        // Back: the plastic shell, a closed tray table, and the pocket.
        meshes.plastic.box(cx, sitting + 0.34, z - SEAT_DEPTH / 2 - 0.025, SEAT_W - 0.06, 0.58, 0.012);
        meshes.dark.box(cx, sitting + 0.44, z - SEAT_DEPTH / 2 - 0.034, SEAT_W - 0.16, 0.26, 0.008);
        meshes.dark.box(cx, sitting + 0.12, z - SEAT_DEPTH / 2 - 0.036, SEAT_W - 0.14, 0.12, 0.012);
        // A passenger in most seats: head, hair, shoulders.
        if (rand() < 0.68) {
          const skin = skins[Math.floor(rand() * skins.length)];
          const hair = hairs[Math.floor(rand() * hairs.length)];
          const cloth = cloths[Math.floor(rand() * cloths.length)];
          const hz = z - SEAT_DEPTH / 2 + 0.14 + (rand() - 0.5) * 0.04;
          const hx = cx + (rand() - 0.5) * 0.05;
          meshes[skin].ellipsoid(hx, sitting + 0.74, hz, 0.082, 0.1, 0.09);
          meshes[hair].ellipsoid(hx, sitting + 0.78, hz - 0.012, 0.087, 0.08, 0.095);
          meshes[skin].box(hx, sitting + 0.645, hz + 0.01, 0.07, 0.08, 0.07);
          meshes[cloth].box(hx, sitting + 0.5, hz + 0.01, SEAT_W - 0.1, 0.27, 0.19);
        }
      }
      // The armrest between this seat and the next (and at the wall for the first).
      if (c === columns.length - 1 || columns[c + 1] - cx < SEAT_W + 0.01 || true) {
        meshes.plastic.box(cx + SEAT_W / 2, sitting + 0.22, z, 0.04, 0.05, SEAT_DEPTH - 0.04);
      }
      // Legs.
      meshes.dark.box(cx - SEAT_W / 2 + 0.05, sitting - 0.22, z, 0.03, 0.44, 0.04);
      meshes.dark.box(cx + SEAT_W / 2 - 0.05, sitting - 0.22, z, 0.03, 0.44, 0.04);
    });
  }
  return meshes;
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
  const { blob, triangles } = packModel(id, cls, buildCabin(cls, id));
  await writeFile(join(OUT, `${id}.pvm`), blob);
  console.log(`${id}: ${cls.label}, ${triangles.toLocaleString()} triangles, ${(blob.length / 1024).toFixed(0)} kB — ${cls.types}`);
}
