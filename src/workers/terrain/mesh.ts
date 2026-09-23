/**
 * Tile mesh construction.
 *
 * Turns a heightmap — or nothing, over ocean — into a ready-to-upload vertex
 * buffer in the tile's *own local frame*, with the tile centre at the origin.
 * Local and not ECEF: a vertex 6 378 km from the origin has roughly a metre of
 * float32 precision left, which shows up as terrain that visibly jitters as
 * the camera moves. Every position here is within one tile span of zero.
 *
 * The skirt around each tile is not decoration. Neighbouring tiles at
 * different levels of detail sample the terrain at different rates, so their
 * shared edge does not agree to the last millimetre and the gap shows as a
 * hairline crack straight through to the sky. A short downward skirt fills it
 * for the cost of one extra ring of vertices.
 */

import {
  DEG2RAD,
  RAD2DEG,
  WGS84_A,
  WGS84_E2,
  tileBounds,
  tileCenterLatLon,
} from '@/core/math/geo';
import type { BuildTileRequest, BuiltTile } from '../protocol';
import { sampleHeight, type Heightmap } from './heightmap';

/**
 * Latitude at a normalised position down a Mercator tile.
 *
 * Interpolating latitude linearly across a tile is wrong — Mercator stretches
 * towards the poles — and the error shows as terrain sliding against imagery.
 * Inverting the projection per row costs one `atan(exp())` and removes it.
 */
function latAtMercatorY(yNorm: number): number {
  return (2 * Math.atan(Math.exp((0.5 - yNorm) * 2 * Math.PI)) - Math.PI / 2) * RAD2DEG;
}


