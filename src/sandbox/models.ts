/**
 * The sandbox's own airframes: armed, and built in code.
 *
 * The converted FlightGear hangar is airliners, bizjets and light aircraft —
 * the traffic people actually see. None of it carries anything to shoot with,
 * and the sandbox is about shooting. These four are drawn from primitives
 * here and handed to the model library in exactly the shape a converted model
 * has (`LoadedModel`: unit length, nose along +Y, up along +Z, parts with a
 * role), so everything that draws an aircraft — `OwnAircraft`, the camera
 * placement, the spinning rotors and propellers — takes them without knowing
 * they are different.
 *
 * Original work under the project licence, like the procedural generator.
 *
 * ## Conventions a builder must keep
 *
 *  - Metres while building, divided by the length at the end.
 *  - Spinning parts are built in the plane normal to +Y and centred on their
 *    hub; `origin` places the hub and `axis` says what they turn about. That
 *    is the converter's convention, and `OwnAircraft` stands the geometry onto
 *    its axis itself.
 *  - Mirrored halves have their winding reversed, or the two-sided lighting
 *    would light the left wing from inside.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  MeshLambertMaterial,
  Shape,
  SphereGeometry,
  BoxGeometry,
  Vector2,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { LoadedModel } from '@/render/aircraft/pvm';

type Role = LoadedModel['parts'][number]['role'];

/** Colours of one airframe's paint. */
interface Scheme {
  body: number;
  dark: number;
  accent: number;
  glass: number;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Non-indexed, with position, normal and uv, so anything can be merged. */
function plain(g: BufferGeometry): BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  if (!out.getAttribute('uv')) {
    out.setAttribute('uv', new BufferAttribute(new Float32Array(out.getAttribute('position').count * 2), 2));
  }
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') out.deleteAttribute(name);
  }
  return out;
}

