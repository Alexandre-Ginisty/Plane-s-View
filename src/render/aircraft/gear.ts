/**
 * Landing gear, extended.
 *
 * Its own geometry so it can be hidden in the cruise, which is not a detail:
 * an airliner at FL350 with its gear hanging out is wrong in a way that reads
 * instantly, and gear that is never drawn at all leaves every aircraft on the
 * ground floating on its belly. Both were true before this file existed.
 *
 * ## Where the wheels have to be
 *
 * Not a free choice. `@/render/ground` places the aircraft's centre at
 * `terrain + radiusRatio * length * 1.9`, so in the length-normalised model
 * space used here the ground plane is at `z = -1.9 * radiusRatio` exactly. The
 * wheels are built to touch it. Any other number and a taxiing aircraft either
 * sinks to the axles or hovers — and since the clearance constant is what
 * decides the camera height too, the two have to be read from the same place.
 */

import type { BufferGeometry } from 'three';

import { mainWheelsPerSide } from './details';
import { MeshBuilder } from './meshBuilder';
import type { AirframeShape } from './typeTable';

/** Multiple of the fuselage radius at which the ground sits. Mirrors `clearanceFor`. */
const GROUND_AT_RADII = 1.9;

/** A wheel: a short fat tube on an X axis, at a point. */
function wheel(
  b: MeshBuilder,
  x: number,
  y: number,
  z: number,
  radius: number,
  width: number,
  segments: number,
): void {
  const mark = b.mark();
  b.tubeX(
    [
      [-width / 2, radius * 0.45],
      [-width / 2, radius],
      [width / 2, radius],
      [width / 2, radius * 0.45],
    ],
    segments,
  );
  b.translateFrom(mark, x, y, z);
}

/**
 * Extended undercarriage for an airframe, in length-normalised model space.
 *
 * Returns null for anything with nothing to extend — gliders and rotorcraft
 * carry their own arrangement in their own builders.
 */
export function createGearGeometry(
  shape: AirframeShape,
  detail: 'high' | 'low' = 'high',
): BufferGeometry | null {
  if (shape.kind === 'glider' || shape.kind === 'rotorcraft') return null;

  const b = new MeshBuilder();
  const segments = detail === 'high' ? 10 : 5;
  const r = shape.radiusRatio;

  const ground = -GROUND_AT_RADII * r;
  const belly = -r * 0.92;
  const strut = r * 0.13;

  // --- nose gear -----------------------------------------------------------
  const noseY = 0.3;
  const noseWheelR = r * 0.24;
  b.box([-strut * 0.6, noseY - strut * 0.6, ground + noseWheelR], [strut * 0.6, noseY + strut * 0.6, belly]);
  for (const side of [1, -1] as const) {
    wheel(b, side * strut * 0.9, noseY, ground + noseWheelR, noseWheelR, strut * 0.8, segments);
  }

  // --- main gear -----------------------------------------------------------
  //
  // Under the wing root and slightly aft of the centre of mass, which is where
  // it is on every tricycle aircraft — an aircraft balances on its mains and
  // rests its nose, not the other way round.
  const mainY = -0.06;
  const mainWheelR = r * 0.3;
  const perSide = mainWheelsPerSide(shape);
  const trackX = r * (shape.length >= 33 ? 1.5 : 1.15);

  for (const side of [1, -1] as const) {
    const x = side * trackX;
    b.box([x - strut * 0.7, mainY - strut * 0.7, ground + mainWheelR], [x + strut * 0.7, mainY + strut * 0.7, belly]);

    // A bogie: pairs of wheels spread fore and aft along a beam. One pair per
    // side is a single axle and needs no beam.
    const pairs = Math.max(1, Math.round(perSide / 2));
    const spacing = mainWheelR * 2.3;
    if (pairs > 1) {
      const halfBeam = ((pairs - 1) * spacing) / 2 + mainWheelR * 0.8;
      b.box(
        [x - strut * 0.5, mainY - halfBeam, ground + mainWheelR - strut * 0.4],
        [x + strut * 0.5, mainY + halfBeam, ground + mainWheelR + strut * 0.4],
      );
    }

    for (let p = 0; p < pairs; p++) {
      const y = mainY + (p - (pairs - 1) / 2) * spacing;
      const inner = perSide >= 2;
      const offsets = inner ? [mainWheelR * 0.75, -mainWheelR * 0.75] : [0];
      for (const dx of offsets) {
        wheel(b, x + dx, y, ground + mainWheelR, mainWheelR, mainWheelR * 0.85, segments);
      }
    }
  }

  return b.build();
}
