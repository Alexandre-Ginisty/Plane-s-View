/**
 * People for the cabins: stylised, a little exaggerated, and meant to be funny.
 *
 * A passenger is a handful of soft solids — a big expressive head, a soft body,
 * limbs stretched between joints — dressed and posed from a short description:
 * skin, hair, a hat, a face, a shirt, a pose, something in the hands. Heads
 * are built about their own centre and tilted as a whole, so a sleeper's
 * head can loll onto a shoulder with its mask, pillow and open mouth turning
 * with it.
 *
 * Figures are drawn in a frame of their own: origin at the middle of the seat
 * cushion's top, +X right, +Y up, +Z aft, facing −Z (forward). `detail` says
 * how much of one can be seen from where anyone will look: 0 the back of the
 * head and the shoulders (the rows ahead), 1 the face and the upper body, 2
 * the whole person (a neighbour, a standing flight attendant).
 */

// --- palettes --------------------------------------------------------------------

export const SKINS = [
  [0.97, 0.79, 0.66],
  [0.91, 0.71, 0.56],
  [0.8, 0.58, 0.42],
  [0.62, 0.42, 0.3],
  [0.43, 0.28, 0.2],
  [0.31, 0.2, 0.15],
];
export const HAIRS = {
  black: [0.07, 0.06, 0.06],
  brown: [0.25, 0.15, 0.09],
  chestnut: [0.4, 0.24, 0.12],
  blond: [0.84, 0.69, 0.36],
  ginger: [0.7, 0.3, 0.1],
  grey: [0.62, 0.62, 0.64],
  white: [0.92, 0.92, 0.92],
  pink: [0.95, 0.4, 0.62],
  blue: [0.25, 0.5, 0.95],
  green: [0.3, 0.75, 0.4],
};
export const SHIRTS = [
  [0.85, 0.2, 0.18], [0.2, 0.42, 0.78], [0.95, 0.75, 0.15], [0.25, 0.65, 0.4], [0.92, 0.92, 0.9], [0.15, 0.17, 0.22],
  [0.9, 0.45, 0.15], [0.55, 0.3, 0.7], [0.3, 0.7, 0.75], [0.85, 0.5, 0.6], [0.45, 0.45, 0.5], [0.55, 0.15, 0.25],
];
export const PANTS = [
  [0.16, 0.2, 0.32], [0.1, 0.1, 0.12], [0.45, 0.38, 0.28], [0.3, 0.32, 0.38], [0.55, 0.5, 0.42], [0.2, 0.3, 0.45],
];
const SHOES = [[0.95, 0.95, 0.95], [0.1, 0.1, 0.1], [0.4, 0.25, 0.15], [0.8, 0.15, 0.15], [0.2, 0.4, 0.8]];
const EYES = [[0.28, 0.17, 0.08], [0.2, 0.4, 0.75], [0.25, 0.55, 0.3], [0.12, 0.1, 0.1], [0.45, 0.35, 0.15]];

const shade = (c, f) => c.map((v) => Math.min(1, Math.max(0, Math.round(v * f * 24) / 24)));
const WHITE = [0.97, 0.97, 0.95];
const DARK = [0.05, 0.05, 0.06];
const MOUTH = [0.32, 0.07, 0.08];
const TONGUE = [0.9, 0.38, 0.45];
const GOLD = [0.9, 0.7, 0.2];

// --- a figure ---------------------------------------------------------------------

/**
 * @param set   a MeshSet
 * @param paint (rgb, opts?) → material key
 * @param s     the description (see `cast`)
 * @param at    [x, y, z]: the middle of the cushion's top
 * @param detail 0, 1 or 2
 * @param opts  { yaw: turn the whole figure about the vertical (π = facing aft) }
 */
export function figure(set, paint, s, at, detail = 1, opts = {}) {
  const P = (rgb, o) => paint(rgb, o);
  const skin = s.skin;
  const hairRgb = HAIRS[s.hair?.color ?? 'brown'] ?? HAIRS.brown;
  const shirt = s.shirt?.color ?? SHIRTS[0];
  const pants = s.pants ?? PANTS[0];
  const build = s.build ?? 1;
  const seg = detail >= 2 ? 14 : detail >= 1 ? 10 : 8;
  const S = set;
  const M = (rgb, o) => S.get(P(rgb, o));
  // What is seen from arm's length is built finer than what is seen from across the cabin.
  const quality = S.xf.quality;
  S.xf.quality = detail >= 2 ? 1.7 : detail >= 1 ? 1 : detail >= 0.5 ? 0.75 : 0.62;

  S.within(() => {
    S.xf.translate(at[0], at[1], at[2]);
    if (opts.yaw) S.xf.rotateY(opts.yaw);
    // The upper body leans a little: a slouch, or a sleeper folded forward.
    const lean = s.lean ?? 0;

    // --- legs and lap (seated, a neighbour or the crew) ---
    if (detail >= 2) legs(S, M, s, pants, build, opts.standing);

    // --- torso ---
    S.within(() => {
      S.xf.translate(0, 0.1, 0.1);
      S.xf.rotateX(lean);
      S.xf.translate(0, -0.1, -0.1);
      if (!opts.own) torso(S, M, s, shirt, skin, build, detail, seg);
      arms(S, M, s, shirt, skin, build, detail);
      if (!opts.own) neckAndHead(S, M, s, skin, hairRgb, detail, seg);
    });
    if (s.prop && detail >= 1) prop(S, M, s);
  });
  S.xf.quality = quality;
}

function torso(S, M, s, shirt, skin, build, detail, seg) {
  const w = build;
  const body = M(shirt);
  const rz = 0.13 * (0.9 + 0.15 * w);
  // Width and depth of the chest at a height, so decorations sit on the cloth.
  const slice = (y) => Math.sqrt(Math.max(0.02, 1 - ((y - 0.31) / 0.28) ** 2));
  const front = (x, y) => 0.1 - rz * Math.sqrt(Math.max(0.02, 1 - ((y - 0.31) / 0.28) ** 2 - (x / (0.2 * w)) ** 2)) - 0.003;
  // Hips and seat of the trousers are hidden behind the seat; the shirt starts at the belly.
  body.ellipsoid(0, 0.31, 0.1, 0.2 * w, 0.28, rz, seg);
  // Shoulders.
  for (const side of [-1, 1]) body.ellipsoid(side * 0.2 * w, 0.5, 0.11, 0.065, 0.065, 0.075, 7);
  if (build > 1.1) body.ellipsoid(0, 0.2, -0.015, 0.18 * w, 0.14, 0.12, seg); // belly
  // Neck skin and a collar.
  M(skin).ellipsoid(0, 0.595, 0.11, 0.045, 0.06, 0.045, 7);
  // Patterns are on the front, behind the seat for most of the cabin.
  switch (detail >= 1 ? (s.shirt?.kind ?? 'tee') : 'tee') {
    case 'hawaii': {
      const flower = [WHITE, [1, 0.85, 0.2], [1, 0.5, 0.65]];
      for (let i = 0; i < 11; i++) {
        const x = Math.sin(i * 2.4) * 0.15 * w;
        const y = 0.12 + ((i * 37) % 10) * 0.045;
        M(flower[i % 3]).ellipsoid(x, y, front(x, y), 0.027, 0.027, 0.008, 6);
      }
      M(shade(shirt, 0.7)).torus(0, 0.565, 0.11, 0.05, 0.012, 10, 4);
      break;
    }
    case 'suit': {
      M(WHITE).ellipsoid(0, 0.4, front(0, 0.4) + 0.004, 0.05 * w, 0.17, 0.014, 7);
      const tie = M(s.shirt.tie ?? [0.75, 0.1, 0.15]);
      tie.ellipsoid(0, 0.36, front(0, 0.36) - 0.004, 0.017, 0.15, 0.01, 6);
      tie.ellipsoid(0, 0.535, front(0, 0.535) - 0.004, 0.026, 0.026, 0.012, 6);
      break;
    }
    case 'hoodie': {
      M(shade(shirt, 0.85)).torus(0, 0.56, 0.12, 0.075, 0.03, 12, 5);
      M(WHITE).limb([-0.03, 0.42, front(-0.03, 0.42) - 0.004], [-0.035, 0.3, front(-0.035, 0.3) - 0.004], 0.006, 0.006, 5);
      M(WHITE).limb([0.03, 0.42, front(0.03, 0.42) - 0.004], [0.035, 0.3, front(0.035, 0.3) - 0.004], 0.006, 0.006, 5);
      M(shade(shirt, 0.9)).ellipsoid(0, 0.15, front(0, 0.15) + 0.004, 0.12 * w, 0.06, 0.03, 7);
      break;
    }
    case 'stripes': {
      for (let i = 0; i < 5; i++) {
        const y = 0.13 + i * 0.1;
        const k = slice(y) * 1.02;
        M(WHITE).ellipsoid(0, y, 0.1, 0.2 * w * k, 0.024, rz * k, 9);
      }
      break;
    }
    case 'uniform': {
      M(WHITE).ellipsoid(0, 0.45, front(0, 0.45) + 0.004, 0.055, 0.1, 0.014, 7);
      M([0.8, 0.12, 0.2]).torus(0, 0.575, 0.11, 0.05, 0.016, 10, 4);
      M([0.8, 0.12, 0.2]).ellipsoid(0.02, 0.5, front(0.02, 0.5) - 0.004, 0.03, 0.045, 0.014, 6);
      M(GOLD).ellipsoid(0.1, 0.42, front(0.1, 0.42) - 0.003, 0.016, 0.016, 0.008, 6);
      break;
    }
    default:
      M(shade(shirt, 0.82)).torus(0, 0.57, 0.11, 0.052, 0.011, 10, 4);
  }
  if (s.scarf) M(s.scarf).torus(0, 0.57, 0.115, 0.06, 0.022, 12, 5);
  if (s.neckPillow && detail >= 1) {
    // A horseshoe round the neck, open at the front.
    S.within(() => {
      S.xf.translate(0, 0.585, 0.115);
      S.xf.rotateY(Math.PI * 0.5 + 0.22);
      M(s.neckPillow).torus(0, 0, 0, 0.088, 0.034, 14, 6, 0.78, 0.03);
    });
  }
}

