/**
 * Aerial perspective, at the four distances that matter.
 *
 * The fragment shader is a transcription of `opticalDepth` and cannot be run
 * from a test, so this is the only place the haze is pinned. Each case is a
 * real viewpoint from the app rather than an abstract distance, because the
 * quantity being defended is "does the view look right from there" and the
 * previous value failed exactly by being plausible in the abstract.
 */

import { describe, expect, it } from 'vitest';

import {
  CLEAR_DAY_DENSITY,
  NIGHT_DENSITY,
  aerialOpacity,
  fogDensityFor,
  opticalDepth,
} from './atmosphere';

/** The value that shipped before, for the comparisons below. */
const OLD_DAY_DENSITY = 1.1e-6;

const CRUISE_M = 10_700; // FL350
const HORIZON_FROM_CRUISE_M = 370_000;

describe('aerialOpacity', () => {
  it('leaves the runway in front of you crisp', () => {
    // Taxiing. A kilometre of air at sea level is visibly clear, and this is
    // the view the whole near-ground effort was for — hazing it would undo it.
    expect(aerialOpacity(CLEAR_DAY_DENSITY, 1_000, 2, 2)).toBeLessThan(0.03);
  });

  it('hazes the far side of a large airfield, gently', () => {
    // Five kilometres reads as slightly soft, not grey.
    const haze = aerialOpacity(CLEAR_DAY_DENSITY, 5_000, 2, 2);
    expect(haze).toBeGreaterThan(0.04);
    expect(haze).toBeLessThan(0.2);
  });

  it('puts only a light veil on the ground directly below at cruise', () => {
    // Straight down from FL350: eleven kilometres of path, but most of it is
    // thin air. A constant-density fog gets this badly wrong, which is why the
    // density has to follow the altitude.
    const haze = aerialOpacity(CLEAR_DAY_DENSITY, CRUISE_M, CRUISE_M, 0);
    expect(haze).toBeGreaterThan(0.04);
    expect(haze).toBeLessThan(0.2);
  });

  it('dissolves the horizon into the sky', () => {
    // The whole point. The imagery dataset changes with zoom level, so the far
    // field is a different colour from the ground under the aircraft; it has
    // to be gone before the eye can compare them.
    expect(
      aerialOpacity(CLEAR_DAY_DENSITY, HORIZON_FROM_CRUISE_M, CRUISE_M, 0),
    ).toBeGreaterThan(0.9);
  });

  it('is what the old density could not do', () => {
    // The regression this replaces: 20% at the horizon is a tint, not
    // atmosphere, and the colour ring stayed perfectly legible under it.
    const before = aerialOpacity(OLD_DAY_DENSITY, HORIZON_FROM_CRUISE_M, CRUISE_M, 0);
    const after = aerialOpacity(CLEAR_DAY_DENSITY, HORIZON_FROM_CRUISE_M, CRUISE_M, 0);

    expect(before).toBeLessThan(0.25);
    expect(after).toBeGreaterThan(before * 4);
  });

  it('never gets thicker further up', () => {
    // Density must fall with altitude, or a climb makes the world foggier.
    let previous = Infinity;
    for (const alt of [0, 2_000, 6_000, 12_000, 20_000]) {
      const haze = aerialOpacity(CLEAR_DAY_DENSITY, 50_000, alt, alt);
      expect(haze).toBeLessThan(previous);
      previous = haze;
    }
  });
});

describe('opticalDepth', () => {
  it('is symmetric: looking down equals looking up', () => {
    const down = opticalDepth(CLEAR_DAY_DENSITY, 12_000, 12_000, 0);
    const up = opticalDepth(CLEAR_DAY_DENSITY, 12_000, 0, 12_000);
    expect(down).toBeCloseTo(up, 9);
  });

  it('joins smoothly onto the horizontal case', () => {
    // The closed form divides by the altitude difference, so it needs a
    // separate branch near zero. A discontinuity there would show as a seam
    // across any near-level view — which is most of a cockpit.
    const level = opticalDepth(CLEAR_DAY_DENSITY, 100_000, 3_000, 3_000);
    const almost = opticalDepth(CLEAR_DAY_DENSITY, 100_000, 3_000, 3_002);
    expect(almost).toBeCloseTo(level, 3);
  });

  it('treats below-sea-level ground as sea level, not as denser air', () => {
    // Heightmap artefacts and the Dead Sea both produce negative altitudes.
    // Feeding them to exp(-h/H) makes the air exponentially thicker.
    const below = opticalDepth(CLEAR_DAY_DENSITY, 10_000, 0, -400);
    const at = opticalDepth(CLEAR_DAY_DENSITY, 10_000, 0, 0);
    expect(below).toBeCloseTo(at, 9);
  });

  it('scales linearly with distance along a level ray', () => {
    const near = opticalDepth(CLEAR_DAY_DENSITY, 10_000, 0, 0);
    const far = opticalDepth(CLEAR_DAY_DENSITY, 30_000, 0, 0);
    expect(far).toBeCloseTo(near * 3, 9);
  });
});

describe('fogDensityFor', () => {
  it('is clearest in full daylight and thickest at night', () => {
    expect(fogDensityFor(60)).toBeCloseTo(CLEAR_DAY_DENSITY, 12);
    expect(fogDensityFor(-30)).toBeCloseTo(NIGHT_DENSITY, 12);
  });

  it('moves smoothly through dusk rather than switching', () => {
    // A step here is a visible flash across the whole world as the sun sets.
    let previous = fogDensityFor(-10);
    for (let elevation = -8; elevation <= 10; elevation += 1) {
      const density = fogDensityFor(elevation);
      expect(density).toBeLessThanOrEqual(previous + 1e-12);
      expect(Math.abs(density - previous)).toBeLessThan(2e-6);
      previous = density;
    }
  });
});

describe('the mid-field stays legible', () => {
  it('leaves shapes visible a hundred kilometres ahead at cruise', () => {
    // The cockpit looks *along* the ground rather than down at it, so most of
    // the screen at any moment is a hundred kilometres or more away. A
    // physically honest atmosphere makes all of that white, which is correct
    // and is not what anyone opened a satellite globe to see. This is the
    // upper bound that keeps the view worth having.
    const haze = aerialOpacity(CLEAR_DAY_DENSITY, 100_000, 10_700, 0);
    expect(haze).toBeLessThan(0.6);
    // And still enough to soften the imagery-dataset boundary out there.
    expect(haze).toBeGreaterThan(0.3);
  });
});
