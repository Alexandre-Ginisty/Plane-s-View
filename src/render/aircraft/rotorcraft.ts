/**
 * Helicopter geometry.
 *
 * Same conventions as the fixed-wing builder: nose along +Y, up along +Z,
 * normalised to overall length 1, and the same split into hull, trim and
 * spinners.
 *
 * ## The rotors turn now
 *
 * They used to be four slabs welded into the hull, with a comment explaining
 * that a static disc would read as a frisbee. True, and the blades were the
 * right answer — but *stationary* blades on a helicopter doing 140 knots read
 * as an autorotation at best. Both rotors are emitted as spinners and driven
 * from the flight regime, which costs two extra draw calls and is the single
 * most convincing thing in the model.
 */

import { MeshBuilder } from './meshBuilder';
import { createSpinner } from './propeller';
import type { AirframeGeometry } from './fixedWing';
import type { Spinner } from './propeller';
import type { AirframeShape } from './typeTable';

/**
 * Build a helicopter, normalised to length 1 along +Y.
 *
 * Proportioned from the recognition cues rather than from a blueprint: a deep
 * cabin well forward, a thin boom that is most of the length, and a rotor disc
 * wider than the whole aircraft. Those three read correctly at any range; the
 * details below them are there so the model does not fall apart when the
 * camera is riding twenty metres away.
 */
