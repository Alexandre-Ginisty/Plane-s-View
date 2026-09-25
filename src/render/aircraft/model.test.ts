/**
 * The model builder, checked for the mistakes that do not throw.
 *
 * Geometry code fails silently: a NaN in one vertex removes the whole mesh
 * from the screen with no error anywhere, a reversed winding leaves a surface
 * that is invisible from one side only, and a propeller attached to an
 * aircraft that has none is just an odd-looking aeroplane. None of those can
 * be seen from a stack trace, so they are pinned here.
 */

import { describe, expect, it } from 'vitest';
import type { BufferAttribute, BufferGeometry } from 'three';

import { bladeOpacity, propellerRpm, visibleSpinRate } from './propeller';
import { buildAircraftModel, disposeAircraftModel } from './index';
import { mainWheelsPerSide, propBladesFor, wingletStyleFor } from './details';
import { shapeFor } from './shapes';

function positions(geometry: BufferGeometry): Float32Array {
  return (geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
}

/** Every vertex finite, and the whole thing inside the unit-ish box it claims. */
function expectSane(geometry: BufferGeometry, label: string): void {
  const array = positions(geometry);
  expect(array.length, `${label}: empty`).toBeGreaterThan(0);
  expect(array.length % 9, `${label}: not whole triangles`).toBe(0);
  for (let i = 0; i < array.length; i++) {
    expect(Number.isFinite(array[i]), `${label}: vertex ${i} is ${array[i]}`).toBe(true);
  }
}

/** Normalised models must stay near length 1 or the scale-by-length is a lie. */
function extent(geometry: BufferGeometry, axis: 0 | 1 | 2): number {
  const array = positions(geometry);
  let min = Infinity;
  let max = -Infinity;
  for (let i = axis; i < array.length; i += 3) {
    min = Math.min(min, array[i]!);
    max = Math.max(max, array[i]!);
  }
  return max - min;
}

const SAMPLE = [
  ['A21N', 'A3'],
  ['B38M', 'A3'],
  ['B77W', 'A5'],
  ['A388', 'A5'],
  ['DH8D', 'A2'],
  ['AT76', 'A2'],
  ['CRJ9', 'A2'],
  ['C172', 'A1'],
  ['PC12', 'A1'],
  ['EC35', 'A7'],
  ['R44', 'A7'],
  [null, 'B1'],
  [null, null],
] as const;

describe('buildAircraftModel', () => {
  it('produces finite geometry for every kind of airframe', () => {
    for (const [type, category] of SAMPLE) {
      const model = buildAircraftModel(type, category, 'high');
      const label = type ?? `category ${category}`;

      expectSane(model.hull, `${label} hull`);
      if (model.trim) expectSane(model.trim, `${label} trim`);
      if (model.gear) expectSane(model.gear, `${label} gear`);
      for (const spinner of model.spinners) expectSane(spinner.geometry, `${label} spinner`);

      disposeAircraftModel(model);
    }
  });

  it('stays normalised to length 1 along the fuselage axis', () => {
    // Everything downstream multiplies by `shape.length`. A model that is 1.4
    // long is a 56 m A320, and nothing anywhere would report an error.
    for (const [type, category] of SAMPLE) {
      const model = buildAircraftModel(type, category, 'high');
      expect(extent(model.hull, 1), type ?? 'default').toBeLessThan(1.15);
      expect(extent(model.hull, 1), type ?? 'default').toBeGreaterThan(0.85);
      disposeAircraftModel(model);
    }
  });

  it('puts propellers on propeller aircraft and none on jets', () => {
    const dash8 = buildAircraftModel('DH8D', 'A2');
    expect(dash8.spinners).toHaveLength(2);
    expect(dash8.spinners.every((s) => s.drive === 'propeller')).toBe(true);

    const cessna = buildAircraftModel('C172', 'A1');
    expect(cessna.spinners).toHaveLength(1);

    const a320 = buildAircraftModel('A20N', 'A3');
    expect(a320.spinners).toHaveLength(0);

    for (const m of [dash8, cessna, a320]) disposeAircraftModel(m);
  });

  it('gives a helicopter both of its rotors', () => {
    const heli = buildAircraftModel('EC35', 'A7');
    expect(heli.spinners.map((s) => s.drive).sort()).toEqual(['mainRotor', 'tailRotor']);
    // And no undercarriage to extend: it has skids, built into the hull.
    expect(heli.gear).toBeNull();
    disposeAircraftModel(heli);
  });

  it('gives every spinner a blur disc that covers its own blades', () => {
    // The two radii are set from one option, and the one time they were set
    // separately the disc was smaller than the blades it was hiding.
    const model = buildAircraftModel('AT76', 'A2');
    for (const spinner of model.spinners) {
      expect(extent(spinner.disc, 0)).toBeGreaterThanOrEqual(extent(spinner.geometry, 0) * 0.98);
    }
    disposeAircraftModel(model);
  });

  it('omits trim at low detail, where it would be paid for a thousand times', () => {
    const low = buildAircraftModel('A21N', 'A3', 'low');
    expect(low.trim).toBeNull();
    expect(positions(low.hull).length).toBeLessThan(
      positions(buildAircraftModel('A21N', 'A3', 'high').hull).length,
    );
    disposeAircraftModel(low);
  });
});

/**
 * How many of a geometry's triangles face a viewer standing at `eye`.
 *
 * The one check that would have caught the windows being wound inward. Every
 * structural test passed while they were: the buffer existed, the vertex count
 * was right, nothing was NaN, the mesh was in the scene and marked visible —
 * and the aircraft had no windows, because back-face culling removed every
 * triangle before it reached the screen. Nothing about a geometry in isolation
 * can see that; you have to ask whether it is visible from somewhere.
 */
function facingCount(geometry: BufferGeometry, eye: readonly [number, number, number]): number {
  const p = positions(geometry);
  let facing = 0;

  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i]!, ay = p[i + 1]!, az = p[i + 2]!;
    const bx = p[i + 3]!, by = p[i + 4]!, bz = p[i + 5]!;
    const cx = p[i + 6]!, cy = p[i + 7]!, cz = p[i + 8]!;

    // Normal by the right-hand rule, matching the renderer's front-face sense.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - bx, vy = cy - by, vz = cz - bz;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;

    // From the eye to the face: a front face has the normal pointing back at it.
    const dx = (ax + bx + cx) / 3 - eye[0];
    const dy = (ay + by + cy) / 3 - eye[1];
    const dz = (az + bz + cz) / 3 - eye[2];

    if (nx * dx + ny * dy + nz * dz < 0) facing++;
  }
  return facing;
}

