/**
 * Worker message protocol.
 *
 * Every large payload crossing the boundary is a `Transferable` ArrayBuffer, so
 * geometry moves by pointer rather than being structurally cloned. A 64x64
 * tile is ~150 KB of vertex data; cloning that for every tile at 60 fps would
 * cost more than building it did.
 */

import type { TileCoord } from '@/core/math/geo';

/** Ask the worker to decode a Terrarium PNG and build a terrain tile. */
export interface BuildTileRequest {
  type: 'build';
  /** Correlates the reply; the pool does not assume ordered responses. */
  id: number;
  tile: TileCoord;
  /**
   * Encoded Terrarium PNG bytes, or null to build a smooth ellipsoid patch.
   * Null is the deliberate case for ocean and for zooms past elevation
   * coverage, not an error path.
   */
  bytes: ArrayBuffer | null;
  /** Quads per side. 32 is plenty far away; 64 near the camera. */
  resolution: number;
  /**
   * Sub-rectangle of the heightmap to sample, in normalised [0,1] tile space.
   * Used past zoom 15, where a tile inherits elevation from its z15 ancestor.
   */
  sampleRect: { x0: number; y0: number; x1: number; y1: number };
  /** Vertical exaggeration. 1 is true scale. */
  exaggeration: number;
  /**
   * Lower bound for skirt depth, metres. The worker derives the real depth
   * from the tile's measured relief and treats this only as a floor, capped
   * so a wide low-zoom tile cannot grow kilometre-high walls.
   */
  skirtDepth: number;
}

export interface BuiltTile {
  type: 'built';
  id: number;
  tile: TileCoord;
  /** Vertex positions in metres, relative to `centerEcef`. */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Per-grid-vertex heights, for terrain queries on the main thread. */
  heights: Float32Array;
  /** Grid side length in vertices (`resolution + 1`). */
  gridWidth: number;
  /** Tile centre in ECEF, double precision — the tile's local origin. */
  centerEcef: [number, number, number];
  /** Bounding sphere radius about `centerEcef`, metres. */
  boundingRadius: number;
  minHeight: number;
  maxHeight: number;
}

interface BuildTileError {
  type: 'error';
  id: number;
  message: string;
}

export type WorkerResponse = BuiltTile | BuildTileError;

/** Buffers to transfer with a built-tile reply. */
export function builtTileTransferables(t: BuiltTile): Transferable[] {
  return [
    t.positions.buffer,
    t.normals.buffer,
    t.uvs.buffer,
    t.indices.buffer,
    t.heights.buffer,
  ];
}
