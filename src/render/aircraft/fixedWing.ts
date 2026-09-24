/**
 * Fixed-wing geometry: airliners, light aircraft, gliders.
 *
 * Everything is modelled nose-along **+Y**, starboard along **+X**, up along
 * **+Z**, normalised to an overall length of 1 so a single geometry can be
 * scaled to any type. That matches the body frame the camera controller
 * builds, so orientation needs no extra correction.
 *
 * ## Three surfaces, not one
 *
 * The builder emits a **hull**, a **trim** and a set of **spinners** rather
 * than a single mesh, because they need different materials and different
 * behaviour. Trim is everything that is dark and glassy — windscreen, cabin
 * windows, fan faces, exhaust nozzles — and on a light grey fuselage those
 * four things are most of what makes a photograph of an aeroplane look like an
 * aeroplane. Spinners turn.
 *
 * Trim is drawn a fraction outside the hull it sits on. Coplanar geometry with
 * a logarithmic depth buffer is a stipple of z-fighting that is invisible on a
 * static screenshot and crawls the moment the camera moves, so every window is
 * lifted by a proportion of the fuselage radius rather than by a constant —
 * the offset has to scale with the airframe or it is either invisible on an
 * A380 or a visible ridge on a Cessna.
 */

import type { BufferGeometry } from 'three';

import { propBladesFor, wingletStyleFor } from './details';
import { MeshBuilder } from './meshBuilder';
import { createSpinner, type Spinner } from './propeller';
import type { AirframeShape } from './typeTable';

/** How far proud of the hull trim sits, as a fraction of fuselage radius. */
const TRIM_LIFT = 0.02;

export type { Spinner } from './propeller';

export interface AirframeGeometry {
  hull: BufferGeometry;
  /** Glass and dark detail, or null when the detail level omits it. */
  trim: BufferGeometry | null;
  spinners: Spinner[];
}

/** Linear interpolation of a radius profile, for placing things on the skin. */
function radiusAt(
  sections: ReadonlyArray<readonly [number, number, number]>,
  y: number,
): { radius: number; z: number } {
  for (let i = 0; i < sections.length - 1; i++) {
    const [y0, r0, z0] = sections[i]!;
    const [y1, r1, z1] = sections[i + 1]!;
    const lo = Math.min(y0, y1);
    const hi = Math.max(y0, y1);
    if (y > hi || y < lo) continue;
    const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
    return { radius: r0 + (r1 - r0) * t, z: z0 + (z1 - z0) * t };
  }
  const last = sections[sections.length - 1]!;
  return { radius: last[1], z: last[2] };
}

/**
 * Build a fixed-wing aircraft, normalised to length 1 along +Y.
 *
 * `detail` drives segment counts and whether trim is built at all: the
 * aircraft the camera is riding deserves windows, distant traffic does not and
 * would pay for them a thousand times over.
 */
