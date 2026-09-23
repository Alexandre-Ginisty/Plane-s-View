/**
 * Type-code matching is the kind of code that looks obviously right and is
 * quietly wrong for a long time, because a misclassified airframe still
 * renders — just as the wrong thing. The cases that matter are the collisions:
 * helicopter designators share prefixes with airliners, and a prefix rule that
 * works for the Airbus family turns 747s into helicopters.
 */

import { describe, expect, it } from 'vitest';

import { isRotorcraftType, shapeFor } from './shapes';

describe('isRotorcraftType', () => {
  it('recognises the common helicopter designators', () => {
    for (const code of ['EC35', 'H145', 'R44', 'A139', 'B429', 'S92', 'UH60', 'AS50']) {
      expect(isRotorcraftType(code), code).toBe(true);
    }
  });

  it('does not claim airliners that share a prefix', () => {
    // Every one of these would be caught by an "obvious" prefix rule: B4 for
    // the Bell 412, A1 for the AW109, B2 for the Bell 212, S7 for the S-76.
    for (const code of ['B744', 'B748', 'A318', 'A320', 'B738', 'B752', 'A21N', 'B763']) {
      expect(isRotorcraftType(code), code).toBe(false);
    }
  });

  it('matches exactly, so a longer code is not a helicopter by accident', () => {
    expect(isRotorcraftType('B06')).toBe(true);
    // `B06` is exact-matched, so a hypothetical longer designator starting
    // with it is not swept in. Prefix-matching this table is what would turn
    // a Boeing into a Bell.
    expect(isRotorcraftType('B060X')).toBe(false);
  });
});

describe('shapeFor', () => {
  it('trusts the broadcast category over a missing type code', () => {
    // A7 is "rotorcraft" in the ADS-B emitter category table. The registry
    // lookup that would give a type code frequently returns nothing, and the
    // aircraft itself is the better authority anyway.
    const shape = shapeFor(null, 'A7');
    expect(shape.kind).toBe('rotorcraft');
    expect(shape.rotorRatio).toBeGreaterThan(1);
  });

  it('trusts the broadcast category over a contradicting type code', () => {
    // A feed reporting A7 for something the registry calls a 737 is far more
    // likely to be a stale registry entry than a lying transponder.
    expect(shapeFor('B738', 'A7').kind).toBe('rotorcraft');
  });

  it('uses the type code when no category is broadcast', () => {
    expect(shapeFor('EC35', null).kind).toBe('rotorcraft');
    expect(shapeFor('B738', null).kind).toBe('jet');
  });

  it('sizes known helicopters from their real length', () => {
    expect(shapeFor('R44', null).length).toBeCloseTo(9, 0);
    expect(shapeFor('CH47', null).length).toBeCloseTo(30, 0);
    // An unknown rotorcraft still gets a plausible size rather than an
    // airliner's 40 m.
    expect(shapeFor('ZZZZ', 'A7').length).toBeLessThan(20);
  });

  it('gives gliders a wing far longer than the fuselage', () => {
    const glider = shapeFor(null, 'B1');
    expect(glider.kind).toBe('glider');
    expect(glider.spanRatio).toBeGreaterThan(2);
    expect(glider.engines).toBe(0);
  });

  it('matches airliner families longest-prefix-first', () => {
    // "A35K" must find the A350 entry, not a generic "A3" one. Getting this
    // backwards gives an A350 the proportions of an A320.
    expect(shapeFor('A35K', null).length).toBeGreaterThan(60);
    expect(shapeFor('A320', null).length).toBeLessThan(45);
    // Four engines on the ones that have four.
    expect(shapeFor('A388', null).engines).toBe(4);
    expect(shapeFor('B744', null).engines).toBe(4);
    expect(shapeFor('B738', null).engines).toBe(2);
  });

  it('falls back to the emitter category for an unknown type', () => {
    // A5 is "heavy". Nothing in the table matches, but the category is still
    // enough to avoid drawing a 747 the size of a Cessna.
    expect(shapeFor('ZZZZ', 'A5').length).toBeGreaterThan(60);
    // A1 is "light": straight wing, no pods.
    const light = shapeFor('ZZZZ', 'A1');
    expect(light.engines).toBe(0);
    expect(light.sweepDeg).toBe(0);
  });

  it('is case-insensitive about type codes', () => {
    expect(shapeFor('ec35', null).kind).toBe('rotorcraft');
    expect(shapeFor('b738', null).kind).toBe('jet');
  });

  it('always returns a usable shape', () => {
    for (const [code, cat] of [[null, null], ['', ''], ['???', 'ZZ']] as const) {
      const shape = shapeFor(code, cat);
      expect(shape.length).toBeGreaterThan(0);
      expect(shape.radiusRatio).toBeGreaterThan(0);
      expect(shape.spanRatio).toBeGreaterThan(0);
    }
  });

  /**
   * Regression: 'MD90' was in the rotorcraft table.
   *
   * It is the ICAO designator for the McDonnell Douglas MD-90 airliner, not a
   * helicopter — the MD Helicopters machines are MD52 (520N), MD60 (600N) and
   * EXPL (MD 900 Explorer). Every MD-90 reporting a type code and no emitter
   * category was drawn with a rotor bar.
   */
  it('does not mistake the MD-90 airliner for a helicopter', () => {
    expect(shapeFor('MD90', null).kind).toBe('jet');
    // The genuine MD Helicopters designators must keep their rotor.
    expect(shapeFor('MD52', null).kind).toBe('rotorcraft');
    expect(shapeFor('MD60', null).kind).toBe('rotorcraft');
    expect(shapeFor('EXPL', null).kind).toBe('rotorcraft');
  });
});
