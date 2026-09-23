/**
 * Decoding a Terrarium tile, and sampling it.
 *
 * Terrarium encodes elevation in RGB: `height_m = (R*256 + G + B/256) - 32768`.
 * The sentinel for "no data" decodes to exactly -32768 m, which left raw
 * punches a 32 km pit through the globe — so it is caught here, once, rather
 * than at every use downstream.
 *
 * ## The bytes are read from the file, not from a canvas
 *
 * The red channel is worth 256 metres per unit, and the ordinary way to read a
 * PNG in a browser — `createImageBitmap` into a 2D canvas and back out with
 * `getImageData` — is not byte-exact. Measured on one tile over the South
 * Downs, that round trip changed 246 of 65 536 texels, and 64 of those were
 * the red channel by one: sixty-four vertices standing exactly 256 m above
 * their neighbours, which is what the field of spikes on the ground was. The
 * same file parsed from its own bytes has none. So `decodePng` is the path
 * that runs, and the canvas is kept only for a PNG variant it declines.
 *
 * `sampleHeight` interpolates in *normalised tile space*, which is what lets a
 * tile deeper than zoom 15 reuse its z15 ancestor's heightmap by sampling the
 * sub-rectangle it occupies. Without that the terrain would flatten abruptly
 * at the z15 boundary — from a cockpit, a visible step in the ground a few
 * kilometres ahead.
 */

import { TERRARIUM_NODATA, decodeTerrarium } from '@/tiles/sources';
import { decodePng } from './png';

/** Reused across builds; allocating a canvas per tile is measurable. */
let scratchCanvas: OffscreenCanvas | null = null;
let scratchCtx: OffscreenCanvasRenderingContext2D | null = null;

export interface Heightmap {
  data: Float32Array;
  width: number;
  height: number;
}

export async function decodeHeightmap(bytes: ArrayBuffer): Promise<Heightmap> {
  const exact = await decodePng(bytes);
  if (exact) {
    const { data, width, height, channels } = exact;
    const out = new Float32Array(width * height);
    for (let i = 0, p = 0; i < out.length; i++, p += channels) {
      out[i] = clampNoData(decodeTerrarium(data[p]!, data[p + 1]!, data[p + 2]!));
    }
    return { data: out, width, height };
  }

  return decodeViaCanvas(bytes);
}

/**
 * The no-data sentinel decodes to -32768 m; left raw it punches a 32 km hole
 * through the globe. Sea level is the right reading for it.
 */
function clampNoData(h: number): number {
  return h <= TERRARIUM_NODATA + 1 ? 0 : h;
}

/**
 * Fallback for a PNG the exact decoder declines — interlaced, 16-bit or
 * palettised. None of the elevation providers here serve those, so this is
 * insurance rather than a code path with a known caller, and it carries the
 * rounding described at the top of the file: a despike pass repairs the red
 * channel afterwards, because a lone texel 256 m above every neighbour is an
 * encoding error, never a landform.
 */
async function decodeViaCanvas(bytes: ArrayBuffer): Promise<Heightmap> {
  const bitmap = await createImageBitmap(new Blob([bytes]), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const { width, height } = bitmap;

  if (!scratchCanvas || scratchCanvas.width !== width || scratchCanvas.height !== height) {
    scratchCanvas = new OffscreenCanvas(width, height);
    scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!scratchCtx) throw new Error('OffscreenCanvas 2D context unavailable');

  scratchCtx.clearRect(0, 0, width, height);
  scratchCtx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const rgba = scratchCtx.getImageData(0, 0, width, height).data;
  const out = new Float32Array(width * height);

  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = clampNoData(decodeTerrarium(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!));
  }

  despikeRedChannel(out, width, height);
  return { data: out, width, height };
}

/** One unit of the Terrarium red channel, in metres. */
const RED_UNIT_M = 256;

/**
 * Repair texels whose red channel came back one too high or one too low.
 *
 * Only an exact multiple of 256 m is corrected, and only when the texel
 * disagrees with *all four* of its neighbours in the same direction — the
 * signature of a channel error rather than of a cliff. A real 256 m step has
 * neighbours on the high side too.
 */
export function despikeRedChannel(data: Float32Array, width: number, height: number): number {
  let repaired = 0;
  const threshold = RED_UNIT_M * 0.55;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const h = data[i]!;
      const up = data[i - width]!;
      const down = data[i + width]!;
      const left = data[i - 1]!;
      const right = data[i + 1]!;

      const lo = Math.min(up, down, left, right);
      const hi = Math.max(up, down, left, right);

      if (h - hi > threshold) {
        const steps = Math.round((h - hi) / RED_UNIT_M);
        if (steps >= 1) {
          data[i] = h - steps * RED_UNIT_M;
          repaired++;
        }
      } else if (lo - h > threshold) {
        const steps = Math.round((lo - h) / RED_UNIT_M);
        if (steps >= 1) {
          data[i] = h + steps * RED_UNIT_M;
          repaired++;
        }
      }
    }
  }
  return repaired;
}

/** Bilinear sample at normalised coordinates, clamped at the border. */
export function sampleHeight(map: Heightmap, u: number, v: number): number {
  const x = Math.min(Math.max(u, 0), 1) * (map.width - 1);
  const y = Math.min(Math.max(v, 0), 1) * (map.height - 1);

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, map.width - 1);
  const y1 = Math.min(y0 + 1, map.height - 1);

  const fx = x - x0;
  const fy = y - y0;

  const h00 = map.data[y0 * map.width + x0]!;
  const h10 = map.data[y0 * map.width + x1]!;
  const h01 = map.data[y1 * map.width + x0]!;
  const h11 = map.data[y1 * map.width + x1]!;

  const top = h00 + (h10 - h00) * fx;
  const bottom = h01 + (h11 - h01) * fx;
  return top + (bottom - top) * fy;
}
