/**
 * Decoding a Terrarium tile, and sampling it.
 *
 * Terrarium encodes elevation in RGB: `height_m = (R*256 + G + B/256) - 32768`.
 * The sentinel for "no data" decodes to exactly -32768 m, which left raw
 * punches a 32 km pit through the globe — so it is caught here, once, rather
 * than at every use downstream.
 *
 * `sampleHeight` interpolates in *normalised tile space*, which is what lets a
 * tile deeper than zoom 15 reuse its z15 ancestor's heightmap by sampling the
 * sub-rectangle it occupies. Without that the terrain would flatten abruptly
 * at the z15 boundary — from a cockpit, a visible step in the ground a few
 * kilometres ahead.
 */

import { TERRARIUM_NODATA, decodeTerrarium } from '@/tiles/sources';

/** Reused across builds; allocating a canvas per tile is measurable. */
let scratchCanvas: OffscreenCanvas | null = null;
let scratchCtx: OffscreenCanvasRenderingContext2D | null = null;

export interface Heightmap {
  data: Float32Array;
  width: number;
  height: number;
}

export async function decodeHeightmap(bytes: ArrayBuffer): Promise<Heightmap> {
  const bitmap = await createImageBitmap(new Blob([bytes]));
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
    const h = decodeTerrarium(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!);
    // The no-data sentinel decodes to -32768 m; left raw it punches a 32 km
    // hole through the globe. Sea level is the right reading for it.
    out[i] = h <= TERRARIUM_NODATA + 1 ? 0 : h;
  }

  return { data: out, width, height };
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
