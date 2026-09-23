/**
 * Exact PNG decoding, because the canvas is not exact.
 *
 * ## Why this file exists
 *
 * Terrarium packs elevation into RGB: `height_m = R*256 + G + B/256 - 32768`.
 * The red channel is therefore worth **256 metres per unit**, which makes the
 * usual way of reading a PNG in a browser — `createImageBitmap`, `drawImage`,
 * `getImageData` — unusable here. That path is not byte-exact: Chrome's
 * compositor rounds through its own colour pipeline and comes back with
 * individual channels off by one.
 *
 * Measured on a single Terrarium tile over the South Downs (z14/8162/5492),
 * decoded both ways and compared texel by texel:
 *
 *  - **246 of 65 536 texels differed** between the canvas and the file.
 *  - Most were the blue channel by one, which is four millimetres and
 *    invisible.
 *  - **64 were the red channel by one**, every single one reading `R=129`
 *    where the file says `R=128` — exactly **+256 m** of terrain each.
 *
 * Sixty-four isolated vertices standing 256 m above their neighbours is
 * precisely what the ground looked like: a field of tall thin spikes, worst
 * from a low viewpoint where they stand against the sky. The same file parsed
 * from its own bytes contains **zero** such spikes. The data was never wrong;
 * the decoder was.
 *
 * ## Scope
 *
 * This handles what Terrarium actually serves — 8-bit, non-interlaced, truecolour
 * with or without alpha — and reports failure for anything else so the caller
 * can fall back. It is not a general PNG library and does not try to be.
 */

/** A decoded image, 8 bits per channel, in the file's own byte order. */
export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  /** 3 for RGB, 4 for RGBA. */
  channels: 3 | 4;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Decode a PNG to its exact stored samples, or return null.
 *
 * Null means "this file is outside the fast path" — interlaced, 16-bit,
 * palettised or greyscale — and the caller should use the canvas instead. For
 * elevation that never happens in practice; the fallback exists so an odd
 * provider cannot blank the terrain.
 */
export async function decodePng(bytes: ArrayBuffer): Promise<RawImage | null> {
  const buf = new Uint8Array(bytes);
  if (buf.length < 8) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== SIGNATURE[i]) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];

  while (offset + 8 <= buf.length) {
    const length = view.getUint32(offset);
    const type =
      String.fromCharCode(buf[offset + 4]!, buf[offset + 5]!, buf[offset + 6]!, buf[offset + 7]!);
    const start = offset + 8;
    if (start + length > buf.length) return null;

    if (type === 'IHDR') {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      bitDepth = buf[start + 8]!;
      colourType = buf[start + 9]!;
      interlace = buf[start + 12]!;
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }

    offset = start + length + 4; // + CRC
  }

  // Truecolour, eight bits, no Adam7. Everything Terrarium and every imagery
  // provider in this project actually serves.
  if (bitDepth !== 8 || interlace !== 0) return null;
  if (colourType !== 2 && colourType !== 6) return null;
  if (width <= 0 || height <= 0 || idat.length === 0) return null;

  const channels: 3 | 4 = colourType === 2 ? 3 : 4;

  let total = 0;
  for (const chunk of idat) total += chunk.length;
  const deflated = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of idat) {
    deflated.set(chunk, cursor);
    cursor += chunk.length;
  }

  // IDAT is zlib-wrapped, which is what 'deflate' means in the Streams API —
  // 'deflate-raw' would be the headerless variant and fails here.
  let inflated: Uint8Array;
  try {
    const stream = new Blob([deflated as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }

  const stride = width * channels;
  if (inflated.length < height * (stride + 1)) return null;

  const out = new Uint8Array(height * stride);
  unfilter(inflated, out, width, height, channels);

  return { data: out, width, height, channels };
}

/**
 * Reverse the per-scanline PNG filters, in place into `out`.
 *
 * Each row is prefixed by one filter byte and is predicted from the pixel to
 * its left (`a`), the one above (`b`) and the one above-left (`c`). Written as
 * one loop with the filter switched inside rather than five specialised loops:
 * a tile is 196 kB and this runs in well under a millisecond, which is not
 * where the frame budget goes.
 */
function unfilter(
  src: Uint8Array,
  out: Uint8Array,
  width: number,
  height: number,
  channels: number,
): void {
  const stride = width * channels;
  let pos = 0;

  for (let y = 0; y < height; y++) {
    const filter = src[pos++]!;
    const row = y * stride;
    const prev = row - stride;

    for (let i = 0; i < stride; i++) {
      const raw = src[pos + i]!;
      const a = i >= channels ? out[row + i - channels]! : 0;
      const b = y > 0 ? out[prev + i]! : 0;
      const c = i >= channels && y > 0 ? out[prev + i - channels]! : 0;

      let value: number;
      switch (filter) {
        case 0: value = raw; break;
        case 1: value = raw + a; break;
        case 2: value = raw + b; break;
        case 3: value = raw + ((a + b) >> 1); break;
        case 4: {
          // Paeth: pick whichever of the three neighbours the linear
          // predictor a+b-c lands closest to.
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: value = raw; break;
      }
      out[row + i] = value & 0xff;
    }
    pos += stride;
  }
}