export function createAircraftGeometry(
  shape: AirframeShape,
  detail: 'high' | 'low' = 'high',
): AirframeGeometry {
  const b = new MeshBuilder();
  const t = new MeshBuilder();
  const spinners: Spinner[] = [];
  const high = detail === 'high';
  const segments = high ? 20 : 6;

  const r = shape.radiusRatio;
  const noseY = 0.5;
  const tailY = -0.5;
  const lift = 1 + TRIM_LIFT;

  /*
   * --- fuselage ------------------------------------------------------------
   *
   * The centreline is a curve, not a line. A real fuselage droops at the nose
   * — the flight deck sits below the cabin roof so the crew can see the runway
   * — and sweeps up at the tail to give rotation clearance. Built straight,
   * with a cone at each end, it is the "plain capsule" this replaces: correct
   * in its proportions and recognisable as nothing in particular.
   */
  const body: ReadonlyArray<readonly [number, number, number]> = [
    [noseY, 0.004, -r * 0.16],
    [noseY - 0.022, r * 0.42, -r * 0.14],
    [noseY - 0.055, r * 0.72, -r * 0.1],
    [noseY - 0.1, r * 0.92, -r * 0.04],
    [noseY - 0.17, r, 0],
    [tailY + 0.3, r, 0],
    [tailY + 0.19, r * 0.94, r * 0.06],
    [tailY + 0.1, r * 0.74, r * 0.16],
    [tailY + 0.035, r * 0.44, r * 0.26],
    [tailY, r * 0.16, r * 0.32],
  ];
  b.tubeShaped(body, segments);

  /*
   * --- flight deck glazing -------------------------------------------------
   *
   * A band of dark quads wrapped over the top of the nose cone, following the
   * skin. It is the single most valuable fifty triangles in the model: a
   * fuselage with a windscreen has a front, and one without is a tube that
   * happens to be pointed at one end.
   */
  if (high) {
    const from = noseY - 0.155;
    const to = noseY - 0.055;
    const steps = 6;
    // Measured up from the horizontal, so the band sits on the shoulder of the
    // nose rather than on its crown.
    const a0 = 0.16;
    const a1 = 1.15;
    for (const side of [1, -1] as const) {
      for (let i = 0; i < steps; i++) {
        const u0 = i / steps;
        const u1 = (i + 1) / steps;
        const angleFor = (u: number): number => a0 + (a1 - a0) * u;
        const yFor = (u: number): number => from + (to - from) * (1 - u);

        const corner = (u: number, dz: number): readonly [number, number, number] => {
          const y = yFor(u);
          const { radius, z } = radiusAt(body, y);
          const a = angleFor(u) + dz;
          return [side * Math.cos(a) * radius * lift, y, z + Math.sin(a) * radius * lift];
        };

        /*
         * Wound outward, which is the reverse of the order the corners are
         * generated in. Worth spelling out because getting it wrong is
         * completely silent: the panes are still built, still in the scene and
         * still report their vertex count, and are culled away to nothing
         * because their normals face into the fuselage. That is exactly what
         * happened, and from outside the aircraft simply had no windscreen.
         */
        const pane = [corner(u0, 0), corner(u1, 0), corner(u1, 0.42), corner(u0, 0.42)] as const;
        if (side === 1) t.quad(pane[3], pane[2], pane[1], pane[0]);
        else t.quad(pane[0], pane[1], pane[2], pane[3]);
      }
    }
  }

  /*
   * --- cabin windows -------------------------------------------------------
   *
   * A dotted line along the shoulder. Individually they are two triangles the
   * size of a pixel at any real distance; together they are the thing that
   * tells you how big the aeroplane is, which nothing else in the model does.
   */
  if (high && shape.kind !== 'glider' && shape.length >= 9) {
    const first = noseY - 0.2;
    const last = tailY + 0.24;
    const pitch = Math.max(0.016, 1.05 / shape.length);
    const halfW = pitch * 0.2;
    const halfH = r * 0.12;
    const angle = 0.22;

    for (const side of [1, -1] as const) {
      for (let y = first; y > last; y -= pitch) {
        const { radius, z } = radiusAt(body, y);
        // Both corners placed on the barrel at their own azimuth rather than
        // at a shared x. A flat pane tangent at the centre has its lower
        // corner inside the fuselage, which ate the bottom half of every
        // window on a body this round.
        const spread = halfH / (radius * lift);
        const at = (dy: number, da: number): readonly [number, number, number] => [
          side * Math.cos(angle + da) * radius * lift,
          y + dy,
          z + Math.sin(angle + da) * radius * lift,
        ];
        const pane = [
          at(halfW, -spread),
          at(-halfW, -spread),
          at(-halfW, spread),
          at(halfW, spread),
        ] as const;
        if (side === 1) t.quad(pane[3], pane[2], pane[1], pane[0]);
        else t.quad(pane[0], pane[1], pane[2], pane[3]);
      }
    }
  }

  /*
   * --- wings ---------------------------------------------------------------
   *
   * Two panels per side, not one. The kink between them — more chord and less
   * sweep inboard — is the shape of every swept wing built since the fifties,
   * and a single straight taper from root to tip is the flat plate this
   * replaces.
   */
  const span = shape.spanRatio / 2;
  const sweep = Math.tan((shape.sweepDeg * Math.PI) / 180);
  const dihedral = Math.tan((shape.dihedralDeg * Math.PI) / 180);
  const rootChord = shape.kind === 'glider' ? 0.1 : 0.26;
  const kink = 0.34;
  const kinkChord = rootChord * 0.66;
  const tipChord = rootChord * (shape.kind === 'glider' ? 0.55 : 0.28);
  const rootY = -0.02;
  const wingZ = shape.kind === 'jet' || shape.kind === 'turboprop' ? -r * 0.36 : -r * 0.1;
  const thickness = r * 0.3;

  const stationAt = (frac: number, chord: number, side: 1 | -1) => {
    // The inboard panel carries about half the sweep of the outboard one.
    const sweepHere = frac <= kink ? frac * 0.55 : kink * 0.55 + (frac - kink);
    const y = rootY - span * sweepHere * sweep;
    const z = wingZ + span * frac * dihedral;
    return {
      fore: [side * span * frac, y + chord / 2, z] as const,
      aft: [side * span * frac, y - chord / 2, z] as const,
    };
  };

  for (const side of [1, -1] as const) {
    const root = stationAt(r * 0.85 / span, rootChord, side);
    const mid = stationAt(kink, kinkChord, side);
    const tip = stationAt(1, tipChord, side);

    b.panel(root.fore, root.aft, mid.fore, mid.aft, thickness, side === -1);
    b.panel(mid.fore, mid.aft, tip.fore, tip.aft, thickness * 0.55, side === -1);

    addWinglet(b, shape, tip.fore, tip.aft, thickness * 0.4, side, span);

    if (shape.engines > 0 && shape.engineMount === 'wing') {
      const count = shape.engines / 2;
      for (let e = 0; e < count; e++) {
        const frac = count === 1 ? 0.35 : 0.27 + e * 0.3;
        const at = stationAt(frac, kinkChord, side);
        const ex = at.fore[0];
        const wingY = (at.fore[1] + at.aft[1]) / 2;
        const wz = at.fore[2];
        if (shape.kind === 'turboprop') {
          addTurbopropNacelle(b, t, shape, spinners, ex, wingY, wz, detail);
        } else {
          addTurbofanNacelle(b, t, shape, ex, wingY, wz, side, detail);
        }
      }
    }
  }

  /*
   * --- nose-mounted propeller ----------------------------------------------
   *
   * Everything driven by a propeller that has no engines mounted elsewhere has
   * the engine in the nose, which is the only place left for it.
   */
  const noseBlades = propBladesFor(shape);
  if (noseBlades > 0 && shape.engineMount !== 'wing') {
    spinners.push(
      createSpinner(
        { blades: noseBlades, radius: r * 4.4, chord: r * 0.55, spinner: r * 0.9, detail },
        [0, noseY + r * 0.1, -r * 0.16],
        [0, 1, 0],
        'propeller',
      ),
    );
  }

  /*
   * --- wing-root fairing ---------------------------------------------------
   *
   * The blister where the wing meets the belly, which carries the gear bays.
   * Without it the wing looks stuck onto the side of a tube, which is exactly
   * how it looked.
   */
  if (shape.kind === 'jet' || shape.kind === 'turboprop') {
    const mark = b.mark();
    b.tube(
      [
        [rootY + rootChord * 0.85, r * 0.2],
        [rootY + rootChord * 0.35, r * 0.72],
        [rootY - rootChord * 0.45, r * 0.78],
        [rootY - rootChord * 0.95, r * 0.28],
      ],
      high ? 10 : 5,
    );
    // Flattened and pushed under the barrel so it reads as a fairing rather
    // than as a second fuselage.
    for (let i = mark; i < b.positions.length; i += 3) {
      b.positions[i] = b.positions[i]! * 1.7;
      b.positions[i + 2] = b.positions[i + 2]! * 0.62 - r * 0.72;
    }
  }

  // --- rear-fuselage engines ------------------------------------------------
  if (shape.engines > 0 && shape.engineMount === 'tail') {
    for (const side of [1, -1] as const) {
      addTurbofanNacelle(
        b,
        t,
        shape,
        side * r * 1.75,
        tailY + 0.24,
        r * 0.42,
        side,
        detail,
        true,
      );
    }
  }

  // --- horizontal stabiliser ------------------------------------------------
  const tailSpan = span * 0.36;
  const stabZ = shape.tTail ? r * 3.25 : r * 0.12;
  const stabY = tailY + 0.13;
  const stabSweep = Math.tan(((shape.sweepDeg + 5) * Math.PI) / 180);
  for (const side of [1, -1] as const) {
    const tipY = stabY - tailSpan * stabSweep;
    b.panel(
      [side * r * 0.5, stabY + 0.055, stabZ],
      [side * r * 0.5, stabY - 0.055, stabZ],
      [side * tailSpan, tipY + 0.022, stabZ + tailSpan * 0.06],
      [side * tailSpan, tipY - 0.022, stabZ + tailSpan * 0.06],
      r * 0.2,
      side === -1,
    );
  }

  // --- vertical fin ---------------------------------------------------------
  const finHeight = r * (shape.tTail ? 3.25 : 3.5);
  b.slabYZ(
    [
      [tailY + 0.27, r * 0.6],
      [tailY + 0.035, r * 0.52],
      [tailY + 0.062, finHeight],
      [tailY + 0.13, finHeight],
    ],
    0,
    r * 0.17,
  );

  // A dorsal fillet blending the fin into the spine: another of the small
  // shapes that separates an aeroplane from a cylinder with a flag on it.
  b.slabYZ(
    [
      [tailY + 0.42, r * 0.02],
      [tailY + 0.27, r * 0.05],
      [tailY + 0.27, r * 0.62],
    ],
    0,
    r * 0.13,
  );

  return { hull: b.build(), trim: high ? t.build() : null, spinners };
}