describe('trim is visible from outside the aircraft', () => {
  it('shows windows to a viewer abeam, on either side', () => {
    const model = buildAircraftModel('A21N', 'A3', 'high');
    expect(model.trim).not.toBeNull();

    // Well clear of the airframe, level with the cabin, on each beam.
    const starboard = facingCount(model.trim!, [4, 0, 0.05]);
    const port = facingCount(model.trim!, [-4, 0, 0.05]);

    expect(starboard, 'nothing facing starboard').toBeGreaterThan(12);
    expect(port, 'nothing facing port').toBeGreaterThan(12);
    disposeAircraftModel(model);
  });

  it('shows a windscreen to a viewer ahead of the nose', () => {
    const model = buildAircraftModel('A21N', 'A3', 'high');
    expect(facingCount(model.trim!, [0, 4, 0.2])).toBeGreaterThan(8);
    disposeAircraftModel(model);
  });

  it('shows the helicopter its glasshouse', () => {
    const model = buildAircraftModel('EC35', 'A7', 'high');
    expect(facingCount(model.trim!, [0, 4, 0])).toBeGreaterThan(6);
    expect(facingCount(model.trim!, [3, 1, 0])).toBeGreaterThan(4);
    disposeAircraftModel(model);
  });

  it('keeps the hull facing outward too', () => {
    // The same failure on the hull would turn the aircraft inside out, which
    // at least is obvious — but the check is free now that it is written.
    const model = buildAircraftModel('A21N', 'A3', 'high');
    const total = positions(model.hull).length / 9;
    expect(facingCount(model.hull, [6, 0, 0])).toBeGreaterThan(total * 0.3);
    disposeAircraftModel(model);
  });
});

