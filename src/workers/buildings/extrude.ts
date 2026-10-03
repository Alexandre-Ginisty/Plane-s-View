/**
 * Building footprints to geometry.
 *
 * Each part becomes walls from its base to its eaves and a roof: flat for
 * large and tall buildings, gabled or hipped (see `roof.ts`) for the small
 * ones that are, across most of the world, houses with pitched roofs — a town
 * of flat-topped boxes is the single most obvious tell of extruded map data.
 * Big flat roofs carry the plant that sits on them.
 *
 * Coordinates are metres in a plane tangent to the ellipsoid at the tile's
 * centre (x east, y north, z up), with z measured from each building's own
 * ground. The main thread adds that ground (`ranges` and `anchors` say which
 * vertices belong to which building, and where it stands), because only the
 * main thread knows the terrain.
 *
 * Walls along the tile's edge are left out: vector tiles cut buildings at
 * the tile boundary, and the cut face is inside a building whose other half
 * is in the next tile.
 */

import { Earcut } from 'three/src/extras/Earcut.js';

import { metresPerDegree } from '@/core/math/geo/ellipsoid';
import { mercatorYToLat } from '@/core/math/geo/mercator';
import type { Footprint } from './mvt';
import { clipLinear, creaseParams, fitRoof, planeDistance, polygonArea, roofZ, smallestRect, type Roof } from './roof';

export interface BuiltBuildings {
  /** x, y, z per vertex, tile-tangent metres; z from the building's ground. */
  positions: Float32Array;
  /** Unit normal per vertex, ×127. */
  normals: Int8Array;
  /**
   * Per vertex: distance along the wall (m), height up the wall (m), the
   * building's height (m) and a per-building random 0..1 — what the shader
   * lays windows and floors out with. Roof vertices carry u = v = 0.
   */
  facade: Float32Array;
  /** Base colour per vertex, sRGB 0..255. */
  colors: Uint8Array;
  indices: Uint32Array;
  /** First vertex and vertex count of each building. */
  ranges: Uint32Array;
  /** Longitude, latitude of each building, degrees: where to sample its ground. */
  anchors: Float64Array;
}

/** Walls go this far below the sampled ground, so slopes never show a gap. */
const FOUNDATION_M = 4;
/** Below this the part is a kerb or a carport outline: not worth a draw. */
const MIN_HEIGHT_M = 2;
/** Height for a building tagged without one: a two-storey house. */
const DEFAULT_HEIGHT_M = 7;

class Writer {
  pos: number[] = [];
  nrm: number[] = [];
  fac: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, h: number, seed: number, rgb: readonly number[]): number {
    this.pos.push(x, y, z);
    this.nrm.push(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127));
    this.fac.push(u, v, h, seed);
    this.col.push(rgb[0]!, rgb[1]!, rgb[2]!, 255);
    return this.count - 1;
  }
}