/**
 * A turbofan nacelle: intake lip, cowl, nozzle, and a dark fan face.
 *
 * The lip is the detail that does the work. A modern high-bypass nacelle is
 * widest a few inches behind its leading edge and the intake is a shadowed
 * hole, so a plain cylinder — which is what was here — reads as a piece of
 * pipe stuck under the wing. Five stations and one dark disc turn it into an
 * engine.
 */
function addTurbofanNacelle(
  b: MeshBuilder,
  t: MeshBuilder,
  shape: AirframeShape,
  x: number,
  wingY: number,
  wingZ: number,
  side: 1 | -1,
  detail: 'high' | 'low',
  rearMounted = false,
): void {
  const r = shape.radiusRatio;
  const high = detail === 'high';
  const segments = high ? 14 : 5;
  const nacelleR = r * (rearMounted ? 0.66 : 0.8);
  const half = shape.length > 55 ? 0.062 : 0.048;

  // Forward of the leading edge and below the wing, which is what makes a pod
  // read as a pod rather than as wing thickness.
  const ey = rearMounted ? wingY : wingY + half * 1.5;
  const ez = rearMounted ? wingZ : wingZ - nacelleR * 1.25;

  const mark = b.mark();
  b.tubeShaped(
    [
      [ey + half, nacelleR * 0.86, 0],
      [ey + half * 0.94, nacelleR * 1.0, 0],
      [ey + half * 0.45, nacelleR * 1.04, 0],
      [ey - half * 0.35, nacelleR * 0.97, 0],
      [ey - half * 0.9, nacelleR * 0.8, 0],
      [ey - half * 1.05, nacelleR * 0.72, 0],
    ],
    segments,
  );
  b.translateFrom(mark, x, 0, ez);

  if (high) {
    // The fan face: a dark disc set back inside the lip. Without it the intake
    // is a bright hole and the nacelle looks like a bead.
    const faceY = ey + half * 0.5;
    const faceR = nacelleR * 0.86;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const c = ((i + 1) / segments) * Math.PI * 2;
      t.tri(
        x, faceY, ez,
        x + Math.cos(c) * faceR, faceY, ez + Math.sin(c) * faceR,
        x + Math.cos(a) * faceR, faceY, ez + Math.sin(a) * faceR,
      );
    }

    // And the exhaust plug poking out of the nozzle.
    const plug = t.mark();
    t.tube(
      [
        [ey - half * 0.95, nacelleR * 0.6],
        [ey - half * 1.45, nacelleR * 0.3],
        [ey - half * 1.6, 0],
      ],
      segments,
    );
    t.translateFrom(plug, x, 0, ez);
  }

  // --- pylon ---------------------------------------------------------------
  if (rearMounted) {
    // Joining the nacelle inboard to the rear fuselage rather than up to a wing.
    b.panel(
      [x, ey + half * 0.55, ez + nacelleR * 0.1],
      [x, ey - half * 0.8, ez + nacelleR * 0.1],
      [side * r * 0.5, ey + half * 0.45, ez],
      [side * r * 0.5, ey - half * 0.7, ez],
      r * 0.16,
      side === -1,
    );
  } else {
    b.panel(
      [x, ey - half * 0.1, ez + nacelleR * 0.5],
      [x, ey - half * 1.25, ez + nacelleR * 0.5],
      [x, ey - half * 0.1, wingZ],
      [x, ey - half * 1.25, wingZ],
      r * 0.15,
      side === -1,
    );
  }
}