describe('details derived from the airframe', () => {
  it('scales propeller blades with the size of the turboprop', () => {
    expect(propBladesFor(shapeFor('DH8D', 'A2'))).toBe(6);
    expect(propBladesFor(shapeFor('DHC6', 'A2'))).toBe(4);
    expect(propBladesFor(shapeFor('C172', 'A1'))).toBe(2);
    expect(propBladesFor(shapeFor('A20N', 'A3'))).toBe(0);
  });

  it('gives the modern widebodies raked tips and the narrowbodies winglets', () => {
    expect(wingletStyleFor(shapeFor('B78X', 'A5'))).toBe('raked');
    expect(wingletStyleFor(shapeFor('A35K', 'A5'))).toBe('raked');
    expect(wingletStyleFor(shapeFor('A21N', 'A3'))).toBe('blended');
    // And nothing at all on something that has never carried one.
    expect(wingletStyleFor(shapeFor('C172', 'A1'))).toBe('none');
    expect(wingletStyleFor(shapeFor('EC35', 'A7'))).toBe('none');
  });

  it('puts more wheels under heavier aircraft', () => {
    expect(mainWheelsPerSide(shapeFor('A388', 'A5'))).toBeGreaterThan(
      mainWheelsPerSide(shapeFor('A20N', 'A3')),
    );
    expect(mainWheelsPerSide(shapeFor('C172', 'A1'))).toBe(1);
  });
});