function arms(S, M, s, shirt, skin, build, detail) {
  if (detail < 1) {
    return;
  }
  const w = build;
  const sleeve = M(s.shirt?.kind === 'hawaii' ? shade(shirt, 0.95) : shirt);
  const bare = M(skin);
  const pose = POSES[s.pose ?? 'rest'] ?? POSES.rest;
  for (const side of [-1, 1]) {
    // Your own arm on the wall side would hang in the corner of the window view.
    if (s.hideLeftArm && side === -1) continue;
    const p = pose(side, s);
    if (!p) continue;
    const sh = [side * 0.215 * w, 0.5, 0.11];
    sleeve.limb(sh, p.elbow, 0.058);
    const long = s.longSleeves;
    (long ? sleeve : bare).limb(p.elbow, p.hand, 0.045);
    // The hand, with a thumb.
    bare.ellipsoid(p.hand[0], p.hand[1], p.hand[2], 0.04, 0.032, 0.05, 7);
    bare.ellipsoid(p.hand[0] - side * 0.035, p.hand[1] + 0.012, p.hand[2] - 0.025, 0.014, 0.014, 0.03, 5);
    if (s.watch && side === -1) M([0.15, 0.15, 0.17]).ellipsoid(p.elbow[0] * 0.2 + p.hand[0] * 0.8, p.elbow[1] * 0.2 + p.hand[1] * 0.8, p.elbow[2] * 0.2 + p.hand[2] * 0.8, 0.05, 0.016, 0.04, 6);
  }
}

/** Joint positions for each pose, per side (−1 left, +1 right), in the figure's frame. */
const POSES = {
  rest: (side) => ({ elbow: [side * 0.25, 0.27, 0.06], hand: [side * 0.2, 0.25, -0.2] }),
  /** Hands on the armrests, white-knuckled and shoulders up. */
  clench: (side) => ({ elbow: [side * 0.26, 0.3, 0.02], hand: [side * 0.25, 0.24, -0.14] }),
  /** Holding a phone up in front of the face. */
  phone: (side) =>
    side > 0 ? { elbow: [0.2, 0.3, -0.1], hand: [0.07, 0.52, -0.3] } : { elbow: [-0.25, 0.27, 0.05], hand: [-0.2, 0.22, -0.16] },
  /** Selfie: arm out, the other hand making a V. */
  selfie: (side) =>
    side > 0 ? { elbow: [0.26, 0.42, -0.14], hand: [0.2, 0.62, -0.4] } : { elbow: [-0.3, 0.55, -0.05], hand: [-0.28, 0.7, -0.12] },
  /** A book held up, both hands. */
  book: (side) => ({ elbow: [side * 0.22, 0.3, -0.06], hand: [side * 0.1, 0.4, -0.27] }),
  /** A newspaper wide open: elbows out. */
  paper: (side) => ({ elbow: [side * 0.34, 0.4, -0.08], hand: [side * 0.3, 0.55, -0.3] }),
  /** Both arms in the air. */
  cheer: (side) => ({ elbow: [side * 0.34, 0.68, 0.1], hand: [side * 0.3, 0.9, 0.08] }),
  /** One arm up, waving. */
  wave: (side) =>
    side > 0 ? { elbow: [0.32, 0.62, 0.0], hand: [0.3, 0.84, -0.06] } : { elbow: [-0.25, 0.27, 0.06], hand: [-0.2, 0.25, -0.2] },
  /** Arms folded across the chest. */
  folded: (side) => ({ elbow: [side * 0.22, 0.33, -0.03], hand: [-side * 0.1, 0.4, -0.12] }),
  /** Hands together in front of the face. */
  pray: (side) => ({ elbow: [side * 0.19, 0.37, -0.06], hand: [side * 0.02, 0.5, -0.2] }),
  /** A hand to the mouth, the other holding the food's tray. */
  eat: (side) =>
    side > 0 ? { elbow: [0.22, 0.36, -0.08], hand: [0.03, 0.55, -0.2] } : { elbow: [-0.24, 0.27, 0.0], hand: [-0.15, 0.24, -0.3] },
  /** Both hands forward on a tray: a laptop, a meal. */
  tray: (side) => ({ elbow: [side * 0.24, 0.28, 0.0], hand: [side * 0.1, 0.22, -0.3] }),
  /** One hand up to the chin, the other down: thinking. */
  think: (side) =>
    side > 0 ? { elbow: [0.22, 0.34, -0.08], hand: [0.04, 0.48, -0.17] } : { elbow: [-0.25, 0.27, 0.06], hand: [-0.2, 0.25, -0.2] },
  /** A thumb up, the other hand on the armrest. */
  thumbs: (side) =>
    side > 0 ? { elbow: [0.27, 0.45, -0.1], hand: [0.2, 0.6, -0.3] } : { elbow: [-0.25, 0.27, 0.06], hand: [-0.2, 0.25, -0.2] },
  /** Hands resting on the thighs: the view down at one's own lap. */
  lap: (side) => ({ elbow: [side * 0.22, 0.22, 0.05], hand: [side * 0.12, 0.17, -0.22] }),
  /** Standing, one hand at the side and the other holding something out in front. */
  serve: (side) =>
    side > 0 ? { elbow: [0.27, 0.3, -0.02], hand: [0.2, 0.28, -0.3] } : { elbow: [-0.26, 0.22, 0.09], hand: [-0.27, -0.06, 0.07] },
  /** Holding something on the lap in both arms: a baby, a cat. */
  hold: (side) => ({ elbow: [side * 0.2, 0.26, -0.04], hand: [side * 0.05, 0.2, -0.26] }),
};

function legs(S, M, s, pants, build, standing) {
  const w = build;
  const leg = M(pants);
  const shoe = M(s.shoes ?? SHOES[1]);
  const sole = M(WHITE);
  if (standing) {
    for (const side of [-1, 1]) {
      leg.limb([side * 0.09, 0.2, 0.08], [side * 0.1, -0.2, 0.04], 0.075 * w, 0.075 * w, 8, 0.6, 0.3);
      leg.limb([side * 0.1, -0.2, 0.04], [side * 0.1, -0.76, 0.0], 0.06 * w, 0.06 * w, 8, 0.6, 0.2);
      shoe.ellipsoid(side * 0.1, -0.84, -0.05, 0.055, 0.04, 0.13, 8);
      sole.ellipsoid(side * 0.1, -0.87, -0.05, 0.056, 0.012, 0.13, 8);
    }
    return;
  }
  for (const side of [-1, 1]) {
    const knee = [side * 0.105, 0.17, -0.3 - (s.sprawl ?? 0) * 0.04];
    leg.limb([side * 0.09, 0.12, 0.08], knee, 0.078 * w, 0.078 * w, 8, 0.6, 0.35);
    leg.limb(knee, [side * 0.1 + side * (s.sprawl ?? 0) * 0.04, -0.36, -0.33], 0.062 * w, 0.062 * w, 8, 0.6, 0.2);
    shoe.ellipsoid(side * 0.1 + side * (s.sprawl ?? 0) * 0.04, -0.43, -0.4, 0.055, 0.04, 0.13, 8);
    sole.ellipsoid(side * 0.1 + side * (s.sprawl ?? 0) * 0.04, -0.46, -0.4, 0.056, 0.012, 0.13, 8);
  }
}

