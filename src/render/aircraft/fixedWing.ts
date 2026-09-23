/**
 * Fixed-wing geometry: airliners, light aircraft, gliders.
 *
 * Everything is modelled nose-along **+Y**, starboard along **+X**, up along
 * **+Z**, normalised to an overall length of 1 so a single geometry can be
 * scaled to any type. That matches the body frame the camera controller
 * builds, so orientation needs no extra correction.
 */

import { BufferAttribute, BufferGeometry } from 'three';

import { MeshBuilder } from './meshBuilder';
import type { AirframeShape } from './shapes';

/**
 * Build an airliner, normalised to length 1 along +Y.
 *
 * `detail` drives the number of radial segments: the aircraft the camera is
 * riding deserves a smooth fuselage, distant traffic does not.
 */
export function createAircraftGeometry(shape: AirframeShape, detail: 'high' | 'low' = 'high'): BufferGeometry {
  const b = new MeshBuilder();
  const segments = detail === 'high' ? 16 : 6;

  const r = shape.radiusRatio;
  const noseY = 0.5;
  const tailY = -0.5;

  // --- fuselage: pointed nose, constant barrel, tapered upswept tail -------
  b.tube(
    [
      [noseY, 0],
      [noseY - 0.04, r * 0.55],
      [noseY - 0.1, r * 0.88],
      [noseY - 0.18, r],
      [tailY + 0.28, r],
      [tailY + 0.12, r * 0.72],
      [tailY + 0.02, r * 0.3],
      [tailY, r * 0.1],
    ],
    segments,
  );

  // --- wings ---------------------------------------------------------------
  const span = shape.spanRatio / 2;
  const sweep = Math.tan((shape.sweepDeg * Math.PI) / 180);
  const dihedral = Math.tan((shape.dihedralDeg * Math.PI) / 180);
  const rootChord = 0.24;
  const tipChord = 0.075;
  const rootY = -0.02;

  for (const side of [1, -1] as const) {
    const tipX = side * span;
    const tipY = rootY - span * sweep;
    const tipZ = -r * 0.3 + span * dihedral;
    const rootZ = -r * 0.3;
    const rootX = side * r * 0.85;

    b.panel(
      [rootX, rootY + rootChord / 2, rootZ],
      [rootX, rootY - rootChord / 2, rootZ],
      [tipX, tipY + tipChord / 2, tipZ],
      [tipX, tipY - tipChord / 2, tipZ],
      r * 0.34,
      side === -1,
    );

    // --- engines ------------------------------------------------------------
    if (shape.engines > 0 && shape.engineMount === 'wing') {
      const count = shape.engines / 2;
      for (let e = 0; e < count; e++) {
        // Inboard pylon first, outboard second on a four-engine aircraft.
        const frac = count === 1 ? 0.34 : 0.28 + e * 0.3;
        const ex = side * span * frac;
        // Engines hang forward of the leading edge and below the wing, which
        // is what makes them read as engines rather than as wing thickness.
        const ey = rootY - span * frac * sweep + rootChord * 0.42;
        const ez = -r * 0.3 + span * frac * dihedral - r * 0.95;
        const nacelleR = r * 0.78;
        const half = shape.length > 55 ? 0.055 : 0.042;

        const saved = b.positions.length;
        b.tube(
          [
            [ey + half, nacelleR * 0.8],
            [ey + half * 0.6, nacelleR],
            [ey - half * 0.7, nacelleR],
            [ey - half, nacelleR * 0.72],
          ],
          detail === 'high' ? 12 : 5,
        );
        for (let i = saved; i < b.positions.length; i += 3) {
          b.positions[i] = b.positions[i]! + ex;
          b.positions[i + 2] = b.positions[i + 2]! + ez;
        }

        // Pylon joining nacelle to wing.
        b.panel(
          [ex, ey - half * 0.2, ez],
          [ex, ey - half * 1.1, ez],
          [ex, ey - half * 0.2, -r * 0.3 + span * frac * dihedral],
          [ex, ey - half * 1.1, -r * 0.3 + span * frac * dihedral],
          r * 0.16,
          side === -1,
        );
      }
    }
  }

  // --- rear-fuselage engines ------------------------------------------------
  //
  // Regional jets and almost every business jet. This used to be keyed off
  // `tTail`, which meant two different families both came out wrong: nothing
  // was ever drawn here, so a CRJ had no engines at all, and an ATR — a T-tail
  // aircraft with underwing turboprops — was excluded from the wing pods above
  // and so had none either. `engineMount` says where they go; `tTail` now says
  // only where the stabiliser goes.
  if (shape.engines > 0 && shape.engineMount === 'tail') {
    const half = 0.06;
    const nacelleR = r * 0.72;
    const ey = tailY + 0.25;
    const ez = r * 0.4;

    for (const side of [1, -1] as const) {
      const ex = side * r * 1.6;
      const saved = b.positions.length;
      b.tube(
        [
          [ey + half, nacelleR * 0.78],
          [ey + half * 0.6, nacelleR],
          [ey - half * 0.8, nacelleR],
          [ey - half, nacelleR * 0.7],
        ],
        detail === 'high' ? 12 : 5,
      );
      for (let i = saved; i < b.positions.length; i += 3) {
        b.positions[i] = b.positions[i]! + ex;
        b.positions[i + 2] = b.positions[i + 2]! + ez;
      }
    }
  }

  // --- horizontal stabiliser ----------------------------------------------
  const tailSpan = span * 0.36;
  const stabZ = shape.tTail ? r * 3.1 : -r * 0.1;
  const stabY = tailY + 0.12;
  for (const side of [1, -1] as const) {
    const outline: Array<readonly [number, number]> = [
      [side * r * 0.6, stabY + 0.05],
      [side * tailSpan, stabY - 0.055],
      [side * tailSpan, stabY - 0.085],
      [side * r * 0.6, stabY - 0.03],
    ];
    b.slab(side === 1 ? outline : [...outline].reverse(), stabZ, r * 0.22);
  }

  // The vertical fin stands in the Y-Z plane, which the X-Y slab helper cannot
  // express; `addVerticalFin` builds it separately.
  return b.build();
}

