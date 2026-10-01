/**
 * Where an aircraft's lights are, read off its own model.
 *
 * A light is a fitting on the skin: the red and green at the very wingtips,
 * the white on the tail cone, the beacons on the crown and the belly. Placed
 * from a type's nominal proportions they floated — a model is centred on its
 * bounding box, which the fin drags well above the fuselage (a 737's
 * centreline sits seven hundredths of its length below the origin), and the
 * stand-in airframe drawn for most traffic is not the type's own shape — so
 * every aircraft wore its lights metres off the airframe.
 *
 * Here they are found on the surface actually drawn: rays cast at the hull
 * for the crown, belly, tail cone and nose, the outermost skin for the tips.
 *
 * Positions are in the model's own normalised frame: unit length, nose +Y,
 * up +Z, right wing +X (see `pvm.ts`).
 */

import type { LoadedModel } from './pvm';

type P = readonly [number, number, number];

export interface LightAnchors {
  /** Right wingtip (green); the left (red) is its mirror in X. */
  tip: P;
  /** Tail cone (white). */
  tail: P;
  /** Crown and belly beacons. */
  top: P;
  belly: P;
  /** Landing lights, right side; mirrored for the left. */
  landing: P;
}

/**
 * Keyed by the first part's geometry: an operator's livery wraps the model in
 * a new object (see `withLivery`) but shares its geometry, and the measurement
 * — milliseconds on a big airframe — is the airframe's, not the paint's.
 */
const cache = new WeakMap<object, LightAnchors | null>();

/** The anchors for a model, or null when it has no usable hull. Cached per airframe. */
export function lightAnchorsFor(model: LoadedModel): LightAnchors | null {
  const key = model.parts[0]?.geometry ?? model;
  let anchors = cache.get(key);
  if (anchors === undefined) {
    anchors = measure(model);
    cache.set(key, anchors);
  }
  return anchors;
}

/** Every airframe triangle, flat: 9 floats each. */
function hullTriangles(model: LoadedModel): Float32Array {
  // Not the undercarriage (retracted in flight), not the propellers or
  // rotors, not see-through glass.
  const parts = model.parts.filter((p) => p.role === 'hull' && p.material.opacity > 0.5);
  let count = 0;
  for (const p of parts) count += p.geometry.index ? p.geometry.index.count : p.geometry.getAttribute('position').count;
  const out = new Float32Array(count * 3);
  let k = 0;
  for (const p of parts) {
    const pos = p.geometry.getAttribute('position').array;
    const idx = p.geometry.index?.array;
    const [ox, oy, oz] = p.origin;
    const n = idx ? idx.length : pos.length / 3;
    for (let i = 0; i < n; i++) {
      const v = (idx ? idx[i]! : i) * 3;
      out[k++] = pos[v]! + ox;
      out[k++] = pos[v + 1]! + oy;
      out[k++] = pos[v + 2]! + oz;
    }
  }
  return out;
}

/** Distance along the ray to the nearest triangle, or Infinity (Möller–Trumbore, two-sided). */
function cast(tris: Float32Array, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  let best = Infinity;
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i]!, ay = tris[i + 1]!, az = tris[i + 2]!;
    const e1x = tris[i + 3]! - ax, e1y = tris[i + 4]! - ay, e1z = tris[i + 5]! - az;
    const e2x = tris[i + 6]! - ax, e2y = tris[i + 7]! - ay, e2z = tris[i + 8]! - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 0 && t < best) best = t;
  }
  return best;
}

function measure(model: LoadedModel): LightAnchors | null {
  const tris = hullTriangles(model);
  if (tris.length === 0) return null;

  let maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    maxX = Math.max(maxX, tris[i]!);
    minY = Math.min(minY, tris[i + 1]!);
    maxY = Math.max(maxY, tris[i + 1]!);
    minZ = Math.min(minZ, tris[i + 2]!);
    maxZ = Math.max(maxZ, tris[i + 2]!);
  }
  const length = maxY - minY;
  const above = maxZ + 1;
  const below = minZ - 1;

  // Crown and belly over the wing box, just off the centreline (an antenna or
  // a seam exactly on it would catch the ray).
  const midY = minY + length * 0.55;
  const topHit = cast(tris, 0.001, midY, above, 0, 0, -1);
  const bellyHit = cast(tris, 0.001, midY, below, 0, 0, 1);
  if (!Number.isFinite(topHit) || !Number.isFinite(bellyHit)) return null;
  const fTop = above - topHit;
  const fBot = below + bellyHit;
  const fMid = (fTop + fBot) / 2;
  const radius = (fTop - fBot) / 2;

  // Tail cone: the aftmost skin on the centreline, below the fin.
  let tail: [number, number, number] = [0, Infinity, fMid];
  for (let i = 0; i <= 10; i++) {
    const z = fBot + (fMid + radius * 0.4 - fBot) * (i / 10);
    const t = cast(tris, 0.001, minY - 1, z, 0, 1, 0);
    if (Number.isFinite(t) && minY - 1 + t < tail[1]) tail = [0, minY - 1 + t, z];
  }
  if (!Number.isFinite(tail[1])) tail = [0, minY, fMid];

  // Wingtip: the outermost skin, and of that the lowest, most forward point —
  // the tip itself rather than the top of a winglet canted outboard.
  const tipBand = length * 0.02;
  let tip: [number, number, number] = [maxX, midY, fMid];
  let tipScore = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i]!;
    if (x < maxX - tipBand) continue;
    const score = tris[i + 1]! - 4 * tris[i + 2]!;
    if (score > tipScore) {
      tipScore = score;
      tip = [x, tris[i + 1]!, tris[i + 2]!];
    }
  }

  // Landing lights: low on the forward fuselage's side.
  const landY = minY + length * 0.75;
  const landZ = fBot + radius * 0.45;
  const side = cast(tris, maxX + 1, landY, landZ, -1, 0, 0);
  const landX = Number.isFinite(side) ? Math.max(0, maxX + 1 - side) : radius;
  // A wing or nacelle in the way puts the hit far out: keep it on the fuselage.
  const landing: P = [Math.min(landX, radius * 1.2), landY, landZ];

  return { tip, tail, top: [0, midY, fTop], belly: [0, midY, fBot], landing };
}