/** Deterministic per-building noise from its position, so a reload looks the same. */
function hash(x: number, y: number): number {
  let h = Math.imul(Math.floor(x * 7.31) | 0, 374761393) ^ Math.imul(Math.floor(y * 3.17) | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const NAMED: Record<string, [number, number, number]> = {
  white: [236, 234, 228], black: [60, 60, 62], grey: [150, 150, 150], gray: [150, 150, 150],
  silver: [192, 192, 196], red: [170, 82, 66], brown: [140, 100, 72], yellow: [222, 200, 140],
  beige: [222, 210, 182], tan: [210, 180, 140], orange: [214, 140, 82], blue: [120, 150, 190],
  green: [120, 150, 110], pink: [222, 170, 170], cream: [240, 232, 206],
};

function parseColour(c: string | null): [number, number, number] | null {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  const m = /^#?([0-9a-f]{6})$/.exec(s) ?? null;
  if (m) {
    const n = Number.parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const short = /^#([0-9a-f]{3})$/.exec(s);
  if (short) return [...short[1]!].map((d) => Number.parseInt(d + d, 16)) as [number, number, number];
  return NAMED[s] ?? null;
}

/** Plaster, stone and brick, light to mid: what most walls are. */
const WALLS: readonly (readonly [number, number, number])[] = [
  [232, 226, 214], [222, 214, 198], [210, 204, 194], [236, 232, 224], [198, 190, 178],
  [214, 196, 170], [188, 150, 122], [226, 220, 206], [204, 200, 196], [178, 172, 166],
];
/** Tiles and slate for pitched roofs. */
const PITCHED: readonly (readonly [number, number, number])[] = [
  [168, 84, 62], [150, 74, 56], [182, 102, 76], [96, 92, 94], [78, 76, 82], [134, 70, 56], [112, 106, 104],
];
/** Gravel, membrane and concrete for flat roofs. */
const FLAT: readonly (readonly [number, number, number])[] = [
  [140, 138, 134], [120, 118, 116], [158, 154, 148], [104, 104, 106], [170, 166, 160],
];

const pick = <T>(list: readonly T[], r: number): T => list[Math.min(list.length - 1, Math.floor(r * list.length))]!;

interface Ctx {
  w: Writer;
  /** Tile units to tangent metres. */
  toX: (px: number) => number;
  toY: (py: number) => number;
  extent: number;
}

/** True for an edge lying on the tile's cut line. */
function onCut(ax: number, ay: number, bx: number, by: number, extent: number): boolean {
  return (ax <= 0 && bx <= 0) || (ax >= extent && bx >= extent) || (ay <= 0 && by <= 0) || (ay >= extent && by >= extent);
}

function walls(c: Ctx, ring: Float64Array, z0: number, z1: number, h: number, seed: number, rgb: readonly number[], roof?: Roof): void {
  const { w } = c;
  let along = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const pax = ring[i * 2]!;
    const pay = ring[i * 2 + 1]!;
    const pbx = ring[j * 2]!;
    const pby = ring[j * 2 + 1]!;
    const ax = c.toX(pax);
    const ay = c.toY(pay);
    const bx = c.toX(pbx);
    const by = c.toY(pby);
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 0.05) continue;
    if (onCut(pax, pay, pbx, pby, c.extent)) {
      along += len;
      continue;
    }
    // Outer rings run anticlockwise in this frame (MVT's clockwise, y down,
    // mirrored), so (dy, -dx) points out of the solid — for holes too.
    const nx = dy / len;
    const ny = -dx / len;
    // Under a pitched roof the wall top follows the roof line, so it is cut
    // wherever that bends.
    const ts = roof ? [0, ...creaseParams(roof, ax, ay, bx, by), 1] : [0, 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k]!;
      const t1 = ts[k + 1]!;
      if (t1 - t0 < 1e-4) continue;
      const x0 = ax + dx * t0;
      const y0 = ay + dy * t0;
      const x1 = ax + dx * t1;
      const y1 = ay + dy * t1;
      const top0 = roof ? roofZ(roof, x0, y0) : z1;
      const top1 = roof ? roofZ(roof, x1, y1) : z1;
      const a0 = w.vertex(x0, y0, z0, nx, ny, 0, along + len * t0, z0, h, seed, rgb);
      const b0 = w.vertex(x1, y1, z0, nx, ny, 0, along + len * t1, z0, h, seed, rgb);
      const b1 = w.vertex(x1, y1, top1, nx, ny, 0, along + len * t1, top1, h, seed, rgb);
      const a1 = w.vertex(x0, y0, top0, nx, ny, 0, along + len * t0, top0, h, seed, rgb);
      w.idx.push(a0, b0, b1, a0, b1, a1);
    }
    along += len;
  }
}

