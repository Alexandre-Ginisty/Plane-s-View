/**
 * The spike bug, pinned.
 *
 * Terrarium's red channel is worth 256 metres per unit, so a decoder that is
 * merely *nearly* right is useless: reading `R=129` where the file says
 * `R=128` puts a 256 m needle through the ground. That is not hypothetical —
 * it is what the canvas round trip did to 64 texels of a single tile over the
 * South Downs, and it is what the ground looked like from a low viewpoint.
 *
 * So these tests build real PNG bytes, with every scanline filter PNG defines,
 * and require the decoder to return the exact samples that went in.
 */

import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';

import { decodePng } from './png';
import { despikeRedChannel } from './heightmap';

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Encode RGB samples as a PNG, applying one filter type to every scanline.
 * Filtering is what a decoder gets wrong, so the tests exercise all five.
 */
function makePng(rgb: Uint8Array, width: number, height: number, filter: number): ArrayBuffer {
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));

  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const cur = rgb[y * stride + i]!;
      const a = i >= 3 ? rgb[y * stride + i - 3]! : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + i]! : 0;
      const c = i >= 3 && y > 0 ? rgb[(y - 1) * stride + i - 3]! : 0;

      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + i] = (cur - pred) & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

/** A plausible heightfield: gentle relief either side of the R=128 boundary. */
function terrainSamples(width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Heights around 200-320 m, so the encoding crosses R=128 -> R=129 and
      // the decoder has to carry the red channel correctly.
      const metres = 200 + 60 * Math.sin(x / 5) + 60 * Math.cos(y / 7);
      const raw = Math.round((metres + 32768) * 256);
      const i = (y * width + x) * 3;
      rgb[i] = (raw >> 16) & 0xff;
      rgb[i + 1] = (raw >> 8) & 0xff;
      rgb[i + 2] = raw & 0xff;
    }
  }
  return rgb;
}

describe('decodePng', () => {
  it('returns the exact samples for every scanline filter', async () => {
    const width = 24;
    const height = 18;
    const rgb = terrainSamples(width, height);

    for (const filter of [0, 1, 2, 3, 4]) {
      const decoded = await decodePng(makePng(rgb, width, height, filter));
      expect(decoded, `filter ${filter}`).not.toBeNull();
      expect(decoded!.width).toBe(width);
      expect(decoded!.height).toBe(height);
      expect(decoded!.channels).toBe(3);
      // Byte-for-byte. Anything less is a 256 m error waiting to happen.
      expect(Array.from(decoded!.data), `filter ${filter}`).toEqual(Array.from(rgb));
    }
  });

  it('declines a file it cannot decode exactly rather than guessing', async () => {
    expect(await decodePng(new Uint8Array([1, 2, 3]).buffer)).toBeNull();
    // A valid signature but a truncated body is not something to improvise on.
    expect(await decodePng(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer)).toBeNull();
  });
});

describe('despikeRedChannel', () => {
  const grid = (w: number, h: number, fill: number): Float32Array => {
    const d = new Float32Array(w * h);
    d.fill(fill);
    return d;
  };

  it('repairs a texel exactly one red-channel unit too high', () => {
    const w = 7;
    const d = grid(w, w, 120);
    d[3 * w + 3] = 120 + 256; // the measured failure: R=129 where it should be 128
    expect(despikeRedChannel(d, w, w)).toBe(1);
    expect(d[3 * w + 3]).toBeCloseTo(120, 5);
  });

  it('repairs one that came back a unit too low', () => {
    const w = 7;
    const d = grid(w, w, 400);
    d[3 * w + 3] = 400 - 256;
    expect(despikeRedChannel(d, w, w)).toBe(1);
    expect(d[3 * w + 3]).toBeCloseTo(400, 5);
  });

  it('leaves a real cliff alone', () => {
    // A 256 m step across half the grid is terrain, not a channel error: the
    // high texels have high neighbours, so nothing is a lone outlier.
    const w = 9;
    const d = grid(w, w, 100);
    for (let y = 0; y < w; y++) for (let x = 5; x < w; x++) d[y * w + x] = 356;
    const before = Array.from(d);
    expect(despikeRedChannel(d, w, w)).toBe(0);
    expect(Array.from(d)).toEqual(before);
  });

  it('leaves ordinary rough ground alone', () => {
    const w = 16;
    const d = new Float32Array(w * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) d[y * w + x] = 300 + 40 * Math.sin(x) + 40 * Math.cos(y);
    }
    expect(despikeRedChannel(d, w, w)).toBe(0);
  });
});