/**
 * A turboprop nacelle, with the propeller that goes on the front of it.
 *
 * Long and slim where the turbofan is short and fat, and it reaches well ahead
 * of the leading edge because the propeller has to clear it. Drawing these as
 * turbofans — which is what happened, since the builder had only one kind of
 * pod — is how an ATR ended up looking like a small regional jet.
 */
function addTurbopropNacelle(
  b: MeshBuilder,
  t: MeshBuilder,
  shape: AirframeShape,
  spinners: Spinner[],
  x: number,
  wingY: number,
  wingZ: number,
  detail: 'high' | 'low',
): void {
  const r = shape.radiusRatio;
  const high = detail === 'high';
  const segments = high ? 12 : 5;
  const nacelleR = r * 0.52;
  const front = wingY + 0.13;
  const back = wingY - 0.14;
  const ez = wingZ - nacelleR * 0.35;

  const mark = b.mark();
  b.tubeShaped(
    [
      [front, nacelleR * 0.42, 0],
      [front - 0.03, nacelleR * 0.92, 0],
      [front - 0.08, nacelleR, 0],
      [wingY - 0.02, nacelleR * 0.95, 0],
      [back + 0.03, nacelleR * 0.66, 0],
      [back, nacelleR * 0.42, 0],
    ],
    segments,
  );
  b.translateFrom(mark, x, 0, ez);

  if (high) {
    // Exhaust stub on the inboard side, where the Dash 8 and the ATR carry it.
    const stub = t.mark();
    t.tube([[wingY + 0.01, nacelleR * 0.26], [wingY - 0.05, nacelleR * 0.2]], 6);
    t.translateFrom(stub, x, 0, ez + nacelleR * 0.55);
  }

  const blades = propBladesFor(shape);
  if (blades > 0) {
    spinners.push(
      createSpinner(
        { blades, radius: r * 3.6, chord: r * 0.48, spinner: r * 0.7, detail },
        [x, front + 0.008, ez],
        [0, 1, 0],
        'propeller',
      ),
    );
  }
}

