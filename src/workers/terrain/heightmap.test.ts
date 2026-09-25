/**
 * Elevation decoding, and the two ways a tile turns into a spike.
 *
 * Terrarium packs the top byte of the height into the red channel, so a single
 * wrong byte is worth 256 m — and eight wrong bits are worth thirty-two
 * kilometres. Reported as "un pic sur la carte est apparu et est monté dans le
 * ciel", which is exactly what one corrupt texel looks like once it has been
 * meshed: a needle climbing out of the ground with the terrain draped over it.
 *
 * The repair and the bound are tested separately because they answer different
 * failures. The despike fixes a texel that disagrees with its neighbours; the
 * clamp is what catches the ones it cannot reach.
 */

import { describe, expect, it } from 'vitest';

import { despikeRedChannel } from './heightmap';

/** A flat plain at `base` metres, `size` square. */
function plain(size: number, base: number): Float32Array {
  return new Float32Array(size * size).fill(base);
}

describe('despikeRedChannel', () => {
  it('repairs a texel a whole red unit above its neighbours', () => {
    const size = 8;
    const data = plain(size, 120);
    const middle = 3 * size + 3;
    data[middle] = 120 + 256;

    expect(despikeRedChannel(data, size, size)).toBe(1);
    expect(data[middle]).toBeCloseTo(120, 6);
  });

  it('repairs one a whole red unit below', () => {
    const size = 8;
    const data = plain(size, 4_000);
    const middle = 4 * size + 4;
    data[middle] = 4_000 - 256;

    expect(despikeRedChannel(data, size, size)).toBe(1);
    expect(data[middle]).toBeCloseTo(4_000, 6);
  });

  it('repairs a badly corrupt byte, not just an off-by-one', () => {
    // The reported case: a red channel that came back far too high, worth
    // dozens of units rather than one.
    const size = 8;
    const data = plain(size, 300);
    const middle = 2 * size + 5;
    data[middle] = 300 + 256 * 90;

    expect(despikeRedChannel(data, size, size)).toBe(1);
    expect(data[middle]).toBeCloseTo(300, 6);
  });

  it('leaves a real cliff alone', () => {
    // A 256 m step with neighbours on the high side is terrain, not an error.
    // Correcting it would flatten every escarpment on Earth by one red unit.
    const size = 8;
    const data = plain(size, 100);
    for (let y = 0; y < size; y++) {
      for (let x = 4; x < size; x++) data[y * size + x] = 100 + 256;
    }

    expect(despikeRedChannel(data, size, size)).toBe(0);
  });

  it('leaves ordinary rolling terrain alone', () => {
    const size = 16;
    const data = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) data[y * size + x] = 200 + Math.sin(x * 0.4) * 60 + y * 3;
    }
    const before = Float32Array.from(data);

    expect(despikeRedChannel(data, size, size)).toBe(0);
    expect(Array.from(data)).toEqual(Array.from(before));
  });

  it('cannot reach the border, which is why the clamp exists', () => {
    // Not a defect to fix here — an edge texel has no four neighbours to
    // disagree with. It is the reason the decoder bounds the result as well.
    const size = 8;
    const data = plain(size, 50);
    data[0] = 50 + 256 * 100;

    expect(despikeRedChannel(data, size, size)).toBe(0);
    expect(data[0]).toBeGreaterThan(25_000);
  });
});
