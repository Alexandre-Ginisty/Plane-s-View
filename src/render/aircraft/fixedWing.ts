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
 * Hull, trim and spinners need different materials and different behaviour.
 * Trim is everything dark and glassy — windscreen, cabin windows, fan faces,
 * nozzles — and on a light grey fuselage those are most of what makes a
 * photograph of an aeroplane look like an aeroplane. Spinners turn.
 *
 * Trim is drawn a fraction outside the hull it sits on. Coplanar geometry with
 * a logarithmic depth buffer is a stipple of z-fighting that is invisible on a
 * static screenshot and crawls the moment the camera moves, so every window is
 * lifted by a proportion of the fuselage radius rather than by a constant —
 * the offset has to scale with the airframe or it is either invisible on an
 * A380 or a visible ridge on a Cessna.
 */

import type { BufferGeometry } from 'three';

import { propBladesFor } from './details';
import { addTurbofanNacelle, addTurbopropNacelle, addWinglet } from './nacelles';
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
         * Wound outward, the reverse of the order the corners are generated
         * in. Getting this wrong is completely silent: the panes are still
         * built, still in the scene and still report their vertex count, and
         * are culled to nothing because their normals face into the fuselage.
         * From outside, the aircraft simply had no windscreen.
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
