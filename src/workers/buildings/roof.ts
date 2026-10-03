/**
 * Pitched roofs on any near-rectangular footprint.
 *
 * The footprint is fitted with its smallest enclosing rectangle, and the roof
 * is the surface `eave + k · min(distance to each side)`: a hip roof takes
 * all four sides, a gable roof only the two long ones. Inside any one
 * "nearest side" region that is a plane, so a triangulated footprint is cut
 * along the ridge and the hips and every piece gets its own plane — which
 * works for an L-shape or a house with a chamfered corner, not only for a
 * perfect rectangle. The walls follow the roof line, which is what makes the
 * gable end a triangle.
 *
 * Coordinates are metres in the tile's tangent plane.
 */

export interface RoofPlane {
  /** Unit direction pointing inward, so the distance to the side grows along it. */
  nx: number;
  ny: number;
  /** Distance to the side at the origin. */
  o: number;
}

export interface Roof {
  planes: RoofPlane[];
  /** Rise per metre of run. */
  k: number;
  eave: number;
  /** Highest point above the eave. */
  rise: number;
}

export interface Rect {
  cx: number;
  cy: number;
  /** Long axis, unit. */
  lx: number;
  ly: number;
  /** Half the long and short sides. */
  a: number;
  b: number;
}

export function polygonArea(p: readonly (readonly [number, number])[]): number {
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i, i++) s += p[j]![0] * p[i]![1] - p[i]![0] * p[j]![1];
  return s / 2;
}

/** Smallest enclosing rectangle by trying each edge direction. */
export function smallestRect(p: readonly (readonly [number, number])[]): Rect {
  let best: Rect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    const dx = p[j]![0] - p[i]![0];
    const dy = p[j]![1] - p[i]![1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uy = dy / len;
    let s0 = Infinity;
    let s1 = -Infinity;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const q of p) {
      const s = q[0] * ux + q[1] * uy;
      const t = -q[0] * uy + q[1] * ux;
      if (s < s0) s0 = s;
      if (s > s1) s1 = s;
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
    }
    const area = (s1 - s0) * (t1 - t0);
    if (area >= bestArea) continue;
    bestArea = area;
    const sm = (s0 + s1) / 2;
    const tm = (t0 + t1) / 2;
    const cx = sm * ux - tm * uy;
    const cy = sm * uy + tm * ux;
    // Long axis first.
    best =
      s1 - s0 >= t1 - t0
        ? { cx, cy, lx: ux, ly: uy, a: (s1 - s0) / 2, b: (t1 - t0) / 2 }
        : { cx, cy, lx: -uy, ly: ux, a: (t1 - t0) / 2, b: (s1 - s0) / 2 };
  }
  return best ?? { cx: 0, cy: 0, lx: 1, ly: 0, a: 0, b: 0 };
}

/**
 * Fit a roof to a ring, or `null` when it is not a shape a roof like this
 * suits (too far from a rectangle, too small to have a ridge).
 *
 * @param pitch Rise per metre of run.
 * @param hip Hip roof (all four sides) rather than a gable.
 */
export function fitRoof(ring: readonly (readonly [number, number])[], height: number, pitch: number, hip: boolean, minEave: number): Roof | null {
  const area = Math.abs(polygonArea(ring));
  const r = smallestRect(ring);
  if (r.b < 1.8 || area < 0.68 * 4 * r.a * r.b) return null;
  // The ridge may not rise past half the building, nor leave the walls too short.
  const rise = Math.min(pitch * r.b, height * 0.5, height - minEave);
  if (rise < 0.8) return null;
  const k = rise / r.b;
  const sx = -r.ly;
  const sy = r.lx;
  const along = r.cx * r.lx + r.cy * r.ly;
  const across = r.cx * sx + r.cy * sy;
  const planes: RoofPlane[] = [
    { nx: sx, ny: sy, o: r.b - across },
    { nx: -sx, ny: -sy, o: r.b + across },
  ];
  if (hip) {
    planes.push({ nx: -r.lx, ny: -r.ly, o: r.a + along }, { nx: r.lx, ny: r.ly, o: r.a - along });
  }
  return { planes, k, eave: height - rise, rise };
}

export const planeDistance = (p: RoofPlane, x: number, y: number): number => p.nx * x + p.ny * y + p.o;

/** Roof height above the ground at a point. */
export function roofZ(roof: Roof, x: number, y: number): number {
  let d = Infinity;
  for (const p of roof.planes) d = Math.min(d, planeDistance(p, x, y));
  return roof.eave + roof.k * Math.max(0, d);
}

/**
 * Parameters along a wall edge where its roof line bends — where the nearest
 * side changes — so the wall top can follow the roof in straight pieces.
 */
export function creaseParams(roof: Roof, ax: number, ay: number, bx: number, by: number): number[] {
  const out: number[] = [];
  const n = roof.planes.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const pi = roof.planes[i]!;
      const pj = roof.planes[j]!;
      const ga = planeDistance(pi, ax, ay) - planeDistance(pj, ax, ay);
      const gb = planeDistance(pi, bx, by) - planeDistance(pj, bx, by);
      if (ga === gb || ga * gb >= 0) continue;
      const t = ga / (ga - gb);
      // Only where those two really are the nearest.
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const d = planeDistance(pi, x, y);
      let nearest = true;
      for (const q of roof.planes) if (planeDistance(q, x, y) < d - 1e-6) nearest = false;
      if (nearest) out.push(t);
    }
  }
  return out.sort((u, v) => u - v);
}

/** A convex polygon cut to the side of `g(p) <= 0`, where g is linear. */
export function clipLinear(poly: readonly (readonly [number, number])[], g: (x: number, y: number) => number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const ga = g(a[0], a[1]);
    const gb = g(b[0], b[1]);
    if (ga <= 0) out.push([a[0], a[1]]);
    if ((ga < 0 && gb > 0) || (ga > 0 && gb < 0)) {
      const t = ga / (ga - gb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
