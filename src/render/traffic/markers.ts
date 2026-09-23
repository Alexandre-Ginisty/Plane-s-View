/**
 * Traffic marker geometry.
 *
 * Deliberately *not* the detailed models in `@/render/aircraft`. Those are
 * built for a camera twenty metres away; these are drawn by the hundred at ten
 * kilometres, where the only thing that survives is the outline and every
 * triangle is paid for a thousand times over.
 *
 * Two shapes, because kind is carried by geometry and state by colour (see
 * `@/ui/palette`). The rotor bar crossing the helicopter's body is the whole
 * recognition cue — it is what stops a helicopter reading as a very small
 * airliner, which is what the old single-mesh build did to every rotorcraft on
 * screen.
 *
 * Both are nose-forward down +Y, wings along X, +Z up, so they can be oriented
 * directly by the body frame `@/render/pov` produces.
 */

import { BufferAttribute, BufferGeometry, Color } from 'three';

import type { SampledAircraft } from '@/state/traffic';
import { HEX } from '@/ui/palette';

/**
 * A readable aircraft silhouette in about thirty triangles.
 *
 * Built nose-forward down +Y, wings along X, with +Z up, so it can be oriented
 * directly by the same body frame the camera controller produces.
 */
export function createAircraftMarkerGeometry(): BufferGeometry {
  const positions: number[] = [];

  const tri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): void => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  };

  // Fuselage: a slim diamond from nose (+Y) to tail (-Y).
  const noseY = 0.55;
  const tailY = -0.45;
  const bodyR = 0.05;

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const b = ((i + 1) / 4) * Math.PI * 2;
    const ax = Math.cos(a) * bodyR;
    const az = Math.sin(a) * bodyR;
    const bx = Math.cos(b) * bodyR;
    const bz = Math.sin(b) * bodyR;

    tri(0, noseY, 0, ax, 0, az, bx, 0, bz);
    tri(0, tailY, 0, bx, 0, bz, ax, 0, az);
  }

  // Wings: a swept delta either side.
  const span = 0.5;
  tri(0, 0.1, 0, -span, -0.2, 0, -span * 0.35, 0.02, 0);
  tri(0, 0.1, 0, span * 0.35, 0.02, 0, span, -0.2, 0);
  tri(0, 0.1, 0, -span * 0.35, 0.02, 0, 0, -0.18, 0);
  tri(0, 0.1, 0, 0, -0.18, 0, span * 0.35, 0.02, 0);

  // Tailplane and fin.
  tri(0, tailY + 0.06, 0, -0.18, tailY - 0.05, 0, 0.18, tailY - 0.05, 0);
  tri(0, tailY + 0.06, 0, 0, tailY - 0.02, 0.16, -0.02, tailY - 0.05, 0);
  tri(0, tailY + 0.06, 0, 0.02, tailY - 0.05, 0, 0, tailY - 0.02, 0.16);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Colour by vertical state.
 *
 * `stale` is tested first and deliberately so: an extrapolated position that
 * is drawn in a confident colour is a lie, and the one thing worse than not
 * knowing where an aircraft is, is being told incorrectly. Everything else is
 * the standard climb/level/descend encoding, shared with the 2D map through
 * `@/ui/palette` so the two surfaces never drift.
 */
export function colorFor(sample: SampledAircraft, out: Color): Color {
  if (sample.stale) return out.setHex(HEX.slate);
  if (sample.latest.emergency) return out.setHex(HEX.red);
  if (sample.verticalRateFpm > 300) return out.setHex(HEX.green);
  if (sample.verticalRateFpm < -300) return out.setHex(HEX.amber);
  return out.setHex(HEX.ice);
}

/**
 * A helicopter in about twenty triangles: stubby body, thin boom, rotor bar.
 *
 * Not the detailed model from `aircraftModel.ts`. That one is built for a
 * camera twenty metres away; these are drawn by the hundred at ten kilometres,
 * where the only thing that survives is the outline. The rotor bar crossing
 * the body is the whole recognition cue — it is what stops a helicopter
 * reading as a very small airliner, which is exactly what the old single-mesh
 * build did to every rotorcraft on screen.
 */
export function createRotorcraftMarkerGeometry(): BufferGeometry {
  const positions: number[] = [];
  const tri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): void => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  };

  // Cabin: a short fat diamond well forward.
  const noseY = 0.3;
  const cabinBackY = -0.05;
  const bodyR = 0.1;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const b = ((i + 1) / 4) * Math.PI * 2;
    const ax = Math.cos(a) * bodyR;
    const az = Math.sin(a) * bodyR;
    const bx = Math.cos(b) * bodyR;
    const bz = Math.sin(b) * bodyR;
    tri(0, noseY, 0, ax, 0.08, az, bx, 0.08, bz);
    tri(0, cabinBackY, 0, bx, 0.08, bz, ax, 0.08, az);
  }

  // Tail boom, drawn as a flat wedge: at this range a tube would cost eight
  // times the triangles to produce the same two pixels.
  tri(-0.018, cabinBackY, 0.02, 0.018, cabinBackY, 0.02, 0, -0.5, 0.03);
  tri(0, cabinBackY, -0.02, 0, -0.5, 0.03, 0, cabinBackY, 0.05);

  // Tail fin.
  tri(0, -0.36, 0.03, 0, -0.5, 0.03, 0, -0.46, 0.14);

  // Rotor: two crossed bars above the cabin, spanning the full disc.
  const discR = 0.56;
  const bar = 0.022;
  const rotorZ = 0.15;
  for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
    const px = -dy * bar;
    const py = dx * bar;
    tri(
      dx * discR + px, dy * discR + py + 0.1, rotorZ,
      -dx * discR + px, -dy * discR + py + 0.1, rotorZ,
      -dx * discR - px, -dy * discR - py + 0.1, rotorZ,
    );
    tri(
      dx * discR + px, dy * discR + py + 0.1, rotorZ,
      -dx * discR - px, -dy * discR - py + 0.1, rotorZ,
      dx * discR - px, dy * discR - py + 0.1, rotorZ,
    );
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}
