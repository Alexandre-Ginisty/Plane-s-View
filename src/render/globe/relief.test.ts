/**
 * The relief settings.
 *
 * Small, but each of these pins a decision that is invisible once made and
 * expensive to rediscover — particularly that the exaggeration has to reach
 * `sampleHeight`, since that is the difference between an aeroplane standing
 * on the terrain you can see and an aeroplane standing inside it.
 */

import { describe, expect, it } from 'vitest';

import { RELIEF } from './constants';

describe('RELIEF', () => {
  it('leaves the standard setting at true scale', () => {
    // The default must stay honest: the app reports real altitudes, and a
    // silently stretched world would make every one of them look wrong.
    expect(RELIEF.standard.exaggeration).toBe(1);
  });

  it('keeps more of the elevation tile in the boosted mesh', () => {
    /*
     * A Terrarium tile is 256x256 samples. At 64 quads a side the mesh keeps
     * 65x65 of them — six percent of an elevation map that has already been
     * downloaded and decoded. This is the cheapest detail in the whole
     * renderer and the reason the setting is worth having at all.
     */
    expect(RELIEF.boosted.nearResolution).toBeGreaterThanOrEqual(
      RELIEF.standard.nearResolution * 2,
    );
    expect(RELIEF.boosted.baseResolution).toBeGreaterThan(RELIEF.standard.baseResolution);
    // And not past the source: more quads than samples is interpolation sold
    // as detail.
    expect(RELIEF.boosted.nearResolution).toBeLessThanOrEqual(256);
  });

  it('darkens the shadow floor so the extra geometry can be seen', () => {
    // Geometry the eye cannot shade is geometry the eye does not see: without
    // this the boosted mesh is more triangles and no more relief.
    expect(RELIEF.boosted.ambient).toBeLessThan(RELIEF.standard.ambient);
    // But not to zero — the satellite imagery already contains its own sun,
    // and double-lighting it looks worse than not shading at all.
    expect(RELIEF.boosted.ambient).toBeGreaterThan(0.15);
  });

  it('exaggerates enough to read, and not so much that it is a cartoon', () => {
    expect(RELIEF.boosted.exaggeration).toBeGreaterThan(1.2);
    expect(RELIEF.boosted.exaggeration).toBeLessThan(2);
  });
});
