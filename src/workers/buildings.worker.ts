/**
 * Building worker: fetch a vector tile, read its buildings, extrude them.
 *
 * All of it off the main thread — a dense city tile is a megabyte of
 * protocol buffer and a few hundred thousand vertices — and the result is
 * handed back as transferable typed arrays, so nothing is copied twice.
 */

import { extrudeBuildings, type BuiltBuildings } from './buildings/extrude';
import { readBuildings } from './buildings/mvt';

export interface BuildingRequest {
  id: number;
  url: string;
  z: number;
  x: number;
  y: number;
  /** Skip parts lower than this, metres (the far ring keeps the skyline). */
  minHeight: number;
}

export type BuildingResponse =
  | { id: number; ok: true; built: BuiltBuildings }
  | { id: number; ok: false; status: number };

/** Hosts this worker may fetch from: the tile URL is built by the app, but checked here too. */
const ALLOWED = new Set(['tiles.openfreemap.org']);

async function bytesOf(res: Response): Promise<Uint8Array> {
  const raw = new Uint8Array(await res.arrayBuffer());
  // Served gzipped without a Content-Encoding by some mirrors: inflate here.
  if (raw[0] === 0x1f && raw[1] === 0x8b && typeof DecompressionStream === 'function') {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return raw;
}

self.onmessage = async (event: MessageEvent<BuildingRequest>) => {
  const { id, url, z, x, y, minHeight } = event.data;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !ALLOWED.has(parsed.hostname)) throw new Error('host');
    const res = await fetch(parsed, { cache: 'force-cache', credentials: 'omit' });
    if (!res.ok) {
      (self as unknown as Worker).postMessage({ id, ok: false, status: res.status } satisfies BuildingResponse);
      return;
    }
    const layer = readBuildings(await bytesOf(res));
    const built = extrudeBuildings(layer.footprints, layer.extent, z, x, y, minHeight);
    (self as unknown as Worker).postMessage({ id, ok: true, built } satisfies BuildingResponse, [
      built.positions.buffer,
      built.normals.buffer,
      built.facade.buffer,
      built.colors.buffer,
      built.indices.buffer,
      built.ranges.buffer,
      built.anchors.buffer,
    ]);
  } catch {
    (self as unknown as Worker).postMessage({ id, ok: false, status: 0 } satisfies BuildingResponse);
  }
};
