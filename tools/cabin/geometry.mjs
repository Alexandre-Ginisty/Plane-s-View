/**
 * Mesh building for the generated cabins: soft solids with a transform stack.
 *
 * The first cabins were boxes and icospheres, which is why the people in them
 * read as heads on crates. This adds what a figure needs — ellipsoids and
 * superellipsoids for soft shapes, blobs stretched between two joints for
 * limbs, tori for glasses and pillows, tapered tubes — and a transform stack
 * shared by every mesh in a set, so a head can be tilted once and everything
 * drawn on it (face, hair, hat) turns with it.
 *
 * Every surface carries analytic normals and is wound outward by checking each
 * triangle against them, so a primitive never has to get its winding right by
 * hand.
 */

// --- 4x4 matrices, column-major, as plain arrays ----------------------------------

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  return out;
}

/** Inverse transpose of the upper 3x3, for normals under non-uniform scale. */
function normalMatrix(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  // Cofactor matrix over the determinant is the inverse transpose.
  return [
    A / det, B / det, C / det,
    (-(b * i - c * h)) / det, (a * i - c * g) / det, (-(a * h - b * g)) / det,
    (b * f - c * e) / det, (-(a * f - c * d)) / det, (a * e - b * d) / det,
  ];
}

export const vec = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
};

