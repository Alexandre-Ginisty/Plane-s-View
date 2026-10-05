/**
 * The cabin itself: shell, windows, seats, and the people in them.
 *
 * Written about the passenger's eye, the frame the cockpit pass draws in: +X
 * right, +Y up, +Z aft (the camera looks down −Z), metres. The eye is the left
 * window seat's: 0.48 m from the sidewall, 1.13 m above the floor, at the row's
 * window. Everyone faces −Z, forward, so from the eye you see the backs of the
 * seats and heads ahead, and turning round you see the faces of the rows
 * behind.
 *
 * What is drawn, and why it is drawn that way:
 *
 *  - **Windows** are rounded openings with a reveal, a bezel and — on some — a
 *    shade pulled down, because a cabin's window is the one thing a passenger
 *    looks at for hours.
 *  - **Seats** are soft shapes with white headrest covers, a lit entertainment
 *    screen on the back, a tray, a pocket with a magazine in it.
 *  - **People** are `people.mjs`: a cast of funny ones in particular seats
 *    (the neighbour fast asleep, the child behind with the teddy), ordinary
 *    ones elsewhere, a flight attendant with her trolley in the aisle.
 */

import { MeshSet, vec } from './geometry.mjs';
import { figure, CHARACTERS, FUNNY, ordinary, SKINS, SHIRTS, PANTS } from './people.mjs';

export const EYE_ABOVE_FLOOR = 1.13;
export const WALL_FROM_EYE = 0.48;
export const SEAT_W = 0.45;
export const SEAT_DEPTH = 0.46;
export const WINDOW_PITCH = 0.508;
/** Rows drawn ahead of and behind the eye's own. */
export const ROWS_EACH_WAY = 9;

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const IFE = [
  // A moving map, a film, a sunset, a screen left dark.
  { color: [0.04, 0.09, 0.2], emissive: [0.07, 0.2, 0.42] },
  { color: [0.15, 0.08, 0.06], emissive: [0.36, 0.2, 0.14] },
  { color: [0.04, 0.15, 0.15], emissive: [0.09, 0.33, 0.3] },
  { color: [0.04, 0.04, 0.05], emissive: [0.02, 0.02, 0.03] },
];

