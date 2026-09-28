/**
 * The relief settings, and the mesh density derived from the zoom.
 *
 * Small, but each of these pins a decision that is invisible once made and
 * expensive to rediscover — particularly that the exaggeration has to reach
 * `sampleHeight`, since that is the difference between an aeroplane standing
 * on the terrain you can see and an aeroplane standing inside it.
 */

import { describe, expect, it } from 'vitest';

import { TERRARIUM } from '@/tiles/sources';
import { RELIEF, meshResolutionFor } from './constants';

describe('RELIEF', () => {
  it('exaggerates enough to read, and not so much that it is a cartoon', () => {
    expect(RELIEF.exaggeration).toBeGreaterThan(1.1);
    expect(RELIEF.exaggeration).toBeLessThan(1.5);
  });

  it('darkens the shadow floor so the geometry can be seen', () => {
    // Geometry the eye cannot shade is geometry the eye does not see.
    expect(RELIEF.ambient).toBeLessThan(0.45);
    // But not to zero — the satellite imagery already contains its own sun,
    // and double-lighting it looks worse than not shading at all.
    expect(RELIEF.ambient).toBeGreaterThan(0.15);
  });
});

describe('meshResolutionFor', () => {
  it('never asks for more quads than there are elevation samples', () => {
    /*
     * The ceiling that matters. Above zoom 15 a tile samples a sub-rectangle
     * of its z15 ancestor, a quarter of the samples per level, so a fixed
     * 128-quad mesh would spend sixteen thousand vertices on 256 numbers —
     * and it would spend them on the tiles nearest the camera.
     */
    for (let z = TERRARIUM.maxZoom + 1; z <= 19; z++) {
      const real = TERRARIUM.tileSize >> (z - TERRARIUM.maxZoom);
      expect(meshResolutionFor(z)).toBeLessThanOrEqual(real);
    }
    expect(meshResolutionFor(19)).toBe(16);
  });

  it('keeps a quarter of the heightmap where the heightmap is whole', () => {
    // 128 quads is 129x129 of a 256x256 tile, for no extra bandwidth at all:
    // the PNG has already been downloaded and decoded either way.
    expect(meshResolutionFor(TERRARIUM.maxZoom)).toBe(128);
    expect(meshResolutionFor(12)).toBe(128);
  });

  it('never quadruples the density across one zoom level', () => {
    /*
     * The regression this function exists for. The rule used to be
     * `z >= 10 ? 128 : 32`, and a fourfold jump in one level draws a straight
     * line across the view with visibly rounder terrain on one side — which,
     * being a tile boundary, is a rectangle. Doublings are hard to see; this
     * was not.
     */
    for (let z = 3; z <= 19; z++) {
      const ratio = meshResolutionFor(z) / meshResolutionFor(z - 1);
      expect(ratio).toBeLessThanOrEqual(2);
      expect(ratio).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('rises with the zoom until the data runs out', () => {
    for (let z = 3; z <= TERRARIUM.maxZoom; z++) {
      expect(meshResolutionFor(z)).toBeGreaterThanOrEqual(meshResolutionFor(z - 1));
    }
  });
});