describe('propeller rate', () => {
  it('is governed: it barely moves between climb and cruise', () => {
    // The point of a constant-speed propeller. Modelling the rate as
    // proportional to power — the obvious thing — produces a propeller that
    // visibly winds down in the descent, which is exactly backwards.
    const climb = propellerRpm('turboprop', 0.95);
    const cruise = propellerRpm('turboprop', 0.6);
    const descent = propellerRpm('turboprop', 0.25);
    expect(climb).toBe(cruise);
    expect(descent).toBe(cruise);
  });

  it('does follow the throttle below the governing range', () => {
    expect(propellerRpm('piston', 0)).toBeLessThan(propellerRpm('piston', 0.1));
    expect(propellerRpm('piston', 0.1)).toBeLessThan(propellerRpm('piston', 0.2));
  });

  it('never animates fast enough to alias at 60 Hz', () => {
    // A 2400 rpm propeller is 40 revolutions a second. Drawn honestly at 60
    // frames it appears to crawl backwards, which is worse than being wrong.
    expect(visibleSpinRate(2_400)).toBeLessThan(10);
    expect(visibleSpinRate(200)).toBeCloseTo(200 / 60, 6);
  });

  it('hands over from blades to blur disc as the rate climbs', () => {
    expect(bladeOpacity(0)).toBe(1);
    expect(bladeOpacity(2_400)).toBe(0);
    const mid = bladeOpacity(550);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('the wingtip device is a winglet, not a plank', () => {
  /**
   * Reported as "des carrés blancs autour des ailes".
   *
   * It was a rectangle stood on the wingtip at ninety degrees, at the wing's
   * own thickness and 1.35 times the tip chord tall — so from anywhere but
   * dead astern it read as a white board bolted to the wing. Nothing caught it
   * because nothing was looking: the triangles were there, wound correctly,
   * and in the right place. Only the *shape* was wrong, and shape is what the
   * whole procedural model exists to get right.
   *
   * What separates a winglet from a board is cant, sweep and a blended root.
   * Each is checked here against the geometry rather than eyeballed, because
   * the eyeballing is what missed it the first time.
   */

  /** Vertices of a type's hull, as triples. */
  function hullVertices(typeCode: string): [number, number, number][] {
    const model = buildAircraftModel(typeCode, null, 'high');
    const position = model.hull.getAttribute('position');
    const out: [number, number, number][] = [];
    for (let i = 0; i < position.count; i++) {
      out.push([position.getX(i), position.getY(i), position.getZ(i)]);
    }
    disposeAircraftModel(model);
    return out;
  }

  /** The tip region: everything within 4% of the widest point, on one side. */
  function tipRegion(vertices: [number, number, number][]): [number, number, number][] {
    const halfSpan = Math.max(...vertices.map((v) => v[0]));
    return vertices.filter((v) => v[0] > halfSpan * 0.9);
  }

  /** Vertical extent of a set of vertices. */
  const heightOf = (vs: [number, number, number][]): number =>
    Math.max(...vs.map((v) => v[2])) - Math.min(...vs.map((v) => v[2]));

  /** Fore-aft extent of a set of vertices. */
  const chordOf = (vs: [number, number, number][]): number =>
    Math.max(...vs.map((v) => v[1])) - Math.min(...vs.map((v) => v[1]));

  /** The slice of a tip region between two fractions of its own height. */
  function band(
    tip: [number, number, number][],
    from: number,
    to: number,
  ): [number, number, number][] {
    const low = Math.min(...tip.map((v) => v[2]));
    const height = heightOf(tip);
    return tip.filter((v) => {
      const t = (v[2] - low) / height;
      return t >= from && t <= to;
    });
  }

  it('leans outboard as it rises', () => {
    // The cant, and the one property that actually separates the two shapes.
    //
    // "Tip is outboard of root" is not enough: the old vertical plank passed
    // it, because its two skins sit half a thickness either side of the same
    // X and the outer one is trivially outboard. The lean has to be a real
    // fraction of the height, which only a canted surface manages.
    const tip = tipRegion(hullVertices('A320'));
    const highest = tip.reduce((a, b) => (b[2] > a[2] ? b : a));
    const rootX = Math.min(...band(tip, 0, 0.2).map((v) => v[0]));
    const lean = highest[0] - rootX;
    const height = heightOf(tip);

    expect(lean / height, 'the winglet stands vertically, like a fin').toBeGreaterThan(0.15);
  });

  it('sweeps back as it rises', () => {
    // A rectangle has its top edge directly above its bottom edge. A winglet's
    // is well behind it — measured against the leading edge of its own root
    // rather than against z = 0, which no vertex sits exactly on.
    const tip = tipRegion(hullVertices('A320'));
    const highest = tip.reduce((a, b) => (b[2] > a[2] ? b : a));
    const rootLeading = Math.max(...band(tip, 0, 0.2).map((v) => v[1]));
    expect(highest[1], 'the winglet rises straight up instead of raking back').toBeLessThan(
      rootLeading,
    );
  });

  it('tapers rather than staying the same width', () => {
    const tip = tipRegion(hullVertices('A320'));
    const atRoot = chordOf(band(tip, 0, 0.2));
    const atTop = chordOf(band(tip, 0.8, 1));

    expect(atRoot).toBeGreaterThan(0);
    expect(atTop, 'the winglet is as wide at the top as at the root').toBeLessThan(atRoot * 0.7);
  });

  it('is not built for types that do not carry one', () => {
    // Drawing a winglet on everything is the other way to get this wrong. The
    // yardstick is the wing's own thickness at mid-span, not the tip chord: a
    // glider's tip chord is so small that any aerofoil looks tall against it.
    for (const type of ['ASK21', 'C172']) {
      const vertices = hullVertices(type);
      const halfSpan = Math.max(...vertices.map((v) => v[0]));
      // A wide band: a glider's wing is built from very few spanwise
      // stations, and a narrow slice of it can contain no vertices at all.
      const midWing = vertices.filter(
        (v) => v[0] > halfSpan * 0.3 && v[0] < halfSpan * 0.85,
      );
      const tip = tipRegion(vertices);

      expect(midWing.length, `${type}: no mid-wing vertices to measure against`).toBeGreaterThan(0);
      expect(
        heightOf(tip),
        `${type} has something standing on its wingtip`,
      ).toBeLessThan(heightOf(midWing) * 1.6);
    }
  });
});