/**
 * The fin needs to stand in the Z axis, which the generic slab helper cannot
 * express. Building it separately keeps the helper simple.
 */
export function addVerticalFin(geometry: BufferGeometry, shape: AirframeShape): BufferGeometry {
  const b = new MeshBuilder();
  const r = shape.radiusRatio;
  const tailY = -0.5;
  const height = r * 3.4;
  const thickness = r * 0.18;

  const profile: ReadonlyArray<readonly [number, number]> = [
    [tailY + 0.24, 0],
    [tailY + 0.02, 0],
    [tailY + 0.04, height],
    [tailY + 0.17, height],
  ];

  for (const side of [1, -1] as const) {
    const x = (side * thickness) / 2;
    for (let i = 1; i < profile.length - 1; i++) {
      const p0 = profile[0]!;
      const pi = profile[i]!;
      const pj = profile[i + 1]!;
      if (side === 1) b.tri(x, p0[0], p0[1], x, pi[0], pi[1], x, pj[0], pj[1]);
      else b.tri(x, p0[0], p0[1], x, pj[0], pj[1], x, pi[0], pi[1]);
    }
  }
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i]!;
    const c = profile[(i + 1) % profile.length]!;
    b.quad(
      [thickness / 2, a[0], a[1]],
      [-thickness / 2, a[0], a[1]],
      [-thickness / 2, c[0], c[1]],
      [thickness / 2, c[0], c[1]],
    );
  }

  const fin = b.build();
  return mergeGeometries(geometry, fin);
}

/** Concatenate two position-only geometries. */
function mergeGeometries(a: BufferGeometry, bGeom: BufferGeometry): BufferGeometry {
  const pa = a.getAttribute('position') as BufferAttribute;
  const pb = bGeom.getAttribute('position') as BufferAttribute;

  const merged = new Float32Array(pa.array.length + pb.array.length);
  merged.set(pa.array as Float32Array, 0);
  merged.set(pb.array as Float32Array, pa.array.length);

  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(merged, 3));
  out.computeVertexNormals();
  out.computeBoundingSphere();

  a.dispose();
  bGeom.dispose();
  return out;
}
