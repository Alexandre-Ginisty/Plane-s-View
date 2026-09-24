/**
 * The converted models, checked against the real files.
 *
 * These read `public/models/*.pvm` rather than a fixture, on purpose. The
 * format has two ends — `tools/fgmodel/convert.mjs` writes it and `pvm.ts`
 * reads it — and a test built on a hand-written fixture would only prove the
 * reader agrees with the fixture. What has to hold is that the reader agrees
 * with the *writer*, and that what comes out is an aeroplane: the right length,
 * the right way up, propellers where the engines are.
 *
 * If the models are not present the suite skips rather than fails. They are
 * build artefacts of a script that talks to the network, and a checkout that
 * has not run it is not broken.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BufferAttribute } from 'three';

import { parsePvm, texturesOf } from './pvm';

const DIR = join(process.cwd(), 'public', 'models');
const have = (id: string): boolean => existsSync(join(DIR, `${id}.pvm`));

function load(id: string) {
  const file = readFileSync(join(DIR, `${id}.pvm`));
  // Copy into a standalone ArrayBuffer: Node pools small Buffers in a shared
  // one, and the byte offsets in the header are relative to the file.
  const copy = new ArrayBuffer(file.byteLength);
  new Uint8Array(copy).set(file);
  return { buffer: copy, model: parsePvm(copy, []) };
}

function extent(attribute: BufferAttribute, axis: 0 | 1 | 2): [number, number] {
  const a = attribute.array as Float32Array;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = axis; i < a.length; i += 3) {
    lo = Math.min(lo, a[i]!);
    hi = Math.max(hi, a[i]!);
  }
  return [lo, hi];
}

describe.skipIf(!have('dh8d'))('the Dash 8 model', () => {
  it('reads back with the parts the renderer needs', () => {
    const { model } = load('dh8d');
    const roles = model.parts.map((p) => p.role);

    expect(roles).toContain('hull');
    expect(roles).toContain('gear');
    // Six-bladed propellers are the whole reason this aircraft is in the
    // library — the procedural model could not give it any.
    expect(roles.filter((r) => r === 'prop')).toHaveLength(2);
    expect(model.license).toBe('GPL-2.0');
  });

  it('is normalised to length 1 along the fuselage axis', () => {
    // Everything downstream multiplies by the type's real length. A model that
    // came out at some other scale would be silently the wrong size.
    const { model } = load('dh8d');
    let lo = Infinity;
    let hi = -Infinity;
    for (const part of model.parts) {
      if (part.role !== 'hull') continue;
      const [a, b] = extent(part.geometry.getAttribute('position') as BufferAttribute, 1);
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
    expect(hi - lo).toBeCloseTo(1, 1);
  });

  it('puts the propellers on the wings, ahead of the centre, one each side', () => {
    /*
     * The single best check that the axis conversion is right. FlightGear is
     * +X aft, +Y up, +Z port; this app is +Y nose, +X starboard, +Z up. Get it
     * wrong and the aeroplane still looks like an aeroplane from most angles —
     * it is just flying sideways, or mirrored. Propellers are unambiguous:
     * there must be one either side of the centreline and both must be forward
     * of it.
     */
    const { model } = load('dh8d');
    const props = model.parts.filter((p) => p.role === 'prop');

    const sides = props.map((p) => Math.sign(p.origin[0]));
    expect(sides.sort()).toEqual([-1, 1]);
    for (const prop of props) {
      expect(prop.origin[1], 'propeller is behind the centre of the aircraft').toBeGreaterThan(0);
      expect(prop.axis).toEqual([0, 1, 0]);
    }
  });

  it('names the textures it needs', () => {
    const { buffer } = load('dh8d');
    const textures = texturesOf(buffer);
    expect(textures.length).toBeGreaterThan(0);
    for (const name of textures) expect(existsSync(join(DIR, name)), name).toBe(true);
  });
});

describe.skipIf(!have('b77w'))('the 777 model', () => {
  it('carries no zero-thickness helper sheets', () => {
    /*
     * FlightGear models include a cast-shadow plane, and the 777's was 62 m by
     * 6 m and named `Fuselage.001`. In a simulator it is projected onto the
     * ground; here it rendered as a large black wedge across the wing. The
     * converter drops untextured planar sheets, and this is what holds it to
     * that.
     */
    const { model } = load('b77w');
    for (const part of model.parts) {
      const position = part.geometry.getAttribute('position') as BufferAttribute;
      const spans = ([0, 1, 2] as const).map((axis) => {
        const [lo, hi] = extent(position, axis);
        return hi - lo;
      });
      expect(Math.min(...spans), `${part.name} is a flat sheet`).toBeGreaterThan(0);
    }
  });

  it('is wider than it is tall, and about as long as it is wide', () => {
    // A 777-300ER is 73.9 m long and 64.8 m across, so span/length is about
    // 0.88 and height/length about 0.25. Any axis mix-up breaks these.
    const { model } = load('b77w');
    let x = 0;
    let z = 0;
    for (const part of model.parts) {
      const position = part.geometry.getAttribute('position') as BufferAttribute;
      const [x0, x1] = extent(position, 0);
      const [z0, z1] = extent(position, 2);
      x = Math.max(x, x1 - x0);
      z = Math.max(z, z1 - z0);
    }
    expect(x).toBeGreaterThan(0.75);
    expect(x).toBeLessThan(1.05);
    expect(z).toBeLessThan(0.4);
  });
});

describe('parsePvm', () => {
  it('refuses something that is not a model', () => {
    const junk = new ArrayBuffer(64);
    new Uint8Array(junk).set([0x50, 0x4b, 0x03, 0x04]); // a zip
    expect(() => parsePvm(junk, [])).toThrow(/not a PlanesView model/);
  });
});