/** The transform shared by every mesh of a set. */
class Transform {
  constructor() {
    this.m = identity();
    this.n = normalMatrix(this.m);
    this.stack = [];
    /** Multiplies the segment count of soft solids: higher for what is seen close. */
    this.quality = 1;
  }
  set(m) {
    this.m = m;
    this.n = normalMatrix(m);
  }
  push() {
    this.stack.push(this.m);
  }
  pop() {
    this.set(this.stack.pop());
  }
  translate(x, y, z) {
    const t = identity();
    t[12] = x; t[13] = y; t[14] = z;
    this.set(multiply(this.m, t));
  }
  scale(x, y, z) {
    const s = identity();
    s[0] = x; s[5] = y; s[10] = z;
    this.set(multiply(this.m, s));
  }
  rotateX(a) {
    const c = Math.cos(a), s = Math.sin(a);
    this.set(multiply(this.m, [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]));
  }
  rotateY(a) {
    const c = Math.cos(a), s = Math.sin(a);
    this.set(multiply(this.m, [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]));
  }
  rotateZ(a) {
    const c = Math.cos(a), s = Math.sin(a);
    this.set(multiply(this.m, [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  }
  /** Orient local +Y along `dir`, with local +X as near `side` as it can be. */
  alignY(dir, side = [1, 0, 0]) {
    const y = vec.norm(dir);
    let x = vec.sub(side, vec.mul(y, vec.dot(side, y)));
    if (vec.len(x) < 1e-4) x = vec.sub([0, 0, 1], vec.mul(y, y[2]));
    x = vec.norm(x);
    const z = vec.cross(x, y);
    this.set(multiply(this.m, [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1]));
  }
  point(p) {
    const m = this.m;
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  }
  normal(v) {
    const n = this.n;
    const r = [n[0] * v[0] + n[1] * v[1] + n[2] * v[2], n[3] * v[0] + n[4] * v[1] + n[5] * v[2], n[6] * v[0] + n[7] * v[1] + n[8] * v[2]];
    return vec.norm(r);
  }
}

const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

export class Mesh {
  constructor(xf = new Transform()) {
    this.xf = xf;
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.idx = [];
  }
  vertex(p, n, uv) {
    const q = this.xf.point(p);
    const m = this.xf.normal(n);
    this.pos.push(q[0], q[1], q[2]);
    this.nrm.push(m[0], m[1], m[2]);
    this.uv.push(uv[0], uv[1]);
    return this.pos.length / 3 - 1;
  }
  get vertices() {
    return this.pos.length / 3;
  }

  /** A quad a→b→c→d, seen from the side its normal points to. UVs by metres × `tile`. */
  quad(a, b, c, d, n, tile = 1) {
    const ex = vec.sub(b, a);
    const ey = vec.sub(d, a);
    const lu = vec.len(ex) * tile;
    const lv = vec.len(ey) * tile;
    const i0 = this.vertex(a, n, [0, 0]);
    const i1 = this.vertex(b, n, [lu, 0]);
    const i2 = this.vertex(c, n, [lu, lv]);
    const i3 = this.vertex(d, n, [0, lv]);
    if (vec.dot(vec.cross(ex, ey), n) >= 0) this.idx.push(i0, i1, i2, i0, i2, i3);
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

  /**
   * A parametric surface. `fn(u, v)` returns `{ p, n }` for u, v in 0..1;
   * triangles are wound to face their own normals.
   */
  surface(fn, nu, nv, tile = 1) {
    const first = this.vertices;
    for (let j = 0; j <= nv; j++)
      for (let i = 0; i <= nu; i++) {
        const { p, n } = fn(i / nu, j / nv);
        this.vertex(p, n, [(i / nu) * tile, (j / nv) * tile]);
      }
    const at = (i, j) => first + j * (nu + 1) + i;
    const tri = (a, b, c) => {
      const pa = [this.pos[a * 3], this.pos[a * 3 + 1], this.pos[a * 3 + 2]];
      const pb = [this.pos[b * 3], this.pos[b * 3 + 1], this.pos[b * 3 + 2]];
      const pc = [this.pos[c * 3], this.pos[c * 3 + 1], this.pos[c * 3 + 2]];
      const g = vec.cross(vec.sub(pb, pa), vec.sub(pc, pa));
      if (vec.len(g) < 1e-12) return;
      const n = [this.nrm[a * 3] + this.nrm[b * 3] + this.nrm[c * 3], this.nrm[a * 3 + 1] + this.nrm[b * 3 + 1] + this.nrm[c * 3 + 1], this.nrm[a * 3 + 2] + this.nrm[b * 3 + 2] + this.nrm[c * 3 + 2]];
      if (vec.dot(g, n) >= 0) this.idx.push(a, b, c);
      else this.idx.push(a, c, b);
    };
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        tri(at(i, j), at(i + 1, j), at(i + 1, j + 1));
        tri(at(i, j), at(i + 1, j + 1), at(i, j + 1));
      }
  }

  /**
   * A superellipsoid: `e` = 1 is an ellipsoid, towards 0 a rounded box. The
   * workhorse for heads, torsos, cushions and anything soft.
   */
  soft(cx, cy, cz, rx, ry, rz, e = 1, segments = 10) {
    const seg = Math.max(5, Math.round(segments * this.xf.quality));
    const nv = Math.max(3, Math.round(seg / 2));
    this.surface(
      (u, v) => {
        const th = u * Math.PI * 2;
        const ph = -Math.PI / 2 + v * Math.PI;
        const cp = Math.cos(ph), sp = Math.sin(ph), ct = Math.cos(th), st = Math.sin(th);
        const p = [cx + rx * spow(cp, e) * spow(ct, e), cy + ry * spow(sp, e), cz + rz * spow(cp, e) * spow(st, e)];
        const n = [spow(cp, 2 - e) * spow(ct, 2 - e) / rx, spow(sp, 2 - e) / ry, spow(cp, 2 - e) * spow(st, 2 - e) / rz];
        return { p, n: Math.hypot(...n) < 1e-9 ? [0, Math.sign(sp) || 1, 0] : vec.norm(n) };
      },
      seg,
      nv,
    );
  }

  ellipsoid(cx, cy, cz, rx, ry, rz, seg = 10) {
    this.soft(cx, cy, cz, rx, ry, rz, 1, seg);
  }

  /** A soft box: rounded on every edge. `r` is the roundness, 0.2 (crisp) to 1 (an ellipsoid). */
  pillow(cx, cy, cz, sx, sy, sz, e = 0.3, seg = 8) {
    this.soft(cx, cy, cz, sx / 2, sy / 2, sz / 2, e, seg);
  }

  /** A soft blob stretched from joint `a` to joint `b`, `r` thick, ends rounded past the joints. */
  limb(a, b, r, rz = r, seg = 8, e = 0.9, reach = 0.55) {
    const d = vec.sub(b, a);
    const l = vec.len(d);
    if (l < 1e-6) return this.ellipsoid(a[0], a[1], a[2], r, r, rz, seg);
    this.xf.push();
    this.xf.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    this.xf.alignY(d);
    this.soft(0, 0, 0, r, l / 2 + Math.min(r, rz) * reach, rz, e, seg);
    this.xf.pop();
  }

  /**
   * A limb that narrows: radius `r0` at joint `a` to `r1` at joint `b`, its
   * sides bulging a little (`swell`, a fraction of the mean radius) the way a
   * muscle does, and open at the ends — the joints are drawn as their own
   * spheres, so a knee or an elbow reads as one. `flat` squashes the section
   * front to back (a forearm, a shin).
   */
  taper(a, b, r0, r1, seg = 10, swell = 0.12, flat = 1) {
    const d = vec.sub(b, a);
    const l = vec.len(d);
    if (l < 1e-6) return;
    const sides = Math.max(6, Math.round(seg * this.xf.quality));
    const rings = Math.max(3, Math.round(sides / 2));
    this.xf.push();
    this.xf.translate(a[0], a[1], a[2]);
    this.xf.alignY(d);
    const mean = (r0 + r1) / 2;
    this.surface(
      (u, v) => {
        const th = u * Math.PI * 2;
        const r = r0 + (r1 - r0) * v + Math.sin(v * Math.PI) * mean * swell;
        const dr = (r1 - r0) / l + (Math.cos(v * Math.PI) * Math.PI * mean * swell) / l;
        const c = Math.cos(th), s = Math.sin(th);
        return { p: [c * r, v * l, s * r * flat], n: vec.norm([c / 1, -dr, s / flat]) };
      },
      sides,
      rings,
    );
    this.xf.pop();
  }

  /** A ring: `R` from the centre to the middle of the tube, `r` the tube. In the XZ plane about the origin; use the transform to orient it. `arc` is the fraction of the circle drawn. */
  torus(cx, cy, cz, R, r, seg = 14, side = 5, arc = 1, ry = r) {
    this.surface(
      (u, v) => {
        const th = u * Math.PI * 2 * arc;
        const ph = v * Math.PI * 2;
        const ring = [Math.cos(th), 0, Math.sin(th)];
        const out = [Math.cos(ph) * ring[0], Math.sin(ph), Math.cos(ph) * ring[2]];
        return {
          p: [cx + (R + r * Math.cos(ph)) * ring[0], cy + ry * Math.sin(ph), cz + (R + r * Math.cos(ph)) * ring[2]],
          n: vec.norm([out[0] / r, out[1] / ry, out[2] / r]),
        };
      },
      seg,
      side,
    );
  }

  /** A tapered tube along +Y from the origin, `h` long, capped. For cups, bottles, cones and legs. */
  tube(cx, cy, cz, r0, r1, h, sides = 10) {
    const slope = (r0 - r1) / h;
    this.surface(
      (u, v) => {
        const th = u * Math.PI * 2;
        const r = r0 + (r1 - r0) * v;
        return {
          p: [cx + Math.cos(th) * r, cy + v * h, cz + Math.sin(th) * r],
          n: vec.norm([Math.cos(th), slope, Math.sin(th)]),
        };
      },
      sides,
      1,
    );
    for (const [y, r, n] of [[cy, r0, -1], [cy + h, r1, 1]]) {
      if (r < 1e-4) continue;
      this.surface(
        (u, v) => {
          const th = u * Math.PI * 2;
          return { p: [cx + Math.cos(th) * r * v, y, cz + Math.sin(th) * r * v], n: [0, n, 0] };
        },
        sides,
        1,
      );
    }
  }
}

/** Meshes keyed by material, sharing one transform stack. */
export class MeshSet {
  constructor() {
    this.xf = new Transform();
    this.meshes = {};
  }
  get(key) {
    return (this.meshes[key] ??= new Mesh(this.xf));
  }
  /** Run `fn` with the transform restored afterwards. */
  within(fn) {
    this.xf.push();
    try {
      fn();
    } finally {
      this.xf.pop();
    }
  }
}
