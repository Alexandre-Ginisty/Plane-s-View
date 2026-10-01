/**
 * The building footprints out of a Mapbox Vector Tile.
 *
 * A vector tile is a protocol buffer: layers of features, each a list of
 * drawing commands in tile units (0..extent, y down) and a list of tags
 * pointing into the layer's key and value tables. Only what the buildings
 * need is read — the `building` layer's polygons and four of its tags — and
 * every other layer is skipped over without being decoded, which is most of
 * the bytes in a city tile (roads, labels, land use).
 *
 * Written out rather than taken from a library: the format is small and
 * stable (spec 2.1), the decoder is a hundred lines, and it runs in a worker
 * where pulling in MapLibre's internals would mean shipping its whole
 * parser a second time.
 */

/** One building part: its rings in tile units, and how tall it stands. */
export interface Footprint {
  /** Outer ring then holes, each closed implicitly, as flat x,y pairs. */
  rings: Float64Array[];
  /** Top of the part above the ground, metres. */
  height: number;
  /** Bottom of the part above the ground, metres (a podium, a bridge deck). */
  minHeight: number;
  /** OSM `building:colour`, when mapped. */
  colour: string | null;
}

export interface BuildingLayer {
  extent: number;
  footprints: Footprint[];
}

/** Minimal protocol-buffer cursor: varints, lengths, skips. */
class Pbf {
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

type Value = string | number | boolean | null;

function readValue(p: Pbf): Value {
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

const zigzag = (n: number): number => (n >>> 1) ^ -(n & 1);

/** A polygon feature's geometry commands, as rings. */
function decodeRings(cmds: number[]): Float64Array[] {
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

/** Shoelace in tile units; MVT outer rings are positive (clockwise, y down). */
export function ringArea(r: Float64Array): number {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += (r[j]! - r[i]!) * (r[i + 1]! + r[j + 1]!);
  return a / 2;
}

function readBuildingLayer(layer: Pbf): BuildingLayer | null {
  let name = '';
  let extent = 4096;
  const keys: string[] = [];
  const values: Value[] = [];
  const features: Pbf[] = [];
  while (!layer.end) {
    const tag = layer.varint();
    const field = tag >> 3;
    if (field === 1) {
      name = layer.string();
      // The name comes first in every encoder in use; stop early otherwise.
      if (name !== 'building') return null;
    } else if (field === 2) features.push(layer.message());
    else if (field === 3) keys.push(layer.string());
    else if (field === 4) values.push(readValue(layer.message()));
    else if (field === 5) extent = layer.varint();
    else layer.skip(tag & 7);
  }
  if (name !== 'building') return null;

  const footprints: Footprint[] = [];
  for (const f of features) {
    let type = 0;
    let tags: number[] = [];
    let geometry: number[] = [];
    while (!f.end) {
      const tag = f.varint();
      const field = tag >> 3;
      if (field === 2) tags = f.packed();
      else if (field === 3) type = f.varint();
      else if (field === 4) geometry = f.packed();
      else f.skip(tag & 7);
    }
    if (type !== 3) continue;

    let height = Number.NaN;
    let minHeight = 0;
    let colour: string | null = null;
    let hide = false;
    for (let i = 0; i + 1 < tags.length; i += 2) {
      const key = keys[tags[i]!];
      const value = values[tags[i + 1]!];
      if (key === 'render_height' && typeof value === 'number') height = value;
      else if (key === 'render_min_height' && typeof value === 'number') minHeight = value;
      else if (key === 'colour' && typeof value === 'string') colour = value;
      else if (key === 'hide_3d' && value === true) hide = true;
    }
    if (hide) continue;

    // A multipolygon is several outer rings, each followed by its holes.
    let current: Float64Array[] | null = null;
    const push = (): void => {
      if (current) footprints.push({ rings: current, height, minHeight, colour });
    };
    for (const ring of decodeRings(geometry)) {
      if (ringArea(ring) > 0) {
        push();
        current = [ring];
      } else if (current) {
        current.push(ring);
      }
    }
    push();
  }
  return { extent, footprints };
}

/** The `building` layer of a tile, or an empty one if it has none. */
export function readBuildings(bytes: Uint8Array): BuildingLayer {
  const tile = new Pbf(bytes);
  while (!tile.end) {
    const tag = tile.varint();
    if (tag >> 3 === 3 && (tag & 7) === 2) {
      const layer = readBuildingLayer(tile.message());
      if (layer) return layer;
    } else {
      tile.skip(tag & 7);
    }
  }
  return { extent: 4096, footprints: [] };
}