function neckAndHead(S, M, s, skin, hairRgb, detail, seg) {
  S.within(() => {
    const h = s.head ?? {};
    S.xf.translate(0, 0.7 + (h.dy ?? 0), 0.1 + (h.dz ?? 0));
    S.xf.rotateY(h.yaw ?? 0);
    S.xf.rotateX(h.pitch ?? 0);
    S.xf.rotateZ(h.roll ?? 0);
    const size = s.headSize ?? 1.08;
    S.xf.scale(size, size, size);
    headShape(S, M, s, skin, detail, seg);
    hair(S, M, s, hairRgb, skin);
    gear(S, M, s, hairRgb, skin, detail);
  });
}

function headShape(S, M, s, skin, detail, seg) {
  const k = M(skin);
  k.ellipsoid(0, 0.01, 0.005, 0.098, 0.108, 0.1, seg + 2);
  // From behind, a skull is all there is: no jaw, no ears to add up over a cabin of them.
  if (detail < 0.5) return;
  k.ellipsoid(0, -0.04, -0.012, 0.084, 0.07, 0.088, seg);
  for (const side of [-1, 1]) k.ellipsoid(side * 0.097, -0.004, 0.012, 0.011, 0.03, 0.02, 6);
  if (s.faceHidden) return;
  face(S, M, s, skin, detail);
}

function face(S, M, s, skin, detail) {
  const f = s.face ?? {};
  const bearded = s.beard;
  const eyeScale = f.eyes === 'wide' ? 1.55 : f.eyes === 'tiny' ? 0.75 : 1;
  const ey = 0.018;
  const ex = 0.037 * (f.eyes === 'wide' ? 1.1 : 1);
  const ez = -0.084;
  const white = M(WHITE);
  const iris = M(s.eyeColor ?? EYES[0]);
  const pupil = M(DARK);
  const lash = M(DARK);
  const gaze = f.gaze ?? [0, 0];
  const closed = f.eyes === 'closed' || f.eyes === 'sleep';
  const half = f.eyes === 'sleepy';

  for (const side of [-1, 1]) {
    if (closed) {
      // A closed eye: a lid and a lash line, drooping to the outside.
      S.within(() => {
        S.xf.translate(side * ex, ey - 0.002, ez - 0.012);
        S.xf.rotateZ(-side * 0.18);
        lash.ellipsoid(0, 0, 0, 0.022, 0.0042, 0.006, 6);
      });
      continue;
    }
    const es = detail >= 2 ? 16 : 12;
    white.ellipsoid(side * ex, ey, ez, 0.022 * eyeScale, 0.026 * eyeScale, 0.014, es);
    const gx = gaze[0] * 0.007 * eyeScale;
    const gy = gaze[1] * 0.007 * eyeScale;
    iris.ellipsoid(side * ex + gx + (f.eyes === 'cross' ? -side * 0.009 : 0), ey + gy, ez - 0.0125, 0.0125 * eyeScale, 0.0145 * eyeScale, 0.006, es - 2);
    pupil.ellipsoid(side * ex + gx + (f.eyes === 'cross' ? -side * 0.009 : 0), ey + gy, ez - 0.0165, 0.0068 * eyeScale, 0.0078 * eyeScale, 0.004, es - 4);
    if (half) {
      // A heavy lid over the top half.
      M(shade(skin, 0.94)).ellipsoid(side * ex, ey + 0.012 * eyeScale, ez - 0.004, 0.0245, 0.016, 0.015, 7);
    }
  }

  // Brows: where the mood is.
  const brow = M(s.browColor ?? shade(HAIRS[s.hair?.color ?? 'brown'] ?? HAIRS.brown, 0.8));
  const tilt = { angry: 0.38, worried: -0.4, flat: 0, up: -0.16, down: 0.14, none: null }[f.brows ?? 'flat'];
  if (tilt !== null && tilt !== undefined) {
    for (const side of [-1, 1]) {
      S.within(() => {
        S.xf.translate(side * ex, ey + 0.045 * (f.eyes === 'wide' ? 1.3 : 1) + (f.brows === 'up' ? 0.012 : 0), ez - 0.004);
        S.xf.rotateZ(side * tilt);
        brow.ellipsoid(0, 0, 0, 0.026, 0.0065, 0.008, 6);
      });
    }
  }

  // Nose.
  const nose = s.nose ?? 1;
  M(shade(skin, 0.94)).ellipsoid(0, -0.01, -0.099, 0.017 * nose, 0.022 * nose, 0.02 * nose, 7);
  M(shade(skin, 0.9)).ellipsoid(0, -0.024, -0.108 - (nose - 1) * 0.012, 0.015 * nose, 0.013 * nose, 0.014 * nose, 6);
  if (s.noseColor) M(s.noseColor).ellipsoid(0, -0.024, -0.113 - (nose - 1) * 0.012, 0.013 * nose, 0.012 * nose, 0.011 * nose, 6);

  // Cheeks.
  if (detail >= 1) {
    const blush = skin.map((c, i) => Math.round((c * 0.62 + [0.95, 0.45, 0.45][i] * 0.38) * 24) / 24);
    for (const side of [-1, 1]) M(blush).ellipsoid(side * 0.062, -0.028, -0.07, 0.019, 0.015, 0.012, 5);
  }

  // Mouth.
  const mz = bearded ? -0.112 : -0.087;
  const mouth = M(MOUTH);
  const my = -0.058;
  const m = f.mouth ?? 'smile';
  const teeth = M(WHITE);
  switch (m) {
    case 'grin': {
      mouth.ellipsoid(0, my, mz, 0.036, 0.02, 0.012, 8);
      teeth.ellipsoid(0, my + 0.009, mz - 0.007, 0.032, 0.0072, 0.007, 6);
      break;
    }
    case 'open': {
      mouth.ellipsoid(0, my - 0.008, mz, 0.027, 0.032, 0.014, 8);
      M(TONGUE).ellipsoid(0, my - 0.021, mz - 0.006, 0.017, 0.011, 0.009, 6);
      teeth.ellipsoid(0, my + 0.016, mz - 0.007, 0.02, 0.006, 0.006, 6);
      break;
    }
    case 'snore': {
      // Slack, lopsided and open.
      mouth.ellipsoid(0.006, my - 0.006, mz, 0.022, 0.026, 0.013, 8);
      M(TONGUE).ellipsoid(0.004, my - 0.016, mz - 0.006, 0.013, 0.008, 0.008, 6);
      M([0.75, 0.88, 0.95]).ellipsoid(0.018, my - 0.034, mz - 0.006, 0.006, 0.011, 0.006, 5); // drool
      break;
    }
    case 'shock': {
      mouth.ellipsoid(0, my - 0.004, mz, 0.016, 0.022, 0.012, 7);
      break;
    }
    case 'tongue': {
      mouth.ellipsoid(0, my, mz, 0.03, 0.012, 0.01, 7);
      M(TONGUE).ellipsoid(0.004, my - 0.016, mz - 0.01, 0.014, 0.018, 0.01, 6);
      break;
    }
    case 'flat': {
      mouth.ellipsoid(0, my - 0.004, mz, 0.022, 0.0038, 0.006, 6);
      break;
    }
    case 'smirk': {
      for (let i = 0; i < 6; i++) {
        const t = i / 5 - 0.5;
        mouth.ellipsoid(t * 0.06, my - 0.002 + (t > 0 ? t * 0.03 : t * 0.005), mz, 0.0054, 0.0048, 0.006, 5);
      }
      break;
    }
    case 'duck': {
      // Pursed lips for the selfie.
      M([0.82, 0.3, 0.38]).ellipsoid(0, my, mz - 0.012, 0.022, 0.014, 0.016, 7);
      break;
    }
    case 'chew': {
      mouth.ellipsoid(0, my, mz, 0.022, 0.016, 0.01, 7);
      M(shade(skin, 0.97)).ellipsoid(0.04, -0.03, -0.075, 0.032, 0.03, 0.026, 6);
      break;
    }
    case 'scared': {
      mouth.ellipsoid(0, my - 0.002, mz, 0.03, 0.017, 0.011, 7);
      teeth.ellipsoid(0, my + 0.006, mz - 0.007, 0.026, 0.0065, 0.006, 6);
      teeth.ellipsoid(0, my - 0.011, mz - 0.007, 0.022, 0.005, 0.006, 6);
      break;
    }
    default: {
      // A smile: a row of beads along an upturned curve.
      for (let i = 0; i < 7; i++) {
        const t = i / 6 - 0.5;
        mouth.ellipsoid(t * 0.07, my - 0.01 + t * t * 0.14, mz, 0.0058, 0.0055, 0.007, 5);
      }
    }
  }
  if (f.sweat) {
    const d = M([0.7, 0.88, 1]);
    d.ellipsoid(0.07, 0.07, -0.07, 0.011, 0.02, 0.011, 6);
    d.ellipsoid(-0.075, 0.03, -0.06, 0.008, 0.015, 0.008, 6);
  }
  if (f.freckles) {
    const fr = M(shade(skin, 0.7));
    for (let i = 0; i < 8; i++) fr.ellipsoid((i % 2 ? 1 : -1) * (0.03 + (i % 3) * 0.012), -0.012 + (i % 4) * 0.005, -0.094, 0.0045, 0.0045, 0.003, 4);
  }
}

