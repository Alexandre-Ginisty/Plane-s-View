/**
 * Where a window seat is in a converted exterior model.
 *
 * Every exterior `.pvm` is unit length, nose +Y, up +Z, centred on its
 * bounding box (see `src/render/aircraft/pvm.ts`). The cabin generator needs,
 * for each airframe, the fuselage's axis and radius and the station of the
 * wing root, to put a passenger's eye beside a window over the wing. Measured
 * from the geometry rather than keyed in per type:
 *
 *  - the fuselage crown and keel are the highest and lowest points on the
 *    centreline (|x| near zero) over the middle of the airframe;
 *  - the radius is the widest the hull gets there with the wing excluded — the
 *    median of the hull's lateral extent, taken at stations clear of the wing;
 *  - the wing root is where hull vertices sit just outboard of the fuselage
 *    skin, near the axis height, in the middle of the airframe.
 */

import { readFileSync } from 'node:fs';

export function readExterior(path) {
  const blob = readFileSync(path);
  const headerLength = blob.readUInt32LE(4);
  const magic = blob.toString('ascii', 0, 4);
  const header = JSON.parse(blob.toString('utf8', 8, 8 + headerLength).replace(/\0+$/, ''));
  const payload = blob.subarray(8 + headerLength);
  const points = [];
  for (const part of header.parts) {
    if (part.role !== 'hull' || part.opacity < 0.999) continue;
    const r = part.position;
    const count = r.count;
    const at = payload.byteOffset + r.offset;
    if (r.type === 'i16') {
      const q = new Int16Array(payload.buffer.slice(at, at + count * 2));
      const k = part.quant;
      for (let i = 0; i < count; i += 3) points.push([k[0] + (q[i] * k[3]) / 32767, k[1] + (q[i + 1] * k[4]) / 32767, k[2] + (q[i + 2] * k[5]) / 32767]);
    } else {
      const f = new Float32Array(payload.buffer.slice(at, at + count * 4));
      for (let i = 0; i < count; i += 3) points.push([f[i], f[i + 1], f[i + 2]]);
    }
  }
  return { header, points, magic };
}

const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

/**
 * Fuselage axis height, radius and wing-root station, in unit-length model
 * units. The fuselage is read off a slab well forward of the wing, where
 * nothing but skin is: its lateral half-width is the radius and the height of
 * its widest points is the axis. The wing root is then the stretch of the
 * middle of the airframe where hull vertices sit just outboard of that skin.
 */
export function measure(points) {
  let best = null;
  for (const y0 of [0.16, 0.13, 0.1, 0.2]) {
    const slab = points.filter((p) => Math.abs(p[1] - y0) < 0.006);
    if (slab.length < 20) continue;
    const xs = slab.map((p) => p[0]);
    const half = (Math.max(...xs) - Math.min(...xs)) / 2;
    if (!best || half > best.half) best = { y0, slab, half };
  }
  if (!best) return null;
  const { slab, half } = best;
  const wide = slab.filter((p) => Math.abs(p[0]) > half * 0.92);
  const axis = median(wide.map((p) => p[2]));
  const mid = points.filter((p) => Math.abs(p[1]) < 0.3);
  const wing = mid.filter((p) => Math.abs(p[0]) > half * 1.12 && Math.abs(p[0]) < half * 2.6 && Math.abs(p[2] - axis) < half * 0.7);
  const ys = wing.map((p) => p[1]).sort((a, b) => a - b);
  const root = ys.length > 20 ? [ys[Math.floor(ys.length * 0.1)], ys[Math.floor(ys.length * 0.9)]] : null;
  return { axis, radius: half, root, count: wing.length };
}

if (process.argv[1] && process.argv[1].endsWith('exterior.mjs')) {
  for (const id of process.argv.slice(2)) {
    const { header, points } = readExterior(`public/models/${id}.pvm`);
    const m = measure(points);
    const L = header.lengthM;
    console.log(id, `L=${L}m`, m ? `axis z=${m.axis.toFixed(4)} (${(m.axis * L).toFixed(2)}m) R=${(m.radius * L).toFixed(2)}m root y ${m.root?.map((v) => (v * L).toFixed(1)).join('..')} m (${m.count} pts)` : 'no centreline');
  }
}
