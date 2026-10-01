import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parsePvm } from './pvm';
import { lightAnchorsFor } from './lightAnchors';

function load(id: string) {
  const b = readFileSync(`public/models/${id}.pvm`);
  return parsePvm(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, []);
}

describe('light anchors', () => {
  it('fits a 737’s lights to its skin, not to its bounding box', () => {
    const a = lightAnchorsFor(load('b738'))!;
    // The fuselage runs from z −0.123 to −0.023: beacons on it, not at ±r about 0.
    expect(a.top[2]).toBeCloseTo(-0.023, 2);
    expect(a.belly[2]).toBeCloseTo(-0.127, 2);
    // Tips at the span's edge, low (no floating above the wing), aft of the root.
    expect(a.tip[0]).toBeGreaterThan(0.43);
    expect(a.tip[2]).toBeLessThan(-0.04);
    expect(a.tip[1]).toBeLessThan(0);
    // Tail cone at the very back, below the crown.
    expect(a.tail[1]).toBeLessThan(-0.45);
    expect(a.tail[2]).toBeLessThan(a.top[2]);
  });

  it('puts a high wing’s tips above the fuselage centreline', () => {
    const a = lightAnchorsFor(load('c172'))!;
    expect(a.tip[2]).toBeGreaterThan((a.top[2] + a.belly[2]) / 2);
  });

  it('is cached per model', () => {
    const m = load('crj7');
    expect(lightAnchorsFor(m)).toBe(lightAnchorsFor(m));
  });
});