function hair(S, M, s, rgb, skin) {
  const style = s.hair?.style ?? 'short';
  const h = M(rgb);
  const cap = (dy = 0.04, dz = 0.03, k = 1) => h.ellipsoid(0, dy, dz, 0.103 * k, 0.093 * k, 0.1 * k, 10);
  switch (style) {
    case 'bald':
      for (const side of [-1, 1]) h.ellipsoid(side * 0.088, 0.0, 0.04, 0.016, 0.045, 0.05, 6);
      h.ellipsoid(0, -0.03, 0.09, 0.07, 0.03, 0.03, 6);
      break;
    case 'short':
      cap();
      h.ellipsoid(0, 0.076, -0.07, 0.085, 0.024, 0.03, 7);
      break;
    case 'quiff':
      cap();
      h.ellipsoid(0, 0.1, -0.06, 0.07, 0.04, 0.06, 8);
      break;
    case 'long':
      cap(0.04, 0.03, 1.02);
      h.ellipsoid(0, -0.1, 0.07, 0.105, 0.19, 0.07, 9);
      for (const side of [-1, 1]) h.ellipsoid(side * 0.09, -0.04, 0.0, 0.02, 0.085, 0.045, 6);
      h.ellipsoid(0, 0.078, -0.065, 0.09, 0.028, 0.035, 7);
      break;
    case 'bob':
      cap(0.04, 0.03, 1.02);
      h.ellipsoid(0, -0.03, 0.05, 0.115, 0.1, 0.09, 9);
      h.ellipsoid(0, 0.078, -0.068, 0.09, 0.028, 0.034, 7);
      break;
    case 'afro':
      h.ellipsoid(0, 0.07, 0.04, 0.175, 0.165, 0.155, 12);
      break;
    case 'bun':
      cap();
      h.ellipsoid(0, 0.15, 0.04, 0.05, 0.045, 0.05, 8);
      h.ellipsoid(0, 0.076, -0.07, 0.085, 0.024, 0.03, 7);
      break;
    case 'ponytail': {
      cap();
      h.ellipsoid(0, 0.076, -0.07, 0.085, 0.024, 0.03, 7);
      h.limb([0, 0.05, 0.13], [0, -0.06, 0.2], 0.03);
      h.limb([0, -0.06, 0.2], [0, -0.17, 0.19], 0.022);
      M([0.9, 0.2, 0.3]).torus(0, 0.05, 0.13, 0.02, 0.006, 8, 4);
      break;
    }
    case 'pigtails':
      cap();
      h.ellipsoid(0, 0.076, -0.07, 0.085, 0.024, 0.03, 7);
      for (const side of [-1, 1]) {
        h.ellipsoid(side * 0.14, -0.02, 0.05, 0.04, 0.06, 0.04, 7);
        M([0.2, 0.7, 0.95]).ellipsoid(side * 0.115, 0.03, 0.05, 0.014, 0.014, 0.014, 5);
      }
      break;
    case 'mohawk':
      for (let i = 0; i < 8; i++) {
        const t = i / 7;
        h.ellipsoid(0, 0.08 + Math.sin(t * Math.PI) * 0.1, -0.07 + t * 0.18, 0.016, 0.06 - t * 0.02, 0.03, 6);
      }
      for (const side of [-1, 1]) h.ellipsoid(side * 0.09, 0.0, 0.04, 0.012, 0.03, 0.04, 5);
      break;
    case 'curly':
      cap(0.04, 0.03, 1.02);
      for (let i = 0; i < 18; i++) {
        const a = i * 2.4;
        const r = 0.07 + (i % 3) * 0.02;
        h.ellipsoid(Math.cos(a) * r, 0.07 + (i % 4) * 0.025, 0.03 + Math.sin(a) * r * 0.9, 0.042, 0.042, 0.042, 6);
      }
      break;
    case 'comb':
      // Hair combed over a bald top.
      cap(0.0, 0.07, 0.98);
      h.ellipsoid(0, 0.095, -0.015, 0.1, 0.014, 0.09, 7);
      for (const side of [-1, 1]) h.ellipsoid(side * 0.085, 0.0, 0.03, 0.02, 0.04, 0.05, 6);
      break;
    case 'granny':
      cap(0.045, 0.03, 1.03);
      h.ellipsoid(0, 0.12, 0.05, 0.06, 0.05, 0.06, 8);
      h.ellipsoid(0, 0.076, -0.07, 0.09, 0.026, 0.03, 7);
      for (const side of [-1, 1]) h.ellipsoid(side * 0.1, -0.015, 0.02, 0.02, 0.04, 0.04, 6);
      break;
    default:
      cap();
  }
  // Facial hair.
  if (s.mustache) {
    const stache = M(s.mustache.color ?? rgb);
    const big = s.mustache.size ?? 1;
    for (const side of [-1, 1]) {
      S.within(() => {
        S.xf.translate(side * 0.019 * big, -0.037, -0.1);
        S.xf.rotateZ(-side * (s.mustache.curl ? 0.45 : 0.15));
        stache.ellipsoid(0, 0, 0, 0.026 * big, 0.0095 * big, 0.011, 6);
      });
    }
    if (s.mustache.curl) for (const side of [-1, 1]) stache.ellipsoid(side * 0.062 * big, -0.027, -0.093, 0.008, 0.011, 0.008, 5);
  }
  if (s.beard) {
    const b = M(s.beard.color ?? rgb);
    b.ellipsoid(0, -0.065, -0.034, 0.079, 0.062, 0.078, 9);
    b.ellipsoid(0, -0.1, -0.05, 0.05, 0.05, 0.05, 7);
    for (const side of [-1, 1]) b.ellipsoid(side * 0.082, -0.02, 0.0, 0.016, 0.05, 0.05, 6);
    if (s.beard.long) b.ellipsoid(0, -0.17, -0.05, 0.04, 0.09, 0.04, 7);
  }
  if (s.sideburns) for (const side of [-1, 1]) h.ellipsoid(side * 0.097, 0.0, -0.02, 0.01, 0.04, 0.02, 5);
}

