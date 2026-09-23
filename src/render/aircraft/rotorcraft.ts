/**
 * Helicopter geometry.
 *
 * Same conventions as the fixed-wing builder: nose along +Y, up along +Z,
 * normalised to overall length 1.
 */

import type { BufferGeometry } from 'three';

import { MeshBuilder } from './meshBuilder';
import type { AirframeShape } from './shapes';

/**
 * Build a helicopter, normalised to length 1 along +Y.
 *
 * Proportioned from the recognition cues rather than from a blueprint: a deep
 * cabin well forward, a thin boom that is most of the length, and a rotor disc
 * wider than the whole aircraft. Those three read correctly at any range; the
 * details below them are there so the model does not fall apart when the
 * camera is riding twenty metres away.
 *
 * The blades are modelled as four discrete slabs, not as a translucent disc.
 * A disc would be the honest depiction of a *turning* rotor, but nothing here
 * animates, and a static grey disc reads as a frisbee. Blades read as a rotor
 * even stopped.
 */
export function createRotorcraftGeometry(
  shape: AirframeShape,
  detail: 'high' | 'low' = 'high',
): BufferGeometry {
  const b = new MeshBuilder();
  const segments = detail === 'high' ? 14 : 6;
  const r = shape.radiusRatio;

  // --- cabin: deep and blunt, sitting forward -----------------------------
  b.tube(
    [
      [0.5, 0.012],
      [0.46, r * 0.55],
      [0.38, r * 0.85],
      [0.26, r],
      [0.1, r * 0.95],
      [0.0, r * 0.62],
      [-0.06, r * 0.4],
    ],
    segments,
  );

  // --- tail boom: thin, and most of the length ----------------------------
  const boomZ = r * 0.35;
  b.tube(
    [
      [-0.02, r * 0.42],
      [-0.12, r * 0.24],
      [-0.34, r * 0.17],
      [-0.5, r * 0.14],
    ],
    detail === 'high' ? 10 : 5,
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

  // --- mast ----------------------------------------------------------------
  const rotorZ = r * 1.35;
  b.tube([[0.16, r * 0.16], [0.16, r * 0.1]], 6, 0);
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

  // --- main rotor: four blades, radiating from the mast --------------------
  const bladeLength = shape.rotorRatio / 2;
  const chord = 0.055;
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 8;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // A blade is a long thin rectangle from the hub outwards; rotating the
    // outline is what gives each one its azimuth.
    const rotate = (along: number, across: number): readonly [number, number] =>
      [along * cos - across * sin, along * sin + across * cos + 0.16] as const;

    b.slab(
      [
        rotate(r * 0.4, chord / 2),
        rotate(bladeLength, chord * 0.35),
        rotate(bladeLength, -chord * 0.35),
        rotate(r * 0.4, -chord / 2),
      ],
      rotorZ,
      r * 0.09,
    );
  }

  // --- tail rotor: two blades, standing in the fin -------------------------
  const tailRotorR = shape.rotorRatio * 0.18;
  for (const sign of [1, -1] as const) {
    b.slabYZ(
      [
        [-0.44 + 0.012, finTop - r * 0.4],
        [-0.44 + 0.012, finTop - r * 0.4 + sign * tailRotorR],
        [-0.44 - 0.012, finTop - r * 0.4 + sign * tailRotorR],
        [-0.44 - 0.012, finTop - r * 0.4],
      ],
      r * 0.5,
      r * 0.06,
    );
  }

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
  }

  return b.build();
}