export function buildCabin(cls, id, paint) {
  const set = new MeshSet();
  const M = (key) => set.get(key);
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
  const mid = (right + left) / 2;
  const L = -ROWS_EACH_WAY * cls.pitch - 1.2;
  const A = ROWS_EACH_WAY * cls.pitch + 1.2;

  // Floor, with its aisle runners.
  M('carpet').quad([left, floor, L], [right, floor, L], [right, floor, A], [left, floor, A], [0, 1, 0], 4);
  for (const [a, b] of aisles) M('runner').quad([a + 0.06, floor + 0.004, L], [b - 0.06, floor + 0.004, L], [b - 0.06, floor + 0.004, A], [a + 0.06, floor + 0.004, A], [0, 1, 0], 4);

  // Cross-section of one side, floor to ceiling.
  const wallAt = (v) => (v < 0.3 ? 0.1 - v * 0.2 : v < 0.7 ? 0.04 - (v - 0.3) * 0.1 : v < 1.5 ? 0 : (v - 1.5) * 0.35);
  const sillV = cls.windowSill;
  const topV = sillV + cls.windowH;
  const bandLo = 0.55;
  const bandHi = Math.min(1.5, cls.ceiling - 0.6);
  // Where the lining stops and the bins begin: a regional jet's ceiling is lower than a single-aisle's.
  const wallTop = cls.ceiling - 0.42;
  const profile = (side) => (v) => ({ x: side < 0 ? left + wallAt(v) : right - wallAt(v), y: floor + v });

  const strip = (side, v0, v1, mat, tile = 1.6) => {
    const p0 = profile(side)(v0);
    const p1 = profile(side)(v1);
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const l = Math.hypot(dx, dy);
    const n = side < 0 ? [dy / l, -dx / l, 0] : [-dy / l, dx / l, 0];
    const into = side < 0 ? 1 : -1;
    const nn = n[0] * into < 0 ? [-n[0], -n[1], 0] : n;
    M(mat).quad([p0.x, p0.y, L], [p0.x, p0.y, A], [p1.x, p1.y, A], [p1.x, p1.y, L], nn, tile);
  };

  for (const side of [-1, 1]) {
    strip(side, 0, 0.3, 'lower');
    strip(side, 0.3, bandLo, 'lower');
    const bandStrip = (z0, z1, v0, v1, mat) => {
      if (z1 - z0 < 1e-4 || v1 - v0 < 1e-4) return;
      const a = profile(side)(v0);
      const b = profile(side)(v1);
      const n = side < 0 ? [1, 0, 0] : [-1, 0, 0];
      M(mat).quad([a.x, a.y, z0], [a.x, a.y, z1], [b.x, b.y, z1], [b.x, b.y, z0], n, 1.6);
    };
    strip(side, bandLo, sillV - 0.04, 'wall');
    bandStrip(L, A, sillV - 0.04, sillV, 'wall');

    const r = rng(side < 0 ? 11 : 23);
    const reach = Math.floor((Math.min(-L, A) - 0.4) / WINDOW_PITCH);
    const depth = 0.06;
    const out = side < 0 ? -1 : 1;
    const inward = side < 0 ? [1, 0, 0] : [-1, 0, 0];
    const lift = side < 0 ? 0.003 : -0.003;
    // A point of the wall in (z, height-above-floor) coordinates, `d` metres outboard.
    const P = (z, v, d = 0) => {
      const q = profile(side)(v);
      return [q.x + out * d, q.y, z];
    };
    const radius = Math.min(cls.windowW, cls.windowH) * 0.46;
    const ring = 0.026;

    let zCursor = L;
    for (let b = -reach; b <= reach; b++) {
      const zc = -0.06 + b * WINDOW_PITCH;
      const wz0 = zc - cls.windowW / 2;
      const wz1 = zc + cls.windowW / 2;
      bandStrip(zCursor, wz0, sillV, topV, 'wall');
      zCursor = wz1;

      // The opening: a rounded rectangle, as a list of (z, v) round its edge.
      const path = [];
      const n = 7;
      for (const [cz, cv, a0] of [[wz1 - radius, sillV + radius, -90], [wz1 - radius, topV - radius, 0], [wz0 + radius, topV - radius, 90], [wz0 + radius, sillV + radius, 180]]) {
        for (let i = 0; i <= n; i++) {
          const a = ((a0 + (90 * i) / n) * Math.PI) / 180;
          path.push([cz + radius * Math.cos(a), cv + radius * Math.sin(a)]);
        }
      }
      // Wall filling each corner outside the curve.
      [[wz1, sillV], [wz1, topV], [wz0, topV], [wz0, sillV]].forEach((corner, k) => {
        for (let i = 0; i < n; i++) {
          const p = path[k * (n + 1) + i];
          const q = path[k * (n + 1) + i + 1];
          M('wall').quad(P(corner[0], corner[1]), P(p[0], p[1]), P(q[0], q[1]), P(q[0], q[1]), inward, 1.6);
        }
      });
      // The reveal: the thickness of the wall, round the opening.
      const centre = [zc, (sillV + topV) / 2];
      for (let i = 0; i < path.length; i++) {
        const p = path[i];
        const q = path[(i + 1) % path.length];
        const nrm = vec.norm([0, centre[1] - (p[1] + q[1]) / 2, centre[0] - (p[0] + q[0]) / 2]);
        M('frame').quad(P(p[0], p[1]), P(q[0], q[1]), P(q[0], q[1], depth), P(p[0], p[1], depth), nrm, 2);
      }
      // The bezel, standing a little proud of the wall.
      const grow = (p) => {
        const d = vec.norm([p[0] - centre[0], p[1] - centre[1], 0]);
        return [p[0] + d[0] * ring, p[1] + d[1] * ring * 1.0];
      };
      for (let i = 0; i < path.length; i++) {
        const p = path[i];
        const q = path[(i + 1) % path.length];
        const pg = grow(p);
        const qg = grow(q);
        M('frame').quad(P(p[0], p[1], -lift * 0), P(q[0], q[1]), P(qg[0], qg[1]), P(pg[0], pg[1]), inward, 4);
      }
      // A shade, pulled down on some of them.
      const shadeRoll = r();
      if (shadeRoll < 0.34) {
        const f = shadeRoll < 0.08 ? 1 : 0.35 + r() * 0.5;
        const vs = topV - f * (topV - sillV);
        const clipped = path.filter((p) => p[1] >= vs - 1e-6);
        // Close the polygon along the shade's lower edge.
        const lowZ = clipped.map((p) => p[0]);
        if (clipped.length > 2) {
          const polygon = [...clipped.filter((p) => p[1] >= vs)];
          const zMin = Math.min(...lowZ);
          const zMax = Math.max(...lowZ);
          const c = [(zMin + zMax) / 2, (vs + topV) / 2];
          const shadeKey = f === 1 ? 'shadeClosed' : 'shade';
          polygon.sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
          for (let i = 0; i < polygon.length; i++) {
            const p = polygon[i];
            const q = polygon[(i + 1) % polygon.length];
            M(shadeKey).quad(P(c[0], c[1], depth * 0.55), P(p[0], p[1], depth * 0.55), P(q[0], q[1], depth * 0.55), P(q[0], q[1], depth * 0.55), inward, 3);
          }
          M('frame').quad(P(zc - 0.03, vs - 0.012, depth * 0.5), P(zc + 0.03, vs - 0.012, depth * 0.5), P(zc + 0.03, vs, depth * 0.5), P(zc - 0.03, vs, depth * 0.5), inward, 3);
        }
      }
    }
    bandStrip(zCursor, A, sillV, topV, 'wall');
    bandStrip(L, A, topV, bandHi, 'wall');
    strip(side, bandHi, wallTop, 'wall');
    // Panel seams between window bays: a thin dark line, as on a real lining.
    for (let b = -reach; b <= reach + 1; b++) {
      const z = -0.06 + (b - 0.5) * WINDOW_PITCH;
      const lo = profile(side)(bandLo);
      const hi = profile(side)(wallTop);
      M('seam').quad([lo.x, lo.y, z - 0.002], [lo.x, lo.y, z + 0.002], [hi.x, hi.y, z + 0.002], [hi.x, hi.y, z - 0.002], inward, 1);
    }
  }

  // Overhead bins and the service strip, either side of the ceiling.
  const binZ = 1.6;
  for (const side of [-1, 1]) {
    const edge = side < 0 ? left : right;
    const inner = side < 0 ? left + 0.95 : right - 0.95;
    const flip = side < 0 ? 1 : -1;
    const base = floor + wallTop;
    const top = floor + cls.ceiling - 0.06;
    for (let z = L + 0.2; z < A - binZ; z += binZ) {
      const z1 = z + binZ - 0.03;
      M('bin').quad([edge + flip * 0.16, base, z], [edge + flip * 0.16, base, z1], [inner, top - 0.08, z1], [inner, top - 0.08, z], [flip * 0.55, -0.4, 0], 1.6);
      M('bin').quad([edge + flip * 0.16, base, z], [edge + flip * 0.16, base, z1], [edge + flip * 0.04, base - 0.06, z1], [edge + flip * 0.04, base - 0.06, z], [flip * 0.2, -1, 0], 1.6);
      M('dark').quad([edge + flip * 0.4, base + 0.16, z], [edge + flip * 0.4, base + 0.16, z1], [edge + flip * 0.4, base + 0.17, z1], [edge + flip * 0.4, base + 0.17, z], [flip * 0.55, -0.4, 0], 1);
      // The latch at the middle of each door.
      M('plastic').pillow(edge + flip * 0.5, base + 0.1, (z + z1) / 2, 0.02, 0.02, 0.18, 0.4, 4);
    }
    M('ceiling').quad([inner, top - 0.08, L], [inner, top - 0.08, A], [mid, floor + cls.ceiling, A], [mid, floor + cls.ceiling, L], [0, -1, 0], 1.2);
  }
  // Service strip: lit reading lamps, air vents and the call button, over each seat column.
  for (const dx of [-0.72, 0.72]) {
    for (let z = L + 0.3; z < A - 0.3; z += 0.81) {
      M('light').box(mid + dx, floor + cls.ceiling - 0.06, z, 0.12, 0.012, 0.05);
      M('dark').box(mid + dx, floor + cls.ceiling - 0.055, z + 0.17, 0.05, 0.012, 0.05);
      M('plastic').box(mid + dx, floor + cls.ceiling - 0.058, z - 0.17, 0.04, 0.01, 0.025);
    }
  }
  // The lit ceiling panel down the middle.
  M('ceilingLight').quad([mid - 0.25, floor + cls.ceiling - 0.004, L], [mid + 0.25, floor + cls.ceiling - 0.004, L], [mid + 0.25, floor + cls.ceiling - 0.004, A], [mid - 0.25, floor + cls.ceiling - 0.004, A], [0, -1, 0], 1);

  // Bulkheads at either end, each with a curtain.
  for (const [z, n] of [[L, 1], [A, -1]]) {
    M('wall').quad([left, floor, z], [right, floor, z], [right, floor + cls.ceiling, z], [left, floor + cls.ceiling, z], [0, 0, n], 1.6);
    M('curtain').pillow(mid, floor + 1.15, z - n * 0.03, (right - left) * 0.6, 2.0, 0.04, 0.2, 6);
    M('dark').box(mid, floor + 0.05, z - n * 0.03, (right - left) * 0.62, 0.1, 0.03);
  }

  // --- Seats and the people in them ---------------------------------------------------
  const rand = rng(id.length * 977 + 31);
  const sitting = floor + 0.44;
  const cushionTop = sitting + 0.05;
  const personY = cushionTop - 0.04;
  const nCols = columns.length;
  const aisleSide = (c) => c === nCols - 1 || columns[c + 1] - columns[c] > SEAT_W + 0.05 || (c > 0 && columns[c] - columns[c - 1] > SEAT_W + 0.05);

  /** Who sits where: a few fixed characters near the eye, the rest drawn from the cast. */
  const fixed = new Map([
    ['0,1', ['sleeper', -1]],
    ['0,2', ['eater']],
    ['1,0', ['kid']],
    ['1,1', ['parent']],
    ['2,0', ['selfie']],
    ['2,1', ['starer']],
    ['-1,0', ['musicLover']],
    ['-1,1', ['cowboy']],
    ['-2,0', ['holiday']],
    ['3,0', ['granny']],
    ['3,1', ['nervous']],
    ['4,0', ['party']],
    ['-3,0', ['newspaper']],
  ]);
  const funnyPool = FUNNY.filter((n) => !['sleeper'].includes(n));
  const pickPerson = (row, c) => {
    const key = `${row},${c}`;
    if (fixed.has(key)) {
      const [name, arg] = fixed.get(key);
      return CHARACTERS[name](rand, arg);
    }
    return rand() < 0.4 ? CHARACTERS[funnyPool[Math.floor(rand() * funnyPool.length)]](rand) : ordinary(rand);
  };

  for (let row = -ROWS_EACH_WAY; row <= ROWS_EACH_WAY; row++) {
    const z = row * cls.pitch;
    columns.forEach((cx, c) => {
      const own = row === 0 && c === 0;
      const aisle = aisleSide(c);
      const ife = IFE[Math.floor(rand() * IFE.length)];
      const ifeKey = paint(ife.color, { emissive: ife.emissive });

      // The cushion and the frame under it.
      M('fabric').pillow(cx, sitting, z, SEAT_W - 0.02, 0.1, SEAT_DEPTH, 0.35, 6);
      M('dark').box(cx - SEAT_W / 2 + 0.06, sitting - 0.22, z + 0.03, 0.03, 0.44, 0.05);
      M('dark').box(cx + SEAT_W / 2 - 0.06, sitting - 0.22, z + 0.03, 0.03, 0.44, 0.05);
      M('dark').box(cx, sitting - 0.2, z + 0.1, SEAT_W - 0.1, 0.03, 0.04);
      // Armrests; the one on the aisle is a little proud.
      for (const dx of [-1, 1]) {
        M('plastic').pillow(cx + (dx * SEAT_W) / 2, sitting + 0.15, z, 0.045, 0.06, SEAT_DEPTH - 0.06, 0.4, 4);
      }

      if (!own) {
        set.within(() => {
          // The back leans a little aft.
          set.xf.translate(cx, cushionTop - 0.02, z + SEAT_DEPTH / 2 - 0.02);
          set.xf.rotateX(0.13);
          M('fabric').pillow(0, 0.28, 0, SEAT_W - 0.02, 0.52, 0.1, 0.35, 7);
          // Headrest, with its white cover and the wings that hold a sleeper's head.
          M('cover').pillow(0, 0.58, 0.012, 0.3, 0.17, 0.095, 0.35, 7);
          for (const dx of [-1, 1]) M('fabric').pillow(dx * 0.165, 0.57, -0.025, 0.06, 0.16, 0.085, 0.4, 5);
          // On the back of it, for whoever sits behind: shell, screen, tray, pocket, magazine.
          M('plastic').pillow(0, 0.27, 0.056, SEAT_W - 0.06, 0.46, 0.016, 0.3, 5);
          M('dark').pillow(0, 0.36, 0.066, 0.3, 0.19, 0.012, 0.3, 5);
          M(ifeKey).pillow(0, 0.36, 0.073, 0.27, 0.165, 0.004, 0.3, 5);
          M('plastic').pillow(0, 0.2, 0.066, 0.34, 0.03, 0.014, 0.4, 4);
          M('dark').pillow(0, 0.09, 0.064, SEAT_W - 0.14, 0.11, 0.014, 0.3, 4);
          if (rand() < 0.5) M(paint([0.9 - rand() * 0.5, 0.3 + rand() * 0.4, 0.3 + rand() * 0.5])).pillow((rand() - 0.5) * 0.1, 0.12, 0.072, 0.18, 0.17, 0.004, 0.2, 4);
        });
      }

      // The person in it.
      if (own) return;
      if (rand() > 0.82 && !fixed.has(`${row},${c}`)) return;
      const spec = pickPerson(row, c);
      if (!spec.skin) spec.skin = ordinary(rand).skin;
      // Faces are on the side the camera can see: the rows behind, and the window seat just ahead, side on.
      const facing = row > 0 || (row < 0 && c === 0 && row >= -2) || (row === 0 && c === 1);
      const detail = row === 0 && c === 1 ? 2 : !facing ? 0 : row > 4 ? 0.5 : 1;
      if (!facing) spec.faceHidden = true;
      figure(set, paint, spec, [cx, personY, z], detail);
      // A lap belt, buckled.
      if (detail >= 1) {
        M('belt').pillow(cx, cushionTop + 0.14, z - 0.02, SEAT_W - 0.06, 0.012, 0.06, 0.4, 4);
        M('metal').pillow(cx, cushionTop + 0.145, z - 0.055, 0.05, 0.015, 0.03, 0.4, 4);
      }
      void aisle;
    });
  }

  // Your own knees, hands and shoes, for when you look down.
  figure(
    set,
    paint,
    { skin: SKINS[1], shirt: { color: SHIRTS[1], kind: 'hoodie' }, longSleeves: true, pants: PANTS[0], shoes: [0.95, 0.95, 0.95], pose: 'lap', build: 1, hideLeftArm: true },
    [columns[0], personY, 0],
    2,
    { own: true },
  );

  // --- The crew: a flight attendant with her trolley, ahead in the aisle ----------------
  if (aisles.length) {
    const [a0, a1] = aisles[0];
    const ax = (a0 + a1) / 2;
    const az = -3.0;
    const attendant = CHARACTERS.attendant(rand);
    attendant.pose = 'serve';
    attendant.prop = { kind: 'coffeepot' };
    attendant.skin = ordinary(rand).skin;
    figure(set, paint, attendant, [ax, floor + 0.87, az], 2, { yaw: Math.PI, standing: true });
    // The trolley, between her and the camera.
    const tz = az + 0.8;
    const steel = M('steel');
    steel.pillow(ax, floor + 0.55, tz, 0.4, 0.9, 0.8, 0.15, 6);
    M('dark').pillow(ax, floor + 1.01, tz, 0.41, 0.02, 0.81, 0.2, 4);
    for (let i = 0; i < 4; i++) M('plastic').pillow(ax, floor + 0.2 + i * 0.2, tz - 0.405, 0.3, 0.012, 0.012, 0.4, 4);
    for (let i = 0; i < 5; i++) {
      const bx = ax - 0.14 + i * 0.07;
      M(paint(i % 2 ? [0.85, 0.15, 0.15] : [0.2, 0.4, 0.8])).tube(bx, floor + 1.02, tz + 0.1, 0.022, 0.018, 0.14, 8);
    }
    M('white').pillow(ax, floor + 1.04, tz - 0.15, 0.26, 0.02, 0.2, 0.3, 4);
    for (const dz of [-0.3, 0.3]) for (const dx of [-0.16, 0.16]) M('dark').tube(ax + dx, floor, tz + dz, 0.03, 0.03, 0.04, 8);
  }

  return { meshes: set.meshes };
}