/** Hats, glasses, headphones and the other things worn on a head. */
function gear(S, M, s, hairRgb, skin, detail) {
  const g = s.gear ?? [];
  for (const item of g) {
    const c = item.color;
    switch (item.kind) {
      case 'cowboy': {
        const hat = M(c ?? [0.55, 0.38, 0.2]);
        S.within(() => {
          S.xf.translate(0, 0.075, 0);
          hat.ellipsoid(0, 0, 0, 0.215, 0.014, 0.18, 12);
          hat.ellipsoid(0.0, 0.05, 0.0, 0.085, 0.07, 0.085, 10);
          // The brim curls up at the sides.
          for (const side of [-1, 1]) hat.ellipsoid(side * 0.2, 0.014, 0, 0.03, 0.02, 0.12, 7);
          M(shade(c ?? [0.55, 0.38, 0.2], 0.55)).torus(0, 0.03, 0, 0.088, 0.012, 12, 4);
          M(GOLD).ellipsoid(0, 0.03, -0.098, 0.014, 0.01, 0.006, 5);
        });
        break;
      }
      case 'beanie': {
        const hat = M(c ?? [0.85, 0.2, 0.2]);
        hat.ellipsoid(0, 0.045, 0.012, 0.109, 0.1, 0.11, 10);
        M(shade(c ?? [0.85, 0.2, 0.2], 0.82)).torus(0, 0.065, 0.01, 0.1, 0.017, 14, 5);
        M(WHITE).ellipsoid(0, 0.158, 0.012, 0.035, 0.035, 0.035, 7);
        break;
      }
      case 'cap': {
        const hat = M(c ?? [0.2, 0.4, 0.8]);
        hat.ellipsoid(0, 0.055, 0.015, 0.108, 0.082, 0.11, 10);
        S.within(() => {
          S.xf.translate(0, 0.055, -0.115);
          S.xf.rotateX(0.2);
          hat.ellipsoid(0, 0, 0, 0.075, 0.008, 0.07, 8);
        });
        hat.ellipsoid(0, 0.135, 0.015, 0.012, 0.01, 0.012, 5);
        break;
      }
      case 'pilot': {
        // A child's pilot's cap.
        const navy = M([0.1, 0.14, 0.3]);
        navy.ellipsoid(0, 0.065, 0.0, 0.112, 0.07, 0.115, 10);
        navy.ellipsoid(0, 0.1, 0.0, 0.12, 0.028, 0.125, 10);
        S.within(() => {
          S.xf.translate(0, 0.07, -0.12);
          S.xf.rotateX(0.15);
          M(DARK).ellipsoid(0, 0, 0, 0.07, 0.007, 0.05, 8);
        });
        M(WHITE).torus(0, 0.062, 0, 0.108, 0.01, 14, 4);
        M(GOLD).ellipsoid(0, 0.1, -0.118, 0.026, 0.022, 0.008, 6);
        for (const side of [-1, 1]) M(GOLD).ellipsoid(side * 0.04, 0.1, -0.118, 0.012, 0.007, 0.006, 5);
        break;
      }
      case 'party': {
        const hat = M(c ?? [0.95, 0.3, 0.6]);
        S.within(() => {
          S.xf.translate(0.03, 0.1, 0);
          S.xf.rotateZ(-0.2);
          hat.tube(0, 0, 0, 0.06, 0.004, 0.2, 10);
          M([1, 0.85, 0.2]).ellipsoid(0, 0.205, 0, 0.018, 0.018, 0.018, 5);
          M([0.3, 0.8, 0.9]).torus(0, 0.06, 0, 0.044, 0.007, 12, 4);
          M([1, 0.85, 0.2]).torus(0, 0.12, 0, 0.03, 0.007, 12, 4);
        });
        break;
      }
      case 'sunhat': {
        const hat = M(c ?? [0.92, 0.82, 0.55]);
        S.within(() => {
          S.xf.translate(0, 0.07, 0);
          hat.ellipsoid(0, 0, 0, 0.27, 0.012, 0.27, 14);
          hat.ellipsoid(0, 0.04, 0, 0.1, 0.055, 0.1, 10);
          M([0.9, 0.2, 0.3]).torus(0, 0.025, 0, 0.1, 0.01, 14, 4);
        });
        break;
      }
      case 'glasses': {
        const fr = M(c ?? DARK);
        for (const side of [-1, 1]) {
          S.within(() => {
            S.xf.translate(side * 0.04, 0.02, -0.098);
            S.xf.rotateX(Math.PI / 2);
            fr.torus(0, 0, 0, 0.027, 0.0036, 12, 4);
          });
          fr.limb([side * 0.066, 0.02, -0.09], [side * 0.098, 0.018, 0.0], 0.0028, 0.0028, 4);
        }
        fr.limb([-0.015, 0.025, -0.1], [0.015, 0.025, -0.1], 0.0028, 0.0028, 4);
        break;
      }
      case 'sunglasses': {
        const lens = M(c ?? [0.04, 0.04, 0.06]);
        const fr = M(DARK);
        for (const side of [-1, 1]) {
          lens.ellipsoid(side * 0.04, 0.018, -0.1, 0.034, 0.026, 0.008, 8);
          fr.limb([side * 0.074, 0.02, -0.09], [side * 0.099, 0.018, 0.0], 0.003, 0.003, 4);
        }
        fr.limb([-0.01, 0.028, -0.103], [0.01, 0.028, -0.103], 0.003, 0.003, 4);
        fr.ellipsoid(0, 0.04, -0.101, 0.082, 0.006, 0.01, 6);
        break;
      }
      case 'bigglasses': {
        // Comically large round lenses.
        const fr = M(c ?? [0.9, 0.3, 0.2]);
        for (const side of [-1, 1]) {
          S.within(() => {
            S.xf.translate(side * 0.045, 0.012, -0.1);
            S.xf.rotateX(Math.PI / 2);
            fr.torus(0, 0, 0, 0.042, 0.006, 14, 4);
          });
          fr.limb([side * 0.088, 0.015, -0.085], [side * 0.099, 0.016, 0.0], 0.004, 0.004, 4);
        }
        fr.limb([-0.004, 0.02, -0.103], [0.004, 0.02, -0.103], 0.004, 0.004, 4);
        break;
      }
      case 'headphones': {
        const hp = M(c ?? [0.9, 0.2, 0.3]);
        S.within(() => {
          S.xf.translate(0, 0.01, 0.012);
          S.xf.rotateX(-Math.PI / 2);
          hp.torus(0, 0, 0, 0.115, 0.009, 18, 5, 0.5);
        });
        for (const side of [-1, 1]) {
          hp.ellipsoid(side * 0.11, -0.005, 0.01, 0.03, 0.05, 0.05, 8);
          M(DARK).ellipsoid(side * 0.14, -0.005, 0.01, 0.01, 0.04, 0.04, 6);
        }
        break;
      }
      case 'eyemask': {
        // Pushed up onto the forehead.
        const mask = M(c ?? [0.2, 0.2, 0.45]);
        mask.ellipsoid(0, 0.082, -0.074, 0.095, 0.034, 0.03, 8);
        mask.torus(0, 0.065, 0.012, 0.106, 0.006, 14, 4);
        break;
      }
      case 'maskon': {
        // Over the eyes: this one is asleep for real.
        const mask = M(c ?? [0.2, 0.2, 0.45]);
        mask.ellipsoid(0, 0.018, -0.088, 0.09, 0.04, 0.02, 8);
        mask.torus(0, 0.02, 0.0, 0.104, 0.006, 14, 4);
        break;
      }
      case 'earrings': {
        for (const side of [-1, 1]) M(GOLD).ellipsoid(side * 0.1, -0.035, 0.012, 0.009, 0.015, 0.009, 5);
        break;
      }
      case 'headband': {
        M(c ?? [0.95, 0.3, 0.3]).torus(0, 0.052, 0.012, 0.104, 0.011, 14, 4);
        break;
      }
      case 'crown': {
        const gold = M(GOLD);
        gold.torus(0, 0.115, 0, 0.065, 0.011, 12, 4);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          gold.ellipsoid(Math.cos(a) * 0.065, 0.14, Math.sin(a) * 0.065, 0.011, 0.022, 0.011, 5);
        }
        break;
      }
      case 'duck': {
        // A rubber duck, on the head.
        const y = M([1, 0.85, 0.15]);
        y.ellipsoid(0, 0.16, 0.0, 0.055, 0.04, 0.06, 8);
        y.ellipsoid(0, 0.2, -0.03, 0.035, 0.035, 0.035, 8);
        M([1, 0.5, 0.1]).ellipsoid(0, 0.195, -0.07, 0.02, 0.008, 0.02, 6);
        for (const side of [-1, 1]) M(DARK).ellipsoid(side * 0.014, 0.21, -0.058, 0.005, 0.006, 0.004, 4);
        break;
      }
      default:
    }
  }
}

// --- things in the hands -------------------------------------------------------------

