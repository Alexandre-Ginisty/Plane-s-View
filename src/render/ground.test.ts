/**
 * The failing case is not subtle once it is written down: an aircraft at a
 * gate is reported at zero feet, zero feet is read as the ellipsoid, and the
 * ellipsoid at a European airport is the better part of a hundred metres
 * underground. What the tests pin is that fixing it does not disturb anything
 * that was already right — a cruising aircraft must be left exactly where the
 * feed put it.
 */

import { describe, expect, it } from 'vitest';

import { shapeFor } from './aircraft';
import { GROUND_CHECK_CEILING_M, clearanceFor, surfaceAltitudeM } from './ground';

/** Heathrow: 25 m of terrain, 47 m of geoid separation under it. */
const LHR_TERRAIN_M = 25;
/** Charles de Gaulle, where the error is worst in this part of the world. */
const CDG_TERRAIN_M = 119;

describe('clearanceFor', () => {
  it('lifts a model by roughly its own undercarriage', () => {
    // An A320's centreline sits about 3.5 m up when it is parked.
    expect(clearanceFor(shapeFor('A320', null))).toBeCloseTo(3.4, 0);
    // A Cessna 172's, about 1.2 m.
    expect(clearanceFor(shapeFor('C172', null))).toBeCloseTo(1.2, 0);
  });

  it('never returns something an aircraft could sink into', () => {
    for (const code of ['A388', 'B738', 'C152', 'EC35', 'DA42', 'ZZZZ']) {
      expect(clearanceFor(shapeFor(code, null)), code).toBeGreaterThan(0.5);
    }
  });
});

describe('surfaceAltitudeM', () => {
  it('puts a parked aircraft on the ground, not under it', () => {
    const clearance = clearanceFor(shapeFor('A320', null));
    // What the feed actually sends for an aircraft at a gate: `alt_baro` is
    // the string "ground", which the normaliser turns into zero.
    const drawn = surfaceAltitudeM(0, true, LHR_TERRAIN_M, clearance);
    expect(drawn).toBeGreaterThan(LHR_TERRAIN_M);
    // And it was 70 m below the terrain before.
    expect(drawn - 0).toBeGreaterThan(25);
  });

  it('is worst where the terrain is highest, and fixes it there too', () => {
    const clearance = clearanceFor(shapeFor('B738', null));
    expect(surfaceAltitudeM(0, true, CDG_TERRAIN_M, clearance)).toBeGreaterThan(CDG_TERRAIN_M);
  });

  it('leaves a cruising aircraft exactly where the feed put it', () => {
    const clearance = clearanceFor(shapeFor('A359', null));
    const cruise = 11_000;
    expect(surfaceAltitudeM(cruise, false, CDG_TERRAIN_M, clearance)).toBe(cruise);
    // Even over the highest ground this code ever samples.
    expect(surfaceAltitudeM(cruise, false, 5000, clearance)).toBe(cruise);
  });

  it('lifts an airborne aircraft only when it is below the ground', () => {
    const clearance = clearanceFor(shapeFor('B738', null));
    // On approach, well above the field: untouched.
    expect(surfaceAltitudeM(400, false, CDG_TERRAIN_M, clearance)).toBe(400);
    // A stale or wrong fix that puts it inside a hillside: lifted out.
    expect(surfaceAltitudeM(50, false, CDG_TERRAIN_M, clearance)).toBeGreaterThan(CDG_TERRAIN_M);
  });

  it('treats unloaded terrain as sea level rather than as a hole', () => {
    const clearance = clearanceFor(shapeFor('B738', null));
    // Before any tile has arrived the sampler answers 0. The aircraft still
    // ends up above the ellipsoid rather than exactly on it.
    expect(surfaceAltitudeM(0, true, 0, clearance)).toBeGreaterThan(0);
  });

  it('gates the terrain lookup above anything terrain can reach', () => {
    // The ceiling has to clear every airport and every low-level route, and
    // stay well under a cruising airliner.
    expect(GROUND_CHECK_CEILING_M).toBeGreaterThan(4500);
    expect(GROUND_CHECK_CEILING_M).toBeLessThan(9000);
  });
});
