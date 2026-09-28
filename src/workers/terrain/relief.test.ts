/**
 * What the relief setting actually buys, measured on a real mesh.
 *
 * The constants test next door says what the numbers are; this says what the
 * mesh does with them. The expensive half of the setting is not the
 * exaggeration — it is the vertex count, and a density that quadruples the
 * work per tile has to be looked at rather than assumed.
 */

import { describe, expect, it } from 'vitest';

import { RELIEF, meshResolutionFor } from '@/render/globe/constants';
import type { BuildTileRequest } from '../protocol';
import { buildTileMesh } from './mesh';
import type { Heightmap } from './heightmap';

/** A 256x256 heightmap with a ridge in it, the size a Terrarium tile really is. */
function alps(): Heightmap {
  const width = 256;
  const height = 256;
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      // A broad ridge plus fine texture, so under-sampling is visible as lost
      // detail rather than just as a smoother curve.
      data[y * width + x] =
        1800 * Math.exp(-(((v - 0.5) * 4) ** 2)) +
        220 * Math.sin(u * 40) * Math.cos(v * 37);
    }
  }
  return { data, width, height };
}

function request(resolution: number, exaggeration: number): BuildTileRequest {
  return {
    tile: { z: 12, x: 2130, y: 1440 },
    bytes: null,
    resolution,
    sampleRect: { x0: 0, y0: 0, x1: 1, y1: 1 },
    exaggeration,
    skirtDepth: 40,
  } as BuildTileRequest;
}

/** Peak-to-trough of the built heights, metres. */
function relief(heights: Float32Array): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of heights) {
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  return hi - lo;
}

describe('the terrain mesh', () => {
  const map = alps();
  const near = meshResolutionFor(12);
  const built = buildTileMesh(request(near, RELIEF.exaggeration), map);
  const flat = buildTileMesh(request(near, 1), map);

  it('keeps detail a 64-quad mesh drops', () => {
    /*
     * The honest half of the setting. Both meshes are built from the same
     * downloaded heightmap; a 64-quad mesh samples 65 of its 256 rows and the
     * one this app builds near the ground samples 129, so the fine structure
     * on the ridge survives in one and is aliased away in the other.
     *
     * Compared as relief *per unit of exaggeration*, or this would just be
     * measuring the stretch.
     */
    const coarse = buildTileMesh(request(64, 1), map);
    expect(relief(built.heights) / RELIEF.exaggeration).toBeGreaterThan(relief(coarse.heights));
  });

  it('stretches the terrain by the stated factor and no more', () => {
    expect(relief(built.heights) / relief(flat.heights)).toBeCloseTo(RELIEF.exaggeration, 3);
  });

  it('bakes the exaggeration into the heights the rest of the app reads', () => {
    /*
     * The safety property, and the reason exaggerating in the shader would
     * have been wrong. `heights` is what `sampleHeight` serves to everything
     * that has to agree with the picture: where an aircraft stands when it is
     * on the ground, how far the camera is lifted to clear a hillside, when
     * the undercarriage comes down. If the stretch lived only in the vertex
     * positions, all three would be measured against an invisible true-scale
     * surface and aeroplanes would sink into the hills.
     */
    let peakBuilt = -Infinity;
    let peakFlat = -Infinity;
    for (const h of built.heights) peakBuilt = Math.max(peakBuilt, h);
    for (const h of flat.heights) peakFlat = Math.max(peakFlat, h);
    expect(peakBuilt / peakFlat).toBeCloseTo(RELIEF.exaggeration, 2);
  });

  it('costs about four times the vertices of a 64-quad mesh, and not more', () => {
    // The price. Stated here so that raising the density again is a decision
    // taken with the number in front of you rather than a nudge.
    const coarse = buildTileMesh(request(64, 1), map);
    const ratio = built.positions.length / coarse.positions.length;
    expect(ratio).toBeGreaterThan(3.5);
    expect(ratio).toBeLessThan(4.3);
  });
});