function prop(S, M, s) {
  const p = s.prop;
  switch (p.kind) {
    case 'phone': {
      const hand = (POSES[s.pose] ?? POSES.phone)(1, s).hand;
      S.within(() => {
        S.xf.translate(hand[0], hand[1] + 0.03, hand[2] - 0.03);
        S.xf.rotateX(-0.35);
        M([0.08, 0.08, 0.1]).pillow(0, 0, 0, 0.075, 0.15, 0.012, 0.3, 6);
        M([0.3, 0.55, 0.95], { emissive: [0.25, 0.45, 0.8] }).pillow(0, 0, -0.008, 0.066, 0.135, 0.004, 0.3, 6);
      });
      break;
    }
    case 'selfie': {
      const hand = POSES.selfie(1, s).hand;
      S.within(() => {
        S.xf.translate(hand[0], hand[1] + 0.03, hand[2] - 0.03);
        S.xf.rotateX(0.2);
        S.xf.rotateY(0.25);
        M([0.08, 0.08, 0.1]).pillow(0, 0, 0, 0.075, 0.15, 0.012, 0.3, 6);
        M([0.4, 0.8, 0.95], { emissive: [0.3, 0.6, 0.8] }).pillow(0, 0, 0.008, 0.066, 0.135, 0.004, 0.3, 6);
      });
      break;
    }
    case 'book': {
      S.within(() => {
        S.xf.translate(0, 0.42, -0.3);
        S.xf.rotateX(-0.5);
        if (p.upsideDown) S.xf.rotateZ(Math.PI);
        M(p.color ?? [0.7, 0.15, 0.2]).pillow(0, 0, 0, 0.3, 0.2, 0.025, 0.25, 6);
        M(WHITE).pillow(0, 0, 0.003, 0.28, 0.185, 0.02, 0.2, 6);
        M(DARK).box(0, 0, 0.018, 0.003, 0.18, 0.003);
        for (let i = 0; i < 4; i++) {
          M(shade(DARK, 3)).box(-0.07, 0.06 - i * 0.04, 0.0135, 0.1, 0.006, 0.001);
          M(shade(DARK, 3)).box(0.07, 0.06 - i * 0.04, 0.0135, 0.1, 0.006, 0.001);
        }
      });
      break;
    }
    case 'paper': {
      S.within(() => {
        S.xf.translate(0, 0.55, -0.32);
        S.xf.rotateX(-0.25);
        for (const side of [-1, 1]) {
          M([0.93, 0.9, 0.82]).pillow(side * 0.19, 0, 0, 0.38, 0.5, 0.01, 0.25, 6);
          for (const z of [-0.0058, 0.0058]) {
            for (let i = 0; i < 7; i++) M([0.2, 0.2, 0.2]).box(side * 0.19, 0.17 - i * 0.05, z, 0.3, 0.012, 0.001);
            M([0.15, 0.15, 0.2]).box(side * 0.19, 0.215, z, 0.3, 0.05, 0.001);
            M([0.75, 0.2, 0.2]).box(side * 0.19, 0.1, z, 0.12, 0.1, 0.001);
          }
        }
      });
      break;
    }
    case 'laptop': {
      S.within(() => {
        S.xf.translate(0, 0.2, -0.33);
        M([0.6, 0.6, 0.62]).pillow(0, 0, 0, 0.3, 0.014, 0.21, 0.3, 6);
        S.xf.translate(0, 0.01, 0.1);
        S.xf.rotateX(-0.3);
        M([0.6, 0.6, 0.62]).pillow(0, 0.1, 0, 0.3, 0.2, 0.012, 0.3, 6);
        M([0.45, 0.75, 0.55], { emissive: [0.3, 0.5, 0.35] }).pillow(0, 0.1, -0.008, 0.27, 0.17, 0.004, 0.3, 6);
      });
      break;
    }
    case 'burger': {
      const hand = POSES.eat(1, s).hand;
      S.within(() => {
        S.xf.translate(hand[0] - 0.01, hand[1] + 0.01, hand[2] - 0.05);
        M([0.88, 0.62, 0.3]).ellipsoid(0, 0.02, 0, 0.065, 0.03, 0.065, 8);
        M([0.4, 0.2, 0.1]).ellipsoid(0, 0, 0, 0.07, 0.016, 0.07, 8);
        M([0.4, 0.75, 0.25]).ellipsoid(0, -0.012, 0, 0.074, 0.008, 0.074, 8);
        M([0.95, 0.75, 0.2]).ellipsoid(0, -0.02, 0, 0.068, 0.006, 0.068, 8);
        M([0.88, 0.62, 0.3]).ellipsoid(0, -0.04, 0, 0.065, 0.026, 0.065, 8);
      });
      break;
    }
    case 'coffeepot': {
      const hand = POSES.serve(1, s).hand;
      S.within(() => {
        S.xf.translate(hand[0], hand[1] + 0.02, hand[2] - 0.02);
        M([0.75, 0.75, 0.8]).tube(0, -0.08, 0, 0.055, 0.045, 0.2, 10);
        M(DARK).tube(0, 0.12, 0, 0.046, 0.046, 0.012, 10);
        M(DARK).limb([0.045, 0.1, 0], [0.085, 0.0, 0], 0.012, 0.012, 5);
        M(DARK).limb([0.085, 0.0, 0], [0.05, -0.06, 0], 0.012, 0.012, 5);
        M([0.75, 0.75, 0.8]).limb([-0.045, 0.1, 0], [-0.09, 0.14, 0], 0.01, 0.01, 4);
      });
      break;
    }
    case 'cup': {
      S.within(() => {
        S.xf.translate(p.x ?? 0.14, 0.2, p.z ?? -0.34);
        M(WHITE).tube(0, 0, 0, 0.035, 0.045, 0.1, 10);
        M([0.45, 0.25, 0.1]).tube(0, 0.1, 0, 0.044, 0.044, 0.002, 10);
        M([0.3, 0.5, 0.9]).tube(0, 0.035, 0, 0.0375, 0.0405, 0.025, 10);
      });
      break;
    }
    case 'teddy': {
      S.within(() => {
        S.xf.translate(p.x ?? 0.0, p.y ?? 0.28, p.z ?? -0.2);
        const fur = M(p.color ?? [0.72, 0.5, 0.3]);
        fur.ellipsoid(0, 0, 0, 0.065, 0.08, 0.05, 8);
        fur.ellipsoid(0, 0.12, 0, 0.055, 0.05, 0.05, 8);
        for (const side of [-1, 1]) {
          fur.ellipsoid(side * 0.045, 0.165, 0, 0.02, 0.02, 0.014, 5);
          fur.limb([side * 0.06, 0.04, 0], [side * 0.09, -0.03, -0.02], 0.02);
          fur.limb([side * 0.04, -0.07, 0], [side * 0.05, -0.12, -0.03], 0.024);
          M(DARK).ellipsoid(side * 0.02, 0.13, -0.045, 0.007, 0.007, 0.005, 4);
        }
        M(shade(p.color ?? [0.72, 0.5, 0.3], 1.2)).ellipsoid(0, 0.11, -0.05, 0.022, 0.016, 0.014, 6);
        M(DARK).ellipsoid(0, 0.117, -0.062, 0.007, 0.005, 0.005, 4);
        M([0.85, 0.2, 0.25]).ellipsoid(0, 0.065, -0.04, 0.045, 0.012, 0.016, 6);
      });
      break;
    }
    case 'cat': {
      // A cat in a carrier on the lap, head out.
      S.within(() => {
        S.xf.translate(0, 0.14, -0.22);
        M([0.25, 0.3, 0.55]).pillow(0, 0, 0, 0.34, 0.2, 0.28, 0.3, 8);
        M([0.7, 0.7, 0.75]).box(0, 0.095, 0, 0.1, 0.012, 0.2);
        const fur = M(p.color ?? [0.9, 0.55, 0.2]);
        fur.ellipsoid(0, 0.15, -0.1, 0.07, 0.065, 0.065, 9);
        for (const side of [-1, 1]) {
          fur.ellipsoid(side * 0.05, 0.21, -0.1, 0.022, 0.03, 0.012, 5);
          M(GOLD).ellipsoid(side * 0.028, 0.16, -0.158, 0.019, 0.022, 0.008, 6);
          M(DARK).ellipsoid(side * 0.028, 0.16, -0.165, 0.007, 0.016, 0.004, 5);
        }
        M([0.95, 0.5, 0.55]).ellipsoid(0, 0.135, -0.162, 0.012, 0.008, 0.008, 5);
        fur.ellipsoid(0, 0.12, -0.155, 0.028, 0.02, 0.016, 6);
      });
      break;
    }
    case 'baby': {
      S.within(() => {
        S.xf.translate(0, 0.28, -0.2);
        M([0.95, 0.85, 0.5]).ellipsoid(0, 0, 0, 0.12, 0.17, 0.09, 9);
        const skin = M(p.skin ?? SKINS[1]);
        S.xf.translate(0, 0.18, -0.01);
        skin.ellipsoid(0, 0, 0, 0.075, 0.075, 0.07, 9);
        for (const side of [-1, 1]) {
          M(WHITE).ellipsoid(side * 0.026, 0.01, -0.062, 0.017, 0.02, 0.009, 7);
          M(DARK).ellipsoid(side * 0.026, 0.01, -0.07, 0.01, 0.012, 0.005, 6);
          skin.ellipsoid(side * 0.05, -0.02, -0.052, 0.018, 0.014, 0.01, 5);
        }
        M(TONGUE).ellipsoid(0, -0.036, -0.066, 0.011, 0.008, 0.006, 5);
        M([0.55, 0.45, 0.3]).ellipsoid(0, 0.07, -0.03, 0.01, 0.02, 0.01, 5);
        M([0.4, 0.75, 0.95]).ellipsoid(0, 0.05, 0.0, 0.082, 0.04, 0.075, 8); // little hat
      });
      break;
    }
    case 'knitting': {
      S.within(() => {
        S.xf.translate(0, 0.22, -0.28);
        const yarn = M(p.color ?? [0.9, 0.3, 0.5]);
        yarn.ellipsoid(0.12, -0.02, 0.03, 0.05, 0.05, 0.05, 8);
        yarn.limb([0.12, 0, 0.0], [0.03, 0.03, -0.08], 0.011);
        yarn.ellipsoid(0, 0.05, -0.1, 0.1, 0.05, 0.05, 7);
        M([0.75, 0.75, 0.8]).limb([-0.06, 0.06, -0.14], [0.06, 0.1, 0.0], 0.005, 0.005, 4);
        M([0.75, 0.75, 0.8]).limb([0.06, 0.06, -0.14], [-0.06, 0.1, 0.0], 0.005, 0.005, 4);
      });
      break;
    }
    default:
  }
}