export function createRotorcraftGeometry(
  shape: AirframeShape,
  detail: 'high' | 'low' = 'high',
): AirframeGeometry {
  const b = new MeshBuilder();
  const t = new MeshBuilder();
  const high = detail === 'high';
  const segments = high ? 16 : 6;
  const r = shape.radiusRatio;
  const spinners: Spinner[] = [];

  // --- cabin: deep and blunt, sitting forward -----------------------------
  const cabin: ReadonlyArray<readonly [number, number, number]> = [
    [0.5, 0.012, -r * 0.2],
    [0.46, r * 0.5, -r * 0.16],
    [0.38, r * 0.82, -r * 0.08],
    [0.26, r, 0],
    [0.1, r * 0.95, 0],
    [0.0, r * 0.62, r * 0.1],
    [-0.06, r * 0.4, r * 0.2],
  ];
  b.tubeShaped(cabin, segments);

  /*
   * --- the glasshouse ------------------------------------------------------
   *
   * A helicopter is mostly window at the front, including under the pilots'
   * feet, and that is the whole reason a helicopter looks like a helicopter
   * from the side. Wrapped over the nose the same way the flight deck glazing
   * is on an airliner, but reaching much further round and much further down.
   */
  if (high) {
    const lift = 1.014;
    const steps = 7;
    for (const side of [1, -1] as const) {
      for (let i = 0; i < steps; i++) {
        const u0 = i / steps;
        const u1 = (i + 1) / steps;
        const at = (u: number, a: number): readonly [number, number, number] => {
          // Walk the first four cabin stations, nose to shoulder.
          const f = u * 3;
          const k = Math.min(2, Math.floor(f));
          const [y0, r0, z0] = cabin[k]!;
          const [y1, r1, z1] = cabin[k + 1]!;
          const s = f - k;
          const y = y0 + (y1 - y0) * s;
          const rad = (r0 + (r1 - r0) * s) * lift;
          const z = z0 + (z1 - z0) * s;
          return [side * Math.cos(a) * rad, y, z + Math.sin(a) * rad];
        };
        // From well below the waterline up over the shoulder.
        const lo = -0.9 + u0 * 0.2;
        const hi = 1.0 - u0 * 0.35;
        // Wound outward. See the same note in `fixedWing`: the inward winding
        // is invisible rather than wrong-looking, which is what makes it hard
        // to catch.
        const pane = [at(u0, lo), at(u1, lo), at(u1, hi), at(u0, hi)] as const;
        if (side === 1) t.quad(pane[3], pane[2], pane[1], pane[0]);
        else t.quad(pane[0], pane[1], pane[2], pane[3]);
      }
    }
  }

  // --- tail boom: thin, and most of the length ----------------------------
  const boomZ = r * 0.35;
  b.tube(
    [
      [-0.02, r * 0.42],
      [-0.12, r * 0.24],
      [-0.34, r * 0.17],
      [-0.5, r * 0.14],
    ],
    high ? 10 : 5,
    boomZ,
  );

  // --- tail fin, swept up and carrying the tail rotor ----------------------
  const finTop = boomZ + r * 1.5;
  b.slabYZ(
    [
      [-0.34, boomZ],
      [-0.5, boomZ],
      [-0.5, finTop],
      [-0.38, finTop],
    ],
    0,
    r * 0.22,
  );

  // --- horizontal stabiliser ----------------------------------------------
  for (const side of [1, -1] as const) {
    const outline: Array<readonly [number, number]> = [
      [side * r * 0.2, -0.3],
      [side * r * 1.5, -0.32],
      [side * r * 1.5, -0.4],
      [side * r * 0.2, -0.4],
    ];
    b.slab(side === 1 ? outline : [...outline].reverse(), boomZ, r * 0.14);
  }

  // --- mast and rotor head --------------------------------------------------
  const rotorZ = r * 1.35;
  b.slabYZ(
    [
      [0.1, r * 0.9],
      [0.22, r * 0.9],
      [0.22, rotorZ],
      [0.1, rotorZ],
    ],
    0,
    r * 0.3,
  );
  const head = b.mark();
  b.tube([[rotorZ - r * 0.1, r * 0.3], [rotorZ + r * 0.22, r * 0.22]], high ? 10 : 5);
  // Built along +Y, stood upright: the hub sits on top of the mast.
  for (let i = head; i < b.positions.length; i += 3) {
    const y = b.positions[i + 1]!;
    b.positions[i + 1] = b.positions[i + 2]! + 0.16;
    b.positions[i + 2] = y;
  }

  // --- main rotor -----------------------------------------------------------
  spinners.push(
    createSpinner(
      {
        blades: shape.length >= 15 ? 5 : 4,
        radius: shape.rotorRatio / 2,
        chord: 0.05,
        spinner: 0,
        twist: 0.12,
        detail,
      },
      [0, 0.16, rotorZ + r * 0.24],
      [0, 0, 1],
      'mainRotor',
    ),
  );

  // --- tail rotor -----------------------------------------------------------
  spinners.push(
    createSpinner(
      { blades: 2, radius: shape.rotorRatio * 0.18, chord: 0.028, spinner: 0, twist: 0.15, detail },
      [r * 0.5, -0.44, finTop - r * 0.4],
      [1, 0, 0],
      'tailRotor',
    ),
  );

  // --- skids ---------------------------------------------------------------
  for (const side of [1, -1] as const) {
    b.slab(
      [
        [side * r * 0.55, 0.3],
        [side * r * 0.85, 0.26],
        [side * r * 0.85, -0.04],
        [side * r * 0.55, -0.02],
      ],
      -r * 1.15,
      r * 0.12,
    );
    // Cross-tubes, so the skids are attached to something.
    for (const y of [0.24, 0.02]) {
      b.box(
        [Math.min(0, side * r * 0.7), y - r * 0.08, -r * 1.15],
        [Math.max(0, side * r * 0.7), y + r * 0.08, -r * 0.55],
      );
    }
  }

  return { hull: b.build(), trim: high ? t.build() : null, spinners };
}

/**
 * Main-rotor RPM.
 *
 * Constant, and far more strictly so than a propeller: rotor speed is held
 * within a few percent at all times because the blades stall outside it, and
 * power changes are absorbed entirely by collective pitch. Anything that
 * visibly varies with the flight regime here would be wrong.
 */
export function rotorRpm(shape: AirframeShape): number {
  // Tip speed is the fixed quantity — about 210 m/s on every helicopter ever
  // built — so a bigger disc turns proportionally slower.
  const radiusM = Math.max(2, (shape.rotorRatio * shape.length) / 2);
  return (210 / (2 * Math.PI * radiusM)) * 60;
}