function flatRoof(c: Ctx, rings: Float64Array[], z: number, h: number, seed: number, rgb: readonly number[]): void {
  const { w } = c;
  const flat: number[] = [];
  const holes: number[] = [];
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holes.push(flat.length / 2);
    const ring = rings[r]!;
    for (let i = 0; i < ring.length; i += 2) flat.push(c.toX(ring[i]!), c.toY(ring[i + 1]!));
  }
  const tris = Earcut.triangulate(flat, holes, 2);
  if (tris.length === 0) return;
  const base = w.count;
  // A flat roof's u, v are its ground position: the shader lays its texture by them.
  for (let i = 0; i < flat.length; i += 2) w.vertex(flat[i]!, flat[i + 1]!, z, 0, 0, 1, flat[i]!, flat[i + 1]!, h, seed, rgb);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!;
    const b = tris[t + 1]!;
    const d = tris[t + 2]!;
    // Facing up: anticlockwise seen from above.
    const cross = (flat[b * 2]! - flat[a * 2]!) * (flat[d * 2 + 1]! - flat[a * 2 + 1]!) - (flat[b * 2 + 1]! - flat[a * 2 + 1]!) * (flat[d * 2]! - flat[a * 2]!);
    if (cross >= 0) w.idx.push(base + a, base + b, base + d);
    else w.idx.push(base + a, base + d, base + b);
  }
}

/** The roof surface of a footprint, in pieces that are each one plane. */
function pitchedRoof(c: Ctx, ring: Float64Array, roof: Roof, h: number, seed: number, rgb: readonly number[]): void {
  const { w } = c;
  const flat: number[] = [];
  for (let i = 0; i < ring.length; i += 2) flat.push(c.toX(ring[i]!), c.toY(ring[i + 1]!));
  const tris = Earcut.triangulate(flat, [], 2);
  const side = Math.hypot(1, roof.k);
  for (let t = 0; t < tris.length; t += 3) {
    const tri: [number, number][] = [0, 1, 2].map((k) => [flat[tris[t + k]! * 2]!, flat[tris[t + k]! * 2 + 1]!] as [number, number]);
    for (let i = 0; i < roof.planes.length; i++) {
      const pi = roof.planes[i]!;
      let poly: [number, number][] = tri;
      for (let j = 0; j < roof.planes.length && poly.length >= 3; j++) {
        if (j === i) continue;
        const pj = roof.planes[j]!;
        poly = clipLinear(poly, (x, y) => planeDistance(pi, x, y) - planeDistance(pj, x, y));
      }
      if (poly.length < 3) continue;
      const area = polygonArea(poly);
      if (Math.abs(area) < 1e-4) continue;
      // Plane z = eave + k·d: its normal leans away from the ridge.
      const l = Math.hypot(roof.k, 1);
      const nx = (-roof.k * pi.nx) / l;
      const ny = (-roof.k * pi.ny) / l;
      const nz = 1 / l;
      const ids = poly.map(([x, y]) => {
        const d = planeDistance(pi, x, y);
        // u along the eave, v up the slope: what tiles are laid out by.
        return w.vertex(x, y, roof.eave + roof.k * Math.max(0, d), nx, ny, nz, -pi.ny * x + pi.nx * y, d * side, h, seed, rgb);
      });
      for (let k = 1; k + 1 < ids.length; k++) {
        if (area > 0) w.idx.push(ids[0]!, ids[k]!, ids[k + 1]!);
        else w.idx.push(ids[0]!, ids[k + 1]!, ids[k]!);
      }
    }
  }
}

/** An axis-aligned-to-the-building box: a vent, a lift head, a cooling unit. */
function box(c: Ctx, cx: number, cy: number, lx: number, ly: number, hx: number, hy: number, z0: number, z1: number, seed: number, rgb: readonly number[]): void {
  const { w } = c;
  const sx = -ly;
  const sy = lx;
  const corner = (a: number, b: number): [number, number] => [cx + lx * hx * a + sx * hy * b, cy + ly * hx * a + sy * hy * b];
  const q = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  // Walls: h = 1 keeps the shader from drawing windows on them.
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = (b[1] - a[1]) / len;
    const ny = -(b[0] - a[0]) / len;
    const a0 = w.vertex(a[0], a[1], z0, nx, ny, 0, 0, z0, 1, seed, rgb);
    const b0 = w.vertex(b[0], b[1], z0, nx, ny, 0, len, z0, 1, seed, rgb);
    const b1 = w.vertex(b[0], b[1], z1, nx, ny, 0, len, z1, 1, seed, rgb);
    const a1 = w.vertex(a[0], a[1], z1, nx, ny, 0, 0, z1, 1, seed, rgb);
    w.idx.push(a0, b0, b1, a0, b1, a1);
  }
  const top = q.map(([x, y]) => w.vertex(x, y, z1, 0, 0, 1, x, y, 1, seed, rgb));
  w.idx.push(top[0]!, top[1]!, top[2]!, top[0]!, top[2]!, top[3]!);
}