// --- the cast ----------------------------------------------------------------------

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

/** A random everyday passenger, for the seats nobody in particular is in. */
export function ordinary(rand) {
  const hairs = ['black', 'brown', 'chestnut', 'blond', 'grey', 'ginger'];
  const woman = rand() < 0.5;
  const s = {
    skin: pick(rand, SKINS),
    eyeColor: pick(rand, EYES),
    hair: { style: pick(rand, woman ? ['long', 'bob', 'bun', 'ponytail', 'curly', 'short'] : ['short', 'short', 'quiff', 'comb', 'bald', 'curly']), color: pick(rand, hairs) },
    shirt: { color: pick(rand, SHIRTS), kind: pick(rand, ['tee', 'tee', 'hoodie', 'stripes', 'suit', 'hawaii']) },
    pants: pick(rand, PANTS),
    shoes: pick(rand, SHOES),
    build: 0.9 + rand() * 0.4,
    face: {
      mouth: pick(rand, ['smile', 'smile', 'flat', 'smirk', 'grin', 'open']),
      brows: pick(rand, ['flat', 'flat', 'up', 'down', 'worried']),
      eyes: pick(rand, ['open', 'open', 'open', 'sleepy', 'tiny']),
      gaze: [rand() * 2 - 1, rand() * 2 - 1],
      freckles: rand() < 0.12,
    },
    nose: 0.85 + rand() * 0.6,
    pose: pick(rand, ['rest', 'rest', 'folded', 'phone', 'book', 'think']),
    head: { yaw: (rand() - 0.5) * 0.5, pitch: (rand() - 0.5) * 0.2, roll: (rand() - 0.5) * 0.12 },
    gear: [],
    lean: (rand() - 0.5) * 0.1,
  };
  if (s.shirt.kind === 'suit') s.shirt.tie = pick(rand, [[0.75, 0.1, 0.15], [0.15, 0.25, 0.6], [0.1, 0.5, 0.3]]);
  if (rand() < 0.2) s.gear.push({ kind: 'glasses', color: pick(rand, [DARK, [0.5, 0.3, 0.15], [0.7, 0.1, 0.2]]) });
  if (rand() < 0.1) s.gear.push({ kind: 'headphones', color: pick(rand, [[0.9, 0.2, 0.3], [0.2, 0.2, 0.25], [0.2, 0.5, 0.9], [0.95, 0.95, 0.95]]) });
  if (rand() < 0.07 && s.hair.style !== 'long' && s.hair.style !== 'bald') s.gear.push({ kind: 'cap', color: pick(rand, [[0.2, 0.4, 0.8], [0.8, 0.2, 0.2], [0.15, 0.15, 0.18]]) });
  if (!woman && rand() < 0.22) s.mustache = { size: 0.9 + rand() * 0.5, curl: rand() < 0.1 };
  if (!woman && rand() < 0.14) s.beard = { long: rand() < 0.12 };
  if (woman && rand() < 0.3) s.gear.push({ kind: 'earrings' });
  if (s.pose === 'book') s.prop = { kind: 'book', color: pick(rand, SHIRTS), upsideDown: rand() < 0.07 };
  if (s.pose === 'phone') s.prop = { kind: 'phone' };
  if (s.pose === 'book' || s.pose === 'phone') s.face.gaze = [0, -1];
  if (s.pose === 'think') s.face.brows = 'worried';
  if (rand() < 0.12) s.neckPillow = pick(rand, [[0.3, 0.45, 0.8], [0.6, 0.6, 0.65], [0.85, 0.35, 0.35]]);
  s.longSleeves = s.shirt.kind === 'hoodie' || s.shirt.kind === 'suit';
  return s;
}

/**
 * The funny ones. Each returns a description; `rand` picks colours so the same
 * character is not the same twice.
 */
