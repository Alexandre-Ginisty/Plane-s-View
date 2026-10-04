/**
 * A Mapbox Vector Tile's protocol buffer, read by hand.
 *
 * A vector tile is a protocol buffer: layers of features, each a list of
 * drawing commands in tile units (0..extent, y down) and a list of tags
 * pointing into the layer's key and value tables. This is the cursor and the
 * geometry decoder; `layers.ts` reads only the layers the night map and the
 * ground detail draw, and steps over every other without decoding it, which
 * is most of the bytes in a city tile (labels, points of interest, paths).
 *
 * Written out rather than taken from a library: the format is small and
 * stable (spec 2.1), the decoder is short, and it runs in a worker where
 * pulling in MapLibre's internals would mean shipping its whole parser a
 * second time.
 */

/** Minimal protocol-buffer cursor: varints, lengths, skips. */
export class Pbf {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  get end(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): number {
    const b = this.buf;
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (this.pos >= b.length) throw new Error('truncated varint');
      byte = b[this.pos++]!;
      // Multiplication, not <<: shifts are 32-bit and ids can exceed that.
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) this.pos += this.varint();
    else if (wireType === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wireType}`);
  }

  /** A sub-message's bytes, as a cursor of its own. */
  message(): Pbf {
    const len = this.varint();
    const sub = new Pbf(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return sub;
  }

  string(): string {
    const len = this.varint();
    const s = DECODER.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  packed(): number[] {
    const len = this.varint();
    const end = this.pos + len;
    const out: number[] = [];
    while (this.pos < end) out.push(this.varint());
    return out;
  }

  double(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }

  float(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }
}

const DECODER = new TextDecoder();

export type Value = string | number | boolean | null;

export function readValue(p: Pbf): Value {
  let v: Value = null;
  while (!p.end) {
    const tag = p.varint();
    const field = tag >> 3;
    if (field === 1) v = p.string();
    else if (field === 2) v = p.float();
    else if (field === 3) v = p.double();
    else if (field === 4 || field === 5) v = p.varint();
    else if (field === 6) {
      const n = p.varint();
      v = n % 2 === 1 ? -(n + 1) / 2 : n / 2;
    } else if (field === 7) v = p.varint() !== 0;
    else p.skip(tag & 7);
  }
  return v;
}

export const zigzag = (n: number): number => (n >>> 1) ^ -(n & 1);

/** A polygon feature's geometry commands, as rings. */
export function decodeRings(cmds: number[]): Float64Array[] {
  const rings: Float64Array[] = [];
  let x = 0;
  let y = 0;
  let ring: number[] = [];
  for (let i = 0; i < cmds.length; ) {
    const c = cmds[i++]!;
    const id = c & 7;
    const count = c >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count && i + 1 < cmds.length; k++) {
        x += zigzag(cmds[i++]!);
        y += zigzag(cmds[i++]!);
        if (id === 1) {
          if (ring.length >= 6) rings.push(Float64Array.from(ring));
          ring = [];
        }
        ring.push(x, y);
      }
    } else if (id === 7) {
      if (ring.length >= 6) rings.push(Float64Array.from(ring));
      ring = [];
    }
  }
  if (ring.length >= 6) rings.push(Float64Array.from(ring));
  return rings;
}