export function buildTileMesh(req: BuildTileRequest, map: Heightmap | null): BuiltTile {
  const { tile, resolution, sampleRect, exaggeration } = req;
  const n = Math.max(2, resolution);
  const w = n + 1; // vertices per side

  const bounds = tileBounds(tile.z, tile.x, tile.y);
  const nTiles = 1 << tile.z;
  const yTop = tile.y / nTiles;
  const yBottom = (tile.y + 1) / nTiles;

  const gridCount = w * w;
  const skirtCount = 4 * w;
  const vertexCount = gridCount + skirtCount;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const heights = new Float32Array(gridCount);

  // Tile centre, in double precision, is the local origin for every vertex.
  // Shared with the main thread, which must place the mesh at this exact
  // point — see `tileCenterLatLon`.
  const centre = tileCenterLatLon(tile.z, tile.x, tile.y);
  const center = geodeticToEcefD(centre.lat, centre.lon, 0);

  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;
  let maxRadiusSq = 0;

  const rectW = sampleRect.x1 - sampleRect.x0;
  const rectH = sampleRect.y1 - sampleRect.y0;

  // --- grid ----------------------------------------------------------------
  for (let row = 0; row < w; row++) {
    const v = row / n;
    const yNorm = yTop + (yBottom - yTop) * v;
    const lat = latAtMercatorY(yNorm);
    const latRad = lat * DEG2RAD;
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const nu = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

    for (let col = 0; col < w; col++) {
      const u = col / n;
      const lon = bounds.west + (bounds.east - bounds.west) * u;
      const lonRad = lon * DEG2RAD;

      const h = map
        ? sampleHeight(map, sampleRect.x0 + u * rectW, sampleRect.y0 + v * rectH) * exaggeration
        : 0;

      const gi = row * w + col;
      heights[gi] = h;
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;

      // Ellipsoid surface normal, which is the true local "up".
      const nx = cosLat * Math.cos(lonRad);
      const ny = cosLat * Math.sin(lonRad);
      const nz = sinLat;

      const xy = (nu + h) * cosLat;
      const px = xy * Math.cos(lonRad) - center[0];
      const py = xy * Math.sin(lonRad) - center[1];
      const pz = (nu * (1 - WGS84_E2) + h) * sinLat - center[2];

      const p3 = gi * 3;
      positions[p3] = px;
      positions[p3 + 1] = py;
      positions[p3 + 2] = pz;

      // Seeded with the ellipsoid normal; replaced below by the real surface
      // normal wherever neighbours exist.
      normals[p3] = nx;
      normals[p3 + 1] = ny;
      normals[p3 + 2] = nz;

      uvs[gi * 2] = u;
      uvs[gi * 2 + 1] = 1 - v; // textures are bottom-up; tile rows run top-down

      const rSq = px * px + py * py + pz * pz;
      if (rSq > maxRadiusSq) maxRadiusSq = rSq;
    }
  }

  // --- normals from the surface itself -------------------------------------
  // Central differences over the position grid. Doing this here rather than
  // with Three's `computeVertexNormals` keeps the skirt vertices from dragging
  // the edge normals downwards, which would show as a dark seam on every tile.
  for (let row = 0; row < w; row++) {
    for (let col = 0; col < w; col++) {
      const gi = row * w + col;
      const left = row * w + Math.max(col - 1, 0);
      const right = row * w + Math.min(col + 1, w - 1);
      const up = Math.max(row - 1, 0) * w + col;
      const down = Math.min(row + 1, w - 1) * w + col;

      const dxx = positions[right * 3]! - positions[left * 3]!;
      const dxy = positions[right * 3 + 1]! - positions[left * 3 + 1]!;
      const dxz = positions[right * 3 + 2]! - positions[left * 3 + 2]!;

      // Rows run north -> south, so this vector points south; negate to get
      // a north-pointing tangent and keep the cross product outward.
      const dyx = positions[up * 3]! - positions[down * 3]!;
      const dyy = positions[up * 3 + 1]! - positions[down * 3 + 1]!;
      const dyz = positions[up * 3 + 2]! - positions[down * 3 + 2]!;

      let nx = dxy * dyz - dxz * dyy;
      let ny = dxz * dyx - dxx * dyz;
      let nz = dxx * dyy - dxy * dyx;

      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-9) {
        nx /= len;
        ny /= len;
        nz /= len;
        normals[gi * 3] = nx;
        normals[gi * 3 + 1] = ny;
        normals[gi * 3 + 2] = nz;
      }
    }
  }

  // --- skirts --------------------------------------------------------------
  //
  // Depth is derived from the tile's own relief, not from its width.
  //
  // A skirt only has to span the height disagreement between this tile and a
  // neighbour one LOD coarser, which is bounded by the relief the coarser tile
  // cannot represent. Scaling it to tile *width* instead — the obvious first
  // guess — makes low-zoom tiles hang kilometres below the surface, and from
  // altitude those walls are plainly visible at every tile edge, exactly the
  // artefact the skirt exists to hide.
  //
  // The caller's `skirtDepth` is a *floor*, and it is scaled to the tile —
  // see `skirtFloorFor`. The additive 30 m that used to sit on the relief term
  // undid that scaling: a flat zoom-19 tile 30 m across still got a 30 m wall
  // hanging off each edge, which is what the vertical steps at tile joins on a
  // runway were.
  const relief = Number.isFinite(maxHeight - minHeight) ? maxHeight - minHeight : 0;
  const floor = req.skirtDepth > 0 ? Math.min(req.skirtDepth, 120) : 30;
  const skirtDepth = Math.min(Math.max(relief * 0.6, floor), 2500);

  // Four rings of w vertices, each a copy of an edge vertex pushed down along
  // the ellipsoid normal. Laid out north, south, west, east.
  const skirtBase = gridCount;
  const edgeIndexFor = (edge: number, i: number): number => {
    switch (edge) {
      case 0: return i;                       // north: row 0
      case 1: return (w - 1) * w + i;         // south: row n
      case 2: return i * w;                   // west:  col 0
      default: return i * w + (w - 1);        // east:  col n
    }
  };

  for (let edge = 0; edge < 4; edge++) {
    for (let i = 0; i < w; i++) {
      const src = edgeIndexFor(edge, i);
      const dst = skirtBase + edge * w + i;

      const sx = positions[src * 3]!;
      const sy = positions[src * 3 + 1]!;
      const sz = positions[src * 3 + 2]!;

      // Direction towards the Earth's centre, in tile-local coordinates.
      const gx = sx + center[0];
      const gy = sy + center[1];
      const gz = sz + center[2];
      const glen = Math.hypot(gx, gy, gz) || 1;

      positions[dst * 3] = sx - (gx / glen) * skirtDepth;
      positions[dst * 3 + 1] = sy - (gy / glen) * skirtDepth;
      positions[dst * 3 + 2] = sz - (gz / glen) * skirtDepth;

      // Share the edge's normal so the skirt shades like the surface it
      // continues, making it invisible when it is doing its job.
      normals[dst * 3] = normals[src * 3]!;
      normals[dst * 3 + 1] = normals[src * 3 + 1]!;
      normals[dst * 3 + 2] = normals[src * 3 + 2]!;

      uvs[dst * 2] = uvs[src * 2]!;
      uvs[dst * 2 + 1] = uvs[src * 2 + 1]!;
    }
  }

  // --- indices -------------------------------------------------------------
  const gridTriangles = n * n * 2;
  const skirtTriangles = 4 * n * 2;
  const indices = new Uint32Array((gridTriangles + skirtTriangles) * 3);
  let k = 0;

  /**
   * One quad, in the grid's convention: `a` north-west, `b` north-east,
   * `c` south-west, `d` south-east. Wound counter-clockwise seen from space.
   */
  const quad = (a: number, b: number, c: number, d: number): void => {
    indices[k++] = a; indices[k++] = c; indices[k++] = d;
    indices[k++] = a; indices[k++] = d; indices[k++] = b;
  };

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const a = row * w + col;
      quad(a, a + 1, a + w, a + w + 1);
    }
  }

  // Each skirt ring is treated as the row or column just outside the edge, so
  // the same `quad` call produces the correct outward winding.
  const northSkirt = (i: number): number => skirtBase + 0 * w + i;
  const southSkirt = (i: number): number => skirtBase + 1 * w + i;
  const westSkirt = (i: number): number => skirtBase + 2 * w + i;
  const eastSkirt = (i: number): number => skirtBase + 3 * w + i;

  for (let col = 0; col < n; col++) {
    // North: the skirt is the row north of row 0.
    quad(northSkirt(col), northSkirt(col + 1), col, col + 1);
    // South: the skirt is the row south of row n.
    const s = (w - 1) * w + col;
    quad(s, s + 1, southSkirt(col), southSkirt(col + 1));
  }

  for (let row = 0; row < n; row++) {
    // West: the skirt is the column west of column 0.
    quad(westSkirt(row), row * w, westSkirt(row + 1), (row + 1) * w);
    // East: the skirt is the column east of column n.
    const e = row * w + (w - 1);
    quad(e, eastSkirt(row), e + w, eastSkirt(row + 1));
  }

  // The bounding sphere must enclose the skirts too, or tiles pop out at the
  // edge of the frustum.
  const boundingRadius = Math.sqrt(maxRadiusSq) + skirtDepth;

  return {
    type: 'built',
    id: req.id,
    tile,
    positions,
    normals,
    uvs,
    indices,
    heights,
    gridWidth: w,
    centerEcef: center,
    boundingRadius,
    minHeight: Number.isFinite(minHeight) ? minHeight : 0,
    maxHeight: Number.isFinite(maxHeight) ? maxHeight : 0,
  };
}

/** Double-precision geodetic -> ECEF, local to this worker. */
function geodeticToEcefD(latDeg: number, lonDeg: number, h: number): [number, number, number] {
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const nu = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const xy = (nu + h) * cosLat;
  return [xy * Math.cos(lon), xy * Math.sin(lon), (nu * (1 - WGS84_E2) + h) * sinLat];
}