export const CHARACTERS = {
  /** Out cold, mouth open, mask up, pillow on, head lolling. */
  sleeper(rand, toward = 1) {
    const s = ordinary(rand);
    return {
      ...s,
      shirt: { color: pick(rand, SHIRTS), kind: 'hoodie' },
      hair: { style: 'short', color: pick(rand, ['brown', 'black', 'chestnut', 'ginger']) },
      longSleeves: true,
      pose: 'folded',
      prop: null,
      face: { eyes: 'closed', mouth: 'snore', brows: 'down' },
      head: { roll: 0.42 * toward, pitch: -0.2, yaw: 0.12 * toward, dz: -0.02, dy: -0.02 },
      neckPillow: pick(rand, [[0.3, 0.5, 0.85], [0.9, 0.4, 0.5], [0.4, 0.7, 0.5]]),
      gear: [{ kind: 'eyemask', color: [0.2, 0.2, 0.45] }],
      lean: 0.1,
      mustache: rand() < 0.5 ? { size: 1.1 } : undefined,
      beard: undefined,
    };
  },
  /** Shades, flowers and the widest grin. */
  holiday(rand) {
    const s = ordinary(rand);
    return {
      ...s,
      shirt: { color: pick(rand, [[0.2, 0.7, 0.8], [0.95, 0.4, 0.4], [0.3, 0.8, 0.5]]), kind: 'hawaii' },
      longSleeves: false,
      pose: 'thumbs',
      prop: null,
      face: { eyes: 'open', mouth: 'grin', brows: 'up' },
      gear: [{ kind: 'sunglasses' }, ...(rand() < 0.5 ? [{ kind: 'sunhat', color: [0.92, 0.82, 0.55] }] : [])],
      mustache: rand() < 0.5 ? { size: 1.2, curl: true } : undefined,
      build: 1.25,
      hair: { style: 'short', color: pick(rand, ['blond', 'ginger', 'brown']) },
    };
  },
  /** Big headphones, tongue out, miles away. */
  musicLover(rand) {
    const s = ordinary(rand);
    return {
      ...s,
      pose: 'rest',
      prop: null,
      face: { eyes: 'closed', mouth: 'tongue', brows: 'up' },
      head: { roll: -0.18, pitch: -0.08, yaw: 0.2 },
      gear: [{ kind: 'headphones', color: pick(rand, [[0.9, 0.2, 0.3], [0.2, 0.7, 0.9], [0.95, 0.75, 0.15]]) }],
      hair: { style: pick(rand, ['pigtails', 'mohawk', 'long']), color: pick(rand, ['pink', 'blue', 'green', 'black']) },
    };
  },
  /** Hidden behind the whole newspaper. */
  newspaper(rand) {
    const s = ordinary(rand);
    return { ...s, pose: 'paper', prop: { kind: 'paper' }, face: { eyes: 'open', mouth: 'flat', brows: 'down' }, shirt: { color: SHIRTS[5], kind: 'suit', tie: [0.15, 0.25, 0.6] }, longSleeves: true, hair: { style: 'comb', color: 'grey' }, gear: [{ kind: 'glasses' }] };
  },
  /** Arm out, lips pursed, selfie. */
  selfie(rand) {
    const s = ordinary(rand);
    return { ...s, pose: 'selfie', prop: { kind: 'selfie' }, face: { eyes: 'open', mouth: 'duck', brows: 'up', gaze: [-0.4, 0.3] }, head: { roll: 0.2, yaw: 0.15, pitch: 0.05 }, hair: { style: pick(rand, ['long', 'ponytail', 'bun']), color: pick(rand, ['blond', 'brown', 'pink']) }, gear: [{ kind: 'earrings' }] };
  },
  /** Cheeks stuffed. */
  eater(rand) {
    const s = ordinary(rand);
    return { ...s, pose: 'eat', prop: { kind: 'burger' }, face: { eyes: 'wide', mouth: 'chew', brows: 'up', gaze: [0, -0.5] }, build: 1.3, shirt: { color: pick(rand, SHIRTS), kind: 'stripes' }, hair: { style: 'short', color: pick(rand, ['brown', 'black', 'ginger']) } };
  },
  /** Wheee: arms up, pilot's cap, a teddy on the lap. */
  kid(rand) {
    const s = ordinary(rand);
    return {
      ...s,
      pose: 'cheer',
      prop: { kind: 'teddy', x: 0, y: 0.2, z: -0.15 },
      face: { eyes: 'wide', mouth: 'grin', brows: 'up', freckles: true, gaze: [0, 0.4] },
      headSize: 1.35,
      build: 0.72,
      shirt: { color: pick(rand, [[0.95, 0.3, 0.3], [0.3, 0.7, 0.95], [0.95, 0.8, 0.2]]), kind: 'stripes' },
      gear: [{ kind: 'pilot' }],
      hair: { style: 'short', color: pick(rand, ['ginger', 'blond', 'brown']) },
      head: { roll: 0.08, pitch: 0.1 },
    };
  },
  /** The hat, the moustache, the squint. */
  cowboy(rand) {
    const s = ordinary(rand);
    return { ...s, pose: 'folded', prop: null, face: { eyes: 'sleepy', mouth: 'flat', brows: 'down' }, gear: [{ kind: 'cowboy', color: [0.55, 0.38, 0.2] }], mustache: { size: 1.6, curl: true, color: HAIRS.brown }, shirt: { color: [0.75, 0.2, 0.15], kind: 'stripes' }, hair: { style: 'short', color: 'brown' }, build: 1.2, head: { pitch: 0.04, roll: -0.05 } };
  },
  /** Hair for days. */
  afro(rand) {
    const s = ordinary(rand);
    return { ...s, skin: pick(rand, SKINS.slice(3)), hair: { style: 'afro', color: 'black' }, pose: 'phone', prop: { kind: 'phone' }, face: { eyes: 'open', mouth: 'grin', brows: 'up', gaze: [0, -1] }, gear: [{ kind: 'bigglasses', color: [0.95, 0.5, 0.15] }], shirt: { color: [0.55, 0.3, 0.7], kind: 'tee' } };
  },
  /** White knuckles, huge eyes, sweating. */
  nervous(rand) {
    const s = ordinary(rand);
    return { ...s, pose: 'clench', prop: null, face: { eyes: 'wide', mouth: 'scared', brows: 'worried', sweat: true, gaze: [0, 0] }, head: { pitch: 0.05 }, lean: -0.05, hair: { style: pick(rand, ['short', 'comb']), color: pick(rand, ['brown', 'grey']) }, skin: SKINS[0], gear: [], lean: -0.06 };
  },
  /** Praying. Hard. */
  praying(rand) {
    const s = ordinary(rand);
    return { ...s, pose: 'pray', prop: null, face: { eyes: 'closed', mouth: 'scared', brows: 'worried', sweat: true }, head: { pitch: -0.12 }, gear: [] };
  },
  /** Reading the book upside down. */
  bookworm(rand) {
    const s = ordinary(rand);
    return { ...s, pose: 'book', prop: { kind: 'book', color: [0.2, 0.45, 0.75], upsideDown: true }, face: { eyes: 'wide', mouth: 'flat', brows: 'down', gaze: [0, -1] }, gear: [{ kind: 'glasses' }], hair: { style: 'curly', color: 'grey' }, beard: { color: HAIRS.grey, long: true } };
  },
  /** Knitting a scarf that is already too long. */
  granny(rand) {
    const s = ordinary(rand);
    return { ...s, skin: SKINS[0], pose: 'tray', prop: { kind: 'knitting', color: [0.9, 0.3, 0.5] }, face: { eyes: 'sleepy', mouth: 'smile', brows: 'up', gaze: [0, -1] }, hair: { style: 'granny', color: 'white' }, gear: [{ kind: 'glasses', color: [0.7, 0.55, 0.2] }], shirt: { color: [0.55, 0.3, 0.55], kind: 'tee' }, scarf: [0.9, 0.3, 0.5], build: 1.1, nose: 1.3 };
  },
  /** A cat peering out of a carrier. */
  catOwner(rand) {
    const s = ordinary(rand);
    return { ...s, pose: 'hold', prop: { kind: 'cat', color: pick(rand, [[0.9, 0.55, 0.2], [0.35, 0.35, 0.38], [0.95, 0.95, 0.95]]) }, face: { eyes: 'open', mouth: 'smile', brows: 'up', gaze: [0, -1] } };
  },
  /** A baby, and the face of a parent who has not slept since March. */
  parent(rand) {
    const s = ordinary(rand);
    return { ...s, pose: 'hold', prop: { kind: 'baby', skin: s.skin }, face: { eyes: 'sleepy', mouth: 'flat', brows: 'worried', gaze: [0, -1] }, head: { pitch: -0.1, roll: 0.08 }, hair: { style: pick(rand, ['bun', 'short']), color: 'brown' } };
  },
  /** On the laptop, tie loosened, coffee. */
  workaholic(rand) {
    const s = ordinary(rand);
    return { ...s, pose: 'tray', prop: { kind: 'laptop' }, face: { eyes: 'open', mouth: 'flat', brows: 'down', gaze: [0, -1] }, shirt: { color: SHIRTS[4], kind: 'suit', tie: [0.75, 0.1, 0.15] }, longSleeves: true, gear: [{ kind: 'glasses' }], hair: { style: 'comb', color: 'brown' }, watch: true };
  },
  /** Party hat, party everything. */
  party(rand) {
    const s = ordinary(rand);
    return { ...s, pose: 'cheer', prop: null, face: { eyes: 'open', mouth: 'grin', brows: 'up' }, gear: [{ kind: 'party', color: pick(rand, [[0.95, 0.3, 0.6], [0.3, 0.8, 0.9]]) }], hair: { style: pick(rand, ['curly', 'long', 'pigtails']), color: pick(rand, ['blond', 'pink', 'brown']) } };
  },
  /** Deadpan, straight at you. */
  starer(rand) {
    const s = ordinary(rand);
    return { ...s, pose: 'rest', prop: null, face: { eyes: 'wide', mouth: 'flat', brows: 'flat', gaze: [0, 0] }, head: { yaw: 0, pitch: 0, roll: 0 }, gear: [] };
  },
  /** A rubber duck on the head, no explanation. */
  duckHead(rand) {
    const s = ordinary(rand);
    return { ...s, pose: 'rest', prop: null, face: { eyes: 'open', mouth: 'smile', brows: 'flat', gaze: [0.5, 0] }, gear: [{ kind: 'duck' }] };
  },
  /** The flight attendant. */
  attendant(rand) {
    const s = ordinary(rand);
    return {
      ...s,
      skin: pick(rand, SKINS.slice(0, 4)),
      shirt: { color: [0.13, 0.19, 0.38], kind: 'uniform' },
      longSleeves: true,
      pants: [0.13, 0.19, 0.38],
      shoes: [0.08, 0.08, 0.1],
      pose: 'rest',
      prop: null,
      face: { eyes: 'open', mouth: 'grin', brows: 'up', gaze: [0, 0] },
      hair: { style: 'bun', color: pick(rand, ['brown', 'black', 'blond']) },
      gear: [{ kind: 'earrings' }],
      scarf: [0.8, 0.12, 0.2],
      build: 0.95,
      head: { roll: 0.05 },
      nose: 0.9,
    };
  },
};

export const FUNNY = [
  'sleeper', 'holiday', 'musicLover', 'newspaper', 'selfie', 'eater', 'kid', 'cowboy', 'afro', 'nervous', 'praying',
  'bookworm', 'granny', 'catOwner', 'parent', 'workaholic', 'party', 'starer', 'duckHead',
];
