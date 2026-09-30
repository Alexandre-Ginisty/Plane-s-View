/**
 * Ambient occlusion, baked per vertex.
 *
 * A cockpit lit by a sun and a uniform sky is evenly bright everywhere — under
 * the glareshield, in the footwell, in the corner where a console meets the
 * wall — and reads as a model on a table. What the eye expects is the soft
 * dark of contact: surfaces that see less of the open sky get less of its
 * light. That is cheap to compute offline and free to draw: a grey level per
 * vertex, multiplied into the colour.
 *
 * Each vertex casts rays over a hemisphere and counts how many travel
 * `REACH_M` without meeting geometry. Source models are drawn two-sided and
 * their normals point either way, so the hemisphere sampled is the one on the
 * side of the pilot's eye (the origin): that is the side that is seen.
 *
 * Triangles are bucketed in a sparse grid; a ray walks only the cells it
 * crosses (3D DDA), so the cost stays near linear in the vertex count.
 */

const CELL_M = 0.08;
const REACH_M = 0.45;
const RAYS = 20;
/** No surface goes fully black: bounced light never quite reaches zero. */
const FLOOR = 0.28;

/** Evenly spread directions on the +Z hemisphere, cosine-weighted. */
function hemisphere(n) {
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n);
    const phi = i * golden;
    out.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - r * r)]);
  }
  return out;
}
const DIRS = hemisphere(RAYS);

/**
 * @param {{ positions: number[], normals: number[], indices: number[] }[]} meshes  what casts occlusion and what receives it
 * @returns {Uint8Array[]} per mesh, one openness byte per vertex (255 = open sky)
 */
export function bakeOcclusion(meshes, receives = meshes.map(() => true)) {
  // --- the grid ---------------------------------------------------------------
  const tris = [];
  for (const m of meshes) {
    for (let t = 0; t < m.indices.length; t += 3) {
      const at = (k) => [m.positions[m.indices[t + k] * 3], m.positions[m.indices[t + k] * 3 + 1], m.positions[m.indices[t + k] * 3 + 2]];
      tris.push([at(0), at(1), at(2)]);
    }
  }
  const grid = new Map();
  const key = (i, j, k) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  tris.forEach((tri, id) => {
    const lo = [0, 1, 2].map((a) => Math.floor(Math.min(tri[0][a], tri[1][a], tri[2][a]) / CELL_M));
    const hi = [0, 1, 2].map((a) => Math.floor(Math.max(tri[0][a], tri[1][a], tri[2][a]) / CELL_M));
    // A triangle spanning many cells (a fuselage panel) is filed in each.
    for (let i = lo[0]; i <= hi[0]; i++)
      for (let j = lo[1]; j <= hi[1]; j++)
        for (let k = lo[2]; k <= hi[2]; k++) {
          const c = key(i, j, k);
          let list = grid.get(c);
          if (!list) grid.set(c, (list = []));
          list.push(id);
        }
  });

  // --- one ray -----------------------------------------------------------------
  const stamp = new Uint32Array(tris.length);
  let ray = 0;
  const EPS = 1e-4;
  function hit(o, d) {
    ray++;
    let [i, j, k] = [0, 1, 2].map((a) => Math.floor(o[a] / CELL_M));
    const step = d.map((v) => (v > 0 ? 1 : -1));
    const tMax = [0, 1, 2].map((a) => {
      if (d[a] === 0) return Infinity;
      const edge = (Math.floor(o[a] / CELL_M) + (d[a] > 0 ? 1 : 0)) * CELL_M;
      return (edge - o[a]) / d[a];
    });
    const tDelta = d.map((v) => (v === 0 ? Infinity : CELL_M / Math.abs(v)));
    let t = 0;
    while (t < REACH_M) {
      const list = grid.get(key(i, j, k));
      if (list) {
        for (const id of list) {
          if (stamp[id] === ray) continue;
          stamp[id] = ray;
          const [a, b, c] = tris[id];
          // Möller–Trumbore.
          const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
          const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
          if (Math.abs(det) < 1e-12) continue;
          const inv = 1 / det;
          const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
          const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
          if (u < 0 || u > 1) continue;
          const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
          const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
          if (v < 0 || u + v > 1) continue;
          const dist = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
          if (dist > EPS && dist < REACH_M) return true;
        }
      }
      // Next cell.
      if (tMax[0] < tMax[1] && tMax[0] < tMax[2]) {
        t = tMax[0];
        tMax[0] += tDelta[0];
        i += step[0];
      } else if (tMax[1] < tMax[2]) {
        t = tMax[1];
        tMax[1] += tDelta[1];
        j += step[1];
      } else {
        t = tMax[2];
        tMax[2] += tDelta[2];
        k += step[2];
      }
    }
    return false;
  }

  // --- each vertex ---------------------------------------------------------------
  return meshes.map((m, mi) => {
    const n = m.positions.length / 3;
    const out = new Uint8Array(n).fill(255);
    if (!receives[mi]) return out;
    for (let v = 0; v < n; v++) {
      const p = [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]];
      const nz = [m.normals[v * 3], m.normals[v * 3 + 1], m.normals[v * 3 + 2]];
      // A basis about the normal.
      const helper = Math.abs(nz[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      let tx = [nz[1] * helper[2] - nz[2] * helper[1], nz[2] * helper[0] - nz[0] * helper[2], nz[0] * helper[1] - nz[1] * helper[0]];
      const tl = Math.hypot(...tx) || 1;
      tx = tx.map((c) => c / tl);
      const ty = [nz[1] * tx[2] - nz[2] * tx[1], nz[2] * tx[0] - nz[0] * tx[2], nz[0] * tx[1] - nz[1] * tx[0]];
      const side = nz[0] * -p[0] + nz[1] * -p[1] + nz[2] * -p[2] >= 0 ? 1 : -1;
      const o = [p[0] + nz[0] * side * 0.002, p[1] + nz[1] * side * 0.002, p[2] + nz[2] * side * 0.002];
      let open = 0;
      for (const [a, b, c] of DIRS) {
        const d = [0, 1, 2].map((k) => a * tx[k] + b * ty[k] + c * side * nz[k]);
        if (!hit(o, d)) open++;
      }
      out[v] = Math.round(255 * (FLOOR + (1 - FLOOR) * (open / DIRS.length)));
    }
    return out;
  });
}