/** The same shape on the other side, with its triangles turned back outward. */
function mirrorX(g: BufferGeometry): BufferGeometry {
  const m = plain(g.clone());
  m.applyMatrix4(new Matrix4().makeScale(-1, 1, 1));
  for (const name of ['position', 'normal', 'uv'] as const) {
    const attr = m.getAttribute(name);
    const size = attr.itemSize;
    const a = attr.array as Float32Array;
    for (let t = 0; t < attr.count; t += 3) {
      for (let k = 0; k < size; k++) {
        const i1 = (t + 1) * size + k;
        const i2 = (t + 2) * size + k;
        const tmp = a[i1]!;
        a[i1] = a[i2]!;
        a[i2] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
  return m;
}

/**
 * A flat surface from its outline: wings, fins, stabilisers.
 *
 * `points` are (span, chord) for a horizontal surface — x outboard, y forward
 * — and the surface is extruded `thickness` metres along z, centred.
 */
function planform(points: readonly [number, number][], thickness: number): BufferGeometry {
  const shape = new Shape(points.map(([x, y]) => new Vector2(x, y)));
  const g = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -thickness / 2);
  return plain(g);
}

/** A planform stood upright: `points` are (chord, height), thickness along x. */
function fin(points: readonly [number, number][], thickness: number): BufferGeometry {
  const g = planform(points, thickness);
  // (x, y, z) -> (z, x, y): chord along y, height along z, thickness along x.
  g.applyMatrix4(new Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  return g;
}

/** A body of revolution along y, from (radius, y) pairs listed tail to nose. */
function lathe(profile: readonly [number, number][], segments = 16): BufferGeometry {
  return plain(new LatheGeometry(profile.map(([r, y]) => new Vector2(r, y)), segments));
}

/** A cylinder along y. */
function tube(radius: number, length: number, y: number, x = 0, z = 0, tip = radius): BufferGeometry {
  const g = new CylinderGeometry(tip, radius, length, 10, 1);
  g.translate(x, y, z);
  return plain(g);
}

/** A missile: body, nose and a cross of fins, along y. */
function missile(x: number, y: number, z: number, length: number, radius: number): BufferGeometry {
  const parts = [tube(radius, length * 0.82, y - length * 0.09, x, z)];
  const nose = new ConeGeometry(radius, length * 0.18, 10);
  nose.translate(x, y + length * 0.41, z);
  parts.push(plain(nose));
  for (const angle of [0, Math.PI / 2]) {
    const f = new BoxGeometry(radius * 5, length * 0.12, radius * 0.25);
    f.rotateY(angle);
    f.translate(x, y - length * 0.44, z);
    parts.push(plain(f));
  }
  return mergeGeometries(parts)!;
}

function box(w: number, l: number, h: number, x: number, y: number, z: number): BufferGeometry {
  const g = new BoxGeometry(w, l, h);
  g.translate(x, y, z);
  return plain(g);
}

function ellipsoid(rx: number, ry: number, rz: number, x: number, y: number, z: number): BufferGeometry {
  const g = new SphereGeometry(1, 16, 10);
  g.scale(rx, ry, rz);
  g.translate(x, y, z);
  return plain(g);
}

/** Both sides of a symmetric part. */
function pair(g: BufferGeometry): BufferGeometry[] {
  return [g, mirrorX(g)];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface PartSpec {
  role: Role;
  name: string;
  geometries: BufferGeometry[];
  color: number;
  emissive?: number;
  origin?: [number, number, number];
  axis?: [number, number, number];
  transparent?: boolean;
}

function material(color: number, emissive = 0, transparent = false): MeshLambertMaterial {
  return new MeshLambertMaterial({
    color: new Color(color),
    emissive: new Color(emissive),
    transparent,
    side: DoubleSide,
  });
}

/** Normalise to unit length and package as a library model. */
function assemble(id: string, lengthM: number, parts: PartSpec[]): LoadedModel {
  const k = 1 / lengthM;
  return {
    id,
    source: 'PlanesView sandbox',
    license: 'MIT',
    lengthM,
    liveryTexture: -1,
    parts: parts.map((p) => {
      const geometry = mergeGeometries(p.geometries.map(plain))!;
      geometry.scale(k, k, k);
      geometry.computeBoundingSphere();
      const origin = p.origin ?? [0, 0, 0];
      return {
        role: p.role,
        name: p.name,
        geometry,
        material: material(p.color, p.emissive, p.transparent),
        textureIndex: -1,
        origin: [origin[0] * k, origin[1] * k, origin[2] * k] as const,
        axis: p.axis ?? [0, 1, 0],
      };
    }),
  };
}

/** Rotor blades in the plane normal to +y, about the hub. */
function blades(count: number, radius: number, chord: number, thickness: number): BufferGeometry {
  const out: BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const b = new BoxGeometry(radius, thickness, chord);
    b.translate(radius / 2, 0, 0);
    b.rotateY((i / count) * Math.PI * 2);
    out.push(plain(b));
  }
  const hub = new CylinderGeometry(chord * 0.9, chord * 0.9, thickness * 3, 10);
  out.push(plain(hub));
  return mergeGeometries(out)!;
}

// ---------------------------------------------------------------------------
// The four
// ---------------------------------------------------------------------------

/** A single-engine delta-ish fighter with wingtip missiles. 15 m. */
function viper(s: Scheme): LoadedModel {
  const L = 15;
  const body = lathe([
    [0.0, -7.5],
    [0.5, -7.4],
    [0.62, -6.8],
    [0.78, -5],
    [0.82, -1],
    [0.78, 2],
    [0.62, 4],
    [0.42, 5.6],
    [0.2, 6.8],
    [0.0, 7.5],
  ]);
  body.scale(1, 1, 0.86);
  const wing = planform(
    [
      [0.6, 1.8],
      [4.6, -2.3],
      [4.6, -3.3],
      [0.6, -4.2],
    ],
    0.16,
  );
  wing.translate(0, 0, -0.12);
  const strake = planform(
    [
      [0.5, 4.2],
      [0.95, 1.2],
      [0.6, 1.2],
    ],
    0.08,
  );
  const tailplane = planform(
    [
      [0.5, -5.2],
      [2.7, -6.7],
      [2.7, -7.3],
      [0.5, -7.1],
    ],
    0.1,
  );
  tailplane.translate(0, 0, -0.1);
  const verticalFin = fin(
    [
      [-4.6, 0.5],
      [-6.9, 3.4],
      [-7.6, 3.4],
      [-7.3, 0.5],
    ],
    0.12,
  );
  const intake = box(1.1, 3.4, 0.9, 0, 1.2, -0.72);
  const glow = tube(0.46, 0.25, -7.55);
  return assemble('sbx-viper', L, [
    {
      role: 'hull',
      name: 'airframe',
      color: s.body,
      geometries: [body, ...pair(wing), ...pair(strake), ...pair(tailplane), verticalFin, intake],
    },
    { role: 'hull', name: 'canopy', color: s.glass, emissive: 0x0b1a2c, geometries: [ellipsoid(0.42, 1.6, 0.5, 0, 3.6, 0.55)] },
    { role: 'hull', name: 'nozzle', color: 0x2b2b2e, geometries: [tube(0.56, 0.9, -7.1, 0, 0, 0.5)] },
    { role: 'hull', name: 'afterburner', color: 0xffa040, emissive: 0xff6a10, geometries: [glow] },
    {
      role: 'hull',
      name: 'stores',
      color: s.accent,
      geometries: [
        ...pair(missile(4.72, -2.4, -0.05, 3, 0.09)),
        ...pair(missile(3.1, -1.4, -0.45, 3.1, 0.1)),
      ],
    },
  ]);
}

/** A straight-winged ground-attack jet: two pods high at the back, twin fins. 16.3 m. */
function warthog(s: Scheme): LoadedModel {
  const L = 16.3;
  const body = lathe([
    [0.0, -8.15],
    [0.45, -7.9],
    [0.7, -6],
    [0.95, -2],
    [1.0, 1.5],
    [0.9, 4.5],
    [0.6, 6.8],
    [0.25, 8.0],
    [0.0, 8.15],
  ]);
  body.scale(1, 1, 1.05);
  const wing = planform(
    [
      [0.8, 1.4],
      [8.7, 0.5],
      [8.7, -1.0],
      [0.8, -1.8],
    ],
    0.3,
  );
  wing.translate(0, 0, -0.5);
  const pod = lathe([
    [0.0, -1.9],
    [0.55, -1.8],
    [0.62, -0.5],
    [0.62, 1.4],
    [0.5, 1.9],
  ]);
  pod.translate(1.35, -4.6, 1.05);
  const pylon = box(0.25, 1.6, 0.6, 0.9, -4.4, 0.7);
  const tailplane = planform(
    [
      [0, -6.6],
      [3.0, -6.9],
      [3.0, -7.9],
      [0, -7.9],
    ],
    0.14,
  );
  const tailFin = fin(
    [
      [-6.6, -0.8],
      [-7.2, 2.2],
      [-8.0, 2.2],
      [-8.1, -0.8],
    ],
    0.14,
  );
  tailFin.translate(3.0, 0, 0);
  const gun = tube(0.09, 1.2, 8.3, 0, -0.2);
  return assemble('sbx-warthog', L, [
    {
      role: 'hull',
      name: 'airframe',
      color: s.body,
      geometries: [body, ...pair(wing), ...pair(pod), ...pair(pylon), ...pair(tailplane), ...pair(tailFin)],
    },
    { role: 'hull', name: 'canopy', color: s.glass, emissive: 0x0b1a2c, geometries: [ellipsoid(0.55, 1.4, 0.55, 0, 4.4, 0.75)] },
    { role: 'hull', name: 'gun', color: s.dark, geometries: [gun] },
    { role: 'hull', name: 'exhaust', color: 0xffa040, emissive: 0xc05010, geometries: pair(tube(0.42, 0.12, -6.55, 1.35, 1.05)) },
    {
      role: 'hull',
      name: 'stores',
      color: s.accent,
      geometries: [
        ...pair(missile(3.4, 0.2, -0.95, 2.8, 0.13)),
        ...pair(missile(5.2, 0.0, -0.95, 2.8, 0.13)),
        ...pair(missile(6.9, -0.2, -0.95, 2.4, 0.11)),
      ],
    },
  ]);
}

/** A tandem-seat attack helicopter with stub wings and rocket pods. 17.7 m. */
function striker(s: Scheme): LoadedModel {
  const L = 17.7;
  const body = lathe([
    [0.0, -3.6],
    [0.7, -3.2],
    [1.05, -1.5],
    [1.05, 1.5],
    [0.85, 3.4],
    [0.55, 5.0],
    [0.2, 6.1],
    [0.0, 6.35],
  ]);
  body.scale(0.85, 1, 1.15);
  const boom = tube(0.42, 7.5, -7.2, 0, 0.35, 0.22);
  const tailFin = fin(
    [
      [-9.8, 0.2],
      [-10.8, 2.4],
      [-11.35, 2.4],
      [-11.1, 0.2],
    ],
    0.16,
  );
  const tailplane = planform(
    [
      [0, -10.0],
      [1.7, -10.1],
      [1.7, -10.7],
      [0, -10.7],
    ],
    0.1,
  );
  tailplane.translate(0, 0, 0.4);
  const stub = planform(
    [
      [0.8, 0.7],
      [2.9, 0.5],
      [2.9, -0.5],
      [0.8, -0.9],
    ],
    0.22,
  );
  stub.translate(0, 0, 0.1);
  const pod = lathe(
    [
      [0.0, -0.95],
      [0.32, -0.9],
      [0.34, 0.8],
      [0.2, 1.0],
    ],
    12,
  );
  pod.translate(2.3, 0.1, -0.35);
  const engine = ellipsoid(0.55, 1.6, 0.5, 1.05, -0.8, 0.95);
  const mastUpright = box(0.34, 0.34, 1.0, 0, 0, 1.75);
  const skid = box(0.12, 3.4, 0.12, 0.95, 0.2, -1.4);
  const rotorOrigin: [number, number, number] = [0, 0, 2.3];
  const tailRotorOrigin: [number, number, number] = [-0.28, -10.7, 1.6];
  return assemble('sbx-striker', L, [
    {
      role: 'hull',
      name: 'airframe',
      color: s.body,
      geometries: [body, boom, tailFin, ...pair(tailplane), ...pair(stub), ...pair(engine), mastUpright, ...pair(skid)],
    },
    {
      role: 'hull',
      name: 'canopy',
      color: s.glass,
      emissive: 0x0b1a2c,
      geometries: [ellipsoid(0.62, 1.2, 0.5, 0, 3.6, 0.72), ellipsoid(0.62, 1.1, 0.5, 0, 1.7, 0.95)],
    },
    { role: 'hull', name: 'pods', color: s.dark, geometries: pair(pod) },
    { role: 'hull', name: 'stores', color: s.accent, geometries: pair(missile(3.05, 0.2, -0.3, 1.8, 0.09)) },
    { role: 'hull', name: 'gun', color: s.dark, geometries: [tube(0.06, 1.4, 5.6, 0, -1.05), box(0.4, 0.5, 0.4, 0, 5.0, -1.0)] },
    {
      role: 'mainRotor',
      name: 'rotor',
      color: 0x1e2226,
      geometries: [blades(4, 7.3, 0.55, 0.1)],
      origin: rotorOrigin,
      axis: [0, 0, 1],
      transparent: true,
    },
    {
      role: 'tailRotor',
      name: 'tailrotor',
      color: 0x1e2226,
      geometries: [blades(4, 1.4, 0.25, 0.06)],
      origin: tailRotorOrigin,
      axis: [1, 0, 0],
      transparent: true,
    },
  ]);
}

/** A radial-engined carrier fighter with gull wings. 10.2 m. */
function corsair(s: Scheme): LoadedModel {
  const L = 10.2;
  const body = lathe([
    [0.0, -5.1],
    [0.25, -5.0],
    [0.45, -3.5],
    [0.62, -1],
    [0.7, 1.2],
    [0.72, 3.4],
    [0.74, 3.9],
    [0.62, 4.4],
  ]);
  const cowl = tube(0.78, 0.9, 3.95, 0, 0, 0.74);
  const inner = planform(
    [
      [0.5, 1.4],
      [2.2, 1.2],
      [2.2, -0.9],
      [0.5, -1.0],
    ],
    0.26,
  );
  inner.applyMatrix4(new Matrix4().makeRotationY(0.35));
  inner.translate(0, 0, -0.3);
  const outer = planform(
    [
      [2.1, 1.2],
      [6.2, 0.6],
      [6.2, -0.4],
      [2.1, -0.9],
    ],
    0.22,
  );
  outer.applyMatrix4(new Matrix4().makeRotationY(-0.12));
  outer.translate(0, 0, -0.95);
  const tailplane = planform(
    [
      [0.2, -3.8],
      [2.4, -4.2],
      [2.4, -4.8],
      [0.2, -5.0],
    ],
    0.1,
  );
  const tailFin = fin(
    [
      [-3.6, 0.3],
      [-4.4, 1.9],
      [-5.0, 1.9],
      [-5.1, 0.3],
    ],
    0.12,
  );
  const propOrigin: [number, number, number] = [0, 4.55, 0];
  return assemble('sbx-corsair', L, [
    {
      role: 'hull',
      name: 'airframe',
      color: s.body,
      geometries: [body, cowl, ...pair(inner), ...pair(outer), ...pair(tailplane), tailFin],
    },
    { role: 'hull', name: 'canopy', color: s.glass, emissive: 0x0b1a2c, geometries: [ellipsoid(0.42, 1.1, 0.45, 0, -0.4, 0.62)] },
    {
      role: 'hull',
      name: 'stores',
      color: s.accent,
      geometries: [...pair(missile(3.4, 0.1, -1.1, 1.6, 0.08)), ...pair(missile(4.2, 0.0, -1.1, 1.6, 0.08))],
    },
    {
      role: 'prop',
      name: 'prop',
      color: 0x1b1d20,
      geometries: [blades(3, 1.9, 0.22, 0.06)],
      origin: propOrigin,
      axis: [0, 1, 0],
      transparent: true,
    },
  ]);
}

/** Type designators the sandbox's airframes answer to. */
export const SANDBOX_TYPES = {
  viper: 'SBF1',
  warthog: 'SBA1',
  striker: 'SBH1',
  corsair: 'SBP1',
} as const;

const BUILDERS: Record<string, () => LoadedModel> = {
  [SANDBOX_TYPES.viper]: () => viper({ body: 0x8d99a6, dark: 0x3a4048, accent: 0xe8e8e2, glass: 0x2a3f55 }),
  [SANDBOX_TYPES.warthog]: () => warthog({ body: 0x77808a, dark: 0x2d3136, accent: 0xdedcd2, glass: 0x2a3f55 }),
  [SANDBOX_TYPES.striker]: () => striker({ body: 0x4f5b3d, dark: 0x262b22, accent: 0xd9d6c8, glass: 0x1f3242 }),
  [SANDBOX_TYPES.corsair]: () => corsair({ body: 0x2c4b76, dark: 0x1a2230, accent: 0xe3e1d6, glass: 0x30465e }),
};

const built = new Map<string, LoadedModel>();

/** The sandbox model for a type code, built once; null for any other type. */
export function sandboxModel(typeCode: string): LoadedModel | null {
  const code = typeCode.toUpperCase();
  const builder = BUILDERS[code];
  if (!builder) return null;
  let model = built.get(code);
  if (!model) {
    model = builder();
    built.set(code, model);
  }
  return model;
}
