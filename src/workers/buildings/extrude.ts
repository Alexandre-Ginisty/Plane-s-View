/**
 * Building footprints to geometry.
 *
 * Each part becomes walls from its base to its eaves and a roof: flat for
 * most, pitched for the small rectangular buildings that are, across most of
 * the world, houses with pitched roofs — a town of flat-topped boxes is the
 * single most obvious tell of extruded map data.
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

function walls(c: Ctx, ring: Float64Array, z0: number, z1: number, h: number, seed: number, rgb: readonly number[]): void {
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
    const a0 = w.vertex(ax, ay, z0, nx, ny, 0, along, z0, h, seed, rgb);
    const b0 = w.vertex(bx, by, z0, nx, ny, 0, along + len, z0, h, seed, rgb);
    const b1 = w.vertex(bx, by, z1, nx, ny, 0, along + len, z1, h, seed, rgb);
    const a1 = w.vertex(ax, ay, z1, nx, ny, 0, along, z1, h, seed, rgb);
    w.idx.push(a0, b0, b1, a0, b1, a1);
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
  for (let i = 0; i < flat.length; i += 2) w.vertex(flat[i]!, flat[i + 1]!, z, 0, 0, 1, 0, 0, h, seed, rgb);
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

/**
 * A gabled roof on a four-cornered footprint: the ridge along the long axis,
 * a gable at each short end. Returns false when the footprint is not a
 * near-rectangle, and the caller falls back to a flat roof.
 */
function gableRoof(c: Ctx, ring: Float64Array, eave: number, ridgeH: number, h: number, seed: number, wallRgb: readonly number[], roofRgb: readonly number[]): boolean {
  if (ring.length !== 8) return false;
  const p: [number, number][] = [];
  for (let i = 0; i < 8; i += 2) p.push([c.toX(ring[i]!), c.toY(ring[i + 1]!)]);
  // Near-rectangular: opposite sides about equal.
  const side = (i: number): number => Math.hypot(p[(i + 1) % 4]![0] - p[i]![0], p[(i + 1) % 4]![1] - p[i]![1]);
  const s = [side(0), side(1), side(2), side(3)];
  if (Math.abs(s[0]! - s[2]!) > 0.2 * Math.max(s[0]!, s[2]!) || Math.abs(s[1]! - s[3]!) > 0.2 * Math.max(s[1]!, s[3]!)) return false;
  // Rotate so edge 0→1 is a long side.
  const k = s[0]! + s[2]! >= s[1]! + s[3]! ? 0 : 1;
  const q = [p[k]!, p[(k + 1) % 4]!, p[(k + 2) % 4]!, p[(k + 3) % 4]!];
  const short = (Math.min(s[0]!, s[1]!) + Math.min(s[2]!, s[3]!)) / 2;
  const top = eave + Math.min(ridgeH, short * 0.45);
  // Ridge endpoints: midpoints of the short ends (3→0 and 1→2).
  const r0: [number, number] = [(q[3]![0] + q[0]![0]) / 2, (q[3]![1] + q[0]![1]) / 2];
  const r1: [number, number] = [(q[1]![0] + q[2]![0]) / 2, (q[1]![1] + q[2]![1]) / 2];
  const { w } = c;

  const slope = (a: [number, number], b: [number, number]): void => {
    // Quad a, b at the eave, then up to the ridge (r1 above b, r0 above a).
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const vx = r0[0] - a[0];
    const vy = r0[1] - a[1];
    const vz = top - eave;
    let nx = uy * vz;
    let ny = -ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    if (nz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const i0 = w.vertex(a[0], a[1], eave, nx, ny, nz, 0, 0, h, seed, roofRgb);
    const i1 = w.vertex(b[0], b[1], eave, nx, ny, nz, 0, 0, h, seed, roofRgb);
    const rb = Math.hypot(r1[0] - b[0], r1[1] - b[1]) < Math.hypot(r0[0] - b[0], r0[1] - b[1]) ? r1 : r0;
    const ra = rb === r1 ? r0 : r1;
    const i2 = w.vertex(rb[0], rb[1], top, nx, ny, nz, 0, 0, h, seed, roofRgb);
    const i3 = w.vertex(ra[0], ra[1], top, nx, ny, nz, 0, 0, h, seed, roofRgb);
    // Anticlockwise seen from outside-above.
    w.idx.push(i0, i1, i2, i0, i2, i3);
  };
  slope(q[0]!, q[1]!);
  slope(q[2]!, q[3]!);

  // The gable ends: wall-coloured triangles closing the roof.
  const gable = (a: [number, number], b: [number, number], r: [number, number]): void => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = dy / len;
    const ny = -dx / len;
    const i0 = w.vertex(a[0], a[1], eave, nx, ny, 0, 0, eave, h, seed, wallRgb);
    const i1 = w.vertex(b[0], b[1], eave, nx, ny, 0, len, eave, h, seed, wallRgb);
    const i2 = w.vertex(r[0], r[1], top, nx, ny, 0, len / 2, top, h, seed, wallRgb);
    w.idx.push(i0, i1, i2);
  };
  gable(q[1]!, q[2]!, r1);
  gable(q[3]!, q[0]!, r0);
  return true;
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
    const outer = f.rings[0]!;
    // Centroid of the outer ring's vertices: where the ground is sampled.
    let cx = 0;
    let cy = 0;
    const count = outer.length / 2;
    for (let i = 0; i < outer.length; i += 2) {
      cx += outer[i]!;
      cy += outer[i + 1]!;
    }
    cx /= count;
    cy /= count;
    const first = ctx.w.count;
    const seed = hash(toLon(cx) * 1e4, toLat(cy) * 1e4);
    const own = parseColour(f.colour);
    const wall = own ?? pick(WALLS, seed);
    const base = f.minHeight > 0 ? f.minHeight : -FOUNDATION_M;

    // Pitched where it would be: low, four corners, no holes, no podium —
    // and not every one, since flat-roofed houses exist too.
    const pitched =
      f.rings.length === 1 && outer.length === 8 && height <= 14 && f.minHeight === 0 && seed > 0.12;
    let roofed = false;
    if (pitched) {
      const ridge = 2.5 + seed * 2.5;
      const eave = Math.max(2.6, height - ridge);
      const roof = pick(PITCHED, (seed * 7.13) % 1);
      roofed = gableRoof(ctx, outer, eave, height - eave, height, seed, wall, roof);
      if (roofed) for (const ring of f.rings) walls(ctx, ring, base, eave, height, seed, wall);
    }
    if (!roofed) {
      for (const ring of f.rings) walls(ctx, ring, base, height, height, seed, wall);
      flatRoof(ctx, f.rings, height, height, seed, own ? own.map((v) => v * 0.8) : pick(FLAT, (seed * 5.71) % 1));
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