function inside(poly: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let in_ = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) in_ = !in_;
  }
  return in_;
}

/** Plant on a big flat roof: a few units, placed where the footprint has room. */
function roofPlant(c: Ctx, poly: readonly (readonly [number, number])[], z: number, seed: number): void {
  const r = smallestRect(poly);
  const count = Math.min(5, 1 + Math.floor((4 * r.a * r.b) / 600));
  const sx = -r.ly;
  const sy = r.lx;
  for (let i = 0; i < count; i++) {
    const u = hash(seed * 91 + i * 5.3, i * 17.1 + seed);
    const v = hash(i * 3.7 + seed * 13, seed * 57 + i);
    const w0 = hash(i * 11.9, seed * 31);
    const hx = 1 + w0 * 1.8;
    const hy = 0.9 + hash(i * 7.1, seed * 5) * 1.3;
    const s = (u * 2 - 1) * (r.a - hx - 1.5);
    const t = (v * 2 - 1) * (r.b - hy - 1.5);
    if (r.a < hx + 3 || r.b < hy + 3) continue;
    const x = r.cx + r.lx * s + sx * t;
    const y = r.cy + r.ly * s + sy * t;
    let ok = true;
    for (const [qa, qb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      if (!inside(poly, x + r.lx * hx * qa + sx * hy * qb, y + r.ly * hx * qa + sy * hy * qb)) ok = false;
    }
    if (!ok) continue;
    const g = 120 + Math.floor(hash(i * 2.1, seed * 9) * 50);
    box(c, x, y, r.lx, r.ly, hx, hy, z, z + 0.9 + hash(i, seed * 3) * 1.2, seed, [g, g, g - 4]);
  }
}

/** Clip a ring (tile units) to the tile square: vector tiles carry a margin beyond it. */
function clipToTile(ring: Float64Array, extent: number): Float64Array {
  let inside = true;
  for (let i = 0; i < ring.length; i += 2) {
    if (ring[i]! < 0 || ring[i]! > extent || ring[i + 1]! < 0 || ring[i + 1]! > extent) {
      inside = false;
      break;
    }
  }
  if (inside) return ring;
  let pts: [number, number][] = [];
  for (let i = 0; i < ring.length; i += 2) pts.push([ring[i]!, ring[i + 1]!]);
  const edges: ((x: number, y: number) => number)[] = [
    (x) => -x,
    (x) => x - extent,
    (_x, y) => -y,
    (_x, y) => y - extent,
  ];
  for (const g of edges) {
    pts = clipLinear(pts, g);
    if (pts.length < 3) return new Float64Array(0);
  }
  const out = new Float64Array(pts.length * 2);
  pts.forEach(([x, y], i) => {
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  });
  return out;
}

/**
 * Extrude every footprint of a tile.
 *
 * @param z, x, y The tile, to place its units on the ground.
 * @param minHeight Parts lower than this are skipped — at a distance a
 *   bungalow is a pixel, and the far tiles ask for the skyline only.
 */
export function extrudeBuildings(
  footprints: readonly Footprint[],
  extent: number,
  z: number,
  x: number,
  y: number,
  minHeight = 0,
): BuiltBuildings {
  const n = 2 ** z;
  const lat0 = mercatorYToLat((y + 0.5) / n);
  const lon0 = ((x + 0.5) / n) * 360 - 180;
  const mpd = metresPerDegree(lat0);
  const toLon = (px: number): number => ((x + px / extent) / n) * 360 - 180;
  const toLat = (py: number): number => mercatorYToLat((y + py / extent) / n);
  const ctx: Ctx = {
    w: new Writer(),
    toX: (px) => (toLon(px) - lon0) * mpd.lon,
    toY: (py) => (toLat(py) - lat0) * mpd.lat,
    extent,
  };
  const ranges: number[] = [];
  const anchors: number[] = [];

  for (const f of footprints) {
    const height = Number.isFinite(f.height) && f.height > 0 ? f.height : DEFAULT_HEIGHT_M;
    if (height < MIN_HEIGHT_M || height < minHeight || height <= f.minHeight) continue;
    // The tile's margin cut away, so the neighbour's half is not drawn twice.
    const rings: Float64Array[] = [];
    for (let r = 0; r < f.rings.length; r++) {
      const ring = clipToTile(f.rings[r]!, extent);
      if (ring.length >= 6) rings.push(ring);
      else if (r === 0) break;
    }
    if (rings.length === 0) continue;
    const outer = rings[0]!;
    // Centroid of the outer ring's vertices: where the ground is sampled.
    let cx = 0;
    let cy = 0;
    let cut = false;
    const count = outer.length / 2;
    for (let i = 0; i < outer.length; i += 2) {
      cx += outer[i]!;
      cy += outer[i + 1]!;
      if (outer[i]! <= 0 || outer[i]! >= extent || outer[i + 1]! <= 0 || outer[i + 1]! >= extent) cut = true;
    }
    cx /= count;
    cy /= count;
    const first = ctx.w.count;
    const seed = hash(toLon(cx) * 1e4, toLat(cy) * 1e4);
    const own = parseColour(f.colour);
    const wall = own ?? pick(WALLS, seed);
    const base = f.minHeight > 0 ? f.minHeight : -FOUNDATION_M;
    const outerM: [number, number][] = [];
    for (let i = 0; i < outer.length; i += 2) outerM.push([ctx.toX(outer[i]!), ctx.toY(outer[i + 1]!)]);
    const areaM = Math.abs(polygonArea(outerM));

    // Pitched where it would be: a house-sized building, near a rectangle, no
    // holes, no podium, not cut by the tile — and not every one, since
    // flat-roofed houses exist too.
    let roof: Roof | null = null;
    if (rings.length === 1 && !cut && f.minHeight === 0 && height >= 4.5 && height <= 16 && areaM <= 700 && outerM.length <= 20 && seed > 0.1) {
      roof = fitRoof(outerM, height, 0.36 + 0.3 * ((seed * 3.7) % 1), ((seed * 11.1) % 1) > 0.55, 2.6);
    }
    if (roof) {
      walls(ctx, outer, base, roof.eave, height, seed, wall, roof);
      pitchedRoof(ctx, outer, roof, height, seed, pick(PITCHED, (seed * 7.13) % 1));
    } else {
      for (const ring of rings) walls(ctx, ring, base, height, height, seed, wall);
      const roofRgb = own ? own.map((v) => v * 0.8) : pick(FLAT, (seed * 5.71) % 1);
      flatRoof(ctx, rings, height, height, seed, roofRgb);
      if (rings.length === 1 && areaM > 350 && height >= 6 && f.minHeight === 0) roofPlant(ctx, outerM, height, seed);
    }
    const added = ctx.w.count - first;
    if (added > 0) {
      ranges.push(first, added);
      anchors.push(toLon(cx), toLat(cy));
    }
  }

  const w = ctx.w;
  return {
    positions: Float32Array.from(w.pos),
    normals: Int8Array.from(w.nrm),
    facade: Float32Array.from(w.fac),
    colors: Uint8Array.from(w.col),
    indices: Uint32Array.from(w.idx),
    ranges: Uint32Array.from(ranges),
    anchors: Float64Array.from(anchors),
  };
}
