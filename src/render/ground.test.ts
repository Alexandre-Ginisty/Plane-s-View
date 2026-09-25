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
import { GROUND_CHECK_CEILING_M, GroundMemory, clearanceFor, surfaceAltitudeM } from './ground';

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

describe('when the terrain is not known yet', () => {
  /**
   * The case that put a landing aircraft under the satellite imagery.
   *
   * `sampleTerrainHeight` used to answer 0 when no tile covered the point,
   * which is a *height* and a wrong one everywhere that is not the sea. An
   * aircraft on approach outruns the tiles that cover the airfield, so the
   * clamp was handed sea level at exactly the moment it mattered and placed
   * the aeroplane a hundred and sixty-five metres under Charles de Gaulle.
   */

  it('leaves an airborne aircraft where the feed put it', () => {
    // Not clamped to a floor invented from a height nobody measured.
    expect(surfaceAltitudeM(2_000, false, Number.NaN, 3)).toBe(2_000);
  });

  it('does not bury an aircraft reporting itself on the ground', () => {
    // `onGround` normalises to zero feet, so clamping it to "terrain + gear"
    // with terrain unknown is what put forty-one aircraft under Heathrow.
    expect(surfaceAltitudeM(0, true, Number.NaN, 3)).toBe(0);
  });

  it('still clamps once the terrain is known', () => {
    expect(surfaceAltitudeM(50, false, 165, 3)).toBe(168);
    expect(surfaceAltitudeM(0, true, 165, 3)).toBe(168);
    // And never pushes a cruising aircraft down onto the hill below it.
    expect(surfaceAltitudeM(10_000, false, 165, 3)).toBe(10_000);
  });
});

describe('GroundMemory', () => {
  it('answers nothing before it has been told anything', () => {
    expect(Number.isNaN(new GroundMemory().update(Number.NaN))).toBe(true);
  });

  it('holds the last elevation it was given', () => {
    const memory = new GroundMemory();
    expect(memory.update(165)).toBe(165);
    // The tiles under the aircraft have not arrived; the airfield has not moved.
    expect(memory.update(Number.NaN)).toBe(165);
    expect(memory.update(Number.NaN)).toBe(165);
  });

  it('prefers a fresh sample to a remembered one', () => {
    const memory = new GroundMemory();
    memory.update(165);
    expect(memory.update(70)).toBe(70);
  });

  it('forgets when the aircraft changes', () => {
    // Stepping into an aircraft on the other side of the world must not place
    // it on the last one's airfield.
    const memory = new GroundMemory();
    memory.update(165);
    memory.forget();
    expect(Number.isNaN(memory.update(Number.NaN))).toBe(true);
  });
});