/**
 * The wingtip device.
 *
 * Small, and disproportionately worth having: the tip is the part of the
 * silhouette the eye follows, and a blunt cut-off tip is the one thing no
 * airliner built in the last thirty years has. Approximated as a flat vertical
 * surface — a sharklet is canted about twenty degrees and the difference is
 * not visible from anywhere the model is seen from.
 */
function addWinglet(
  b: MeshBuilder,
  shape: AirframeShape,
  tipFore: readonly [number, number, number],
  tipAft: readonly [number, number, number],
  thickness: number,
  side: 1 | -1,
  span: number,
): void {
  const style = wingletStyleFor(shape);
  if (style === 'none') return;

  if (style === 'raked') {
    // Not an upturned surface at all: the tip simply carries on outboard with
    // far more sweep and almost no chord, which is the 787 and A350 planform.
    const chord = tipFore[1] - tipAft[1];
    const reach = span * 0.07;
    b.panel(
      tipFore,
      tipAft,
      [tipFore[0] + side * reach, tipFore[1] - reach * 1.5, tipFore[2] + reach * 0.35],
      [tipFore[0] + side * reach, tipFore[1] - reach * 1.5 - chord * 0.35, tipFore[2] + reach * 0.35],
      thickness * 0.6,
      side === -1,
    );
    return;
  }

  const x = tipFore[0];
  const fore = tipFore[1];
  const aft = tipAft[1];
  const base = tipFore[2];
  const chord = fore - aft;
  const height = style === 'fence' ? chord * 0.5 : chord * 1.35;

  b.slabYZ(
    [
      [fore, base],
      [aft, base],
      [aft + chord * 0.3, base + height],
      [fore - chord * 0.12, base + height],
    ],
    x,
    thickness,
  );

  if (style === 'fence') {
    // A fence runs below the tip as well as above it.
    b.slabYZ(
      [
        [fore, base],
        [fore - chord * 0.12, base - height * 0.7],
        [aft + chord * 0.3, base - height * 0.7],
        [aft, base],
      ],
      x,
      thickness,
    );
  }
}
