/**
 * Type-code matching is the kind of code that looks obviously right and is
 * quietly wrong for a long time, because a misclassified airframe still
 * renders — just as the wrong thing. The cases that matter are the collisions:
 * helicopter designators share prefixes with airliners, and a prefix rule that
 * works for the Airbus family turns 747s into helicopters.
 */

import { describe, expect, it } from 'vitest';

import { isRotorcraftType, isSurfaceVehicle, shapeFor } from './shapes';

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
   * Regression: the table had `A32` and `B73` but none of the re-engined
   * variants, which do not share those prefixes. Measured against live traffic
   * over eight busy terminal areas, `A21N`, `B38M` and `A20N` were the three
   * most common type codes matching nothing at all — 46% of every aircraft
   * reporting a type fell through to a generic 40 m twin-jet.
   */
  it('recognises the narrowbodies that actually fill the sky', () => {
    for (const code of ['A20N', 'A21N', 'A19N', 'B38M', 'B39M', 'B37M']) {
      const shape = shapeFor(code, 'A3');
      expect(shape.kind, code).toBe('jet');
      expect(shape.engines, code).toBe(2);
      expect(shape.engineMount, code).toBe('wing');
      // Narrowbody, not the generic default and not a widebody.
      expect(shape.length, code).toBeGreaterThan(30);
      expect(shape.length, code).toBeLessThan(46);
    }
    // The stretch is visibly longer than the base model, which is the whole
    // point of listing them separately.
    expect(shapeFor('A21N', null).length).toBeGreaterThan(shapeFor('A20N', null).length);
    expect(shapeFor('B39M', null).length).toBeGreaterThan(shapeFor('B38M', null).length);
  });

  /**
   * Regression: `C17` is a complete ICAO designator (the Boeing C-17
   * Globemaster III) *and* the prefix of the Cessna 170/172/175/177. The
   * prefix rule won, so every Globemaster — four of them in a single live
   * sample — was drawn as an 8 m single-engine Cessna.
   */
  it('prefers an exact designator to a prefix that would lie about it', () => {
    const globemaster = shapeFor('C17', null);
    expect(globemaster.length).toBeGreaterThan(40);
    expect(globemaster.engines).toBe(4);

    const cessna = shapeFor('C172', null);
    expect(cessna.kind).toBe('piston');
    expect(cessna.length).toBeLessThan(12);
  });

  it('matches the longest prefix whatever order the rows are written in', () => {
    // `A321` and `A32` both match an A321; the specific row has to win, and it
    // must keep winning when someone adds a row above it.
    expect(shapeFor('A321', null).length).toBeGreaterThan(shapeFor('A319', null).length);
    expect(shapeFor('A35K', null).length).toBeGreaterThan(60);
    expect(shapeFor('A320', null).length).toBeLessThan(45);
  });

  /**
   * `tTail` used to carry two meanings at once — stabiliser on the fin, and
   * "no underwing engines" — and the geometry builder drew nothing for the
   * tail case. So a CRJ had no engines, and an ATR, which has a T-tail *and*
   * underwing turboprops, was excluded from the wing pods and had none either.
   */
  it('says where the engines are separately from where the tail is', () => {
    const crj = shapeFor('CRJ9', null);
    expect(crj.tTail).toBe(true);
    expect(crj.engineMount).toBe('tail');
    expect(crj.engines).toBe(2);

    const atr = shapeFor('AT76', null);
    expect(atr.kind).toBe('turboprop');
    expect(atr.tTail).toBe(true);
    // The whole regression: a T-tail does not mean the engines left the wing.
    expect(atr.engineMount).toBe('wing');
    expect(atr.engines).toBe(2);

    const dash = shapeFor('DH8D', null);
    expect(dash.engineMount).toBe('wing');

    // Nothing is ever drawn hanging off a wing that has no engines on it.
    const cessna = shapeFor('C152', null);
    expect(cessna.engines).toBe(0);
    expect(cessna.engineMount).toBe('none');
  });

  /**
   * The emitter category is five buckets wide, so it cannot tell a Phenom 300
   * from a Cessna 152 — both broadcast `A1`. Before the business jets were in
   * the table, every one of them was drawn as a straight-wing piston single.
   */
  it('does not let a coarse category flatten a business jet into a trainer', () => {
    const phenom = shapeFor('E55P', 'A1');
    expect(phenom.kind).toBe('jet');
    expect(phenom.sweepDeg).toBeGreaterThan(10);
    expect(phenom.length).toBeGreaterThan(13);

    const trainer = shapeFor('C152', 'A1');
    expect(trainer.kind).toBe('piston');
    expect(trainer.sweepDeg).toBe(0);
    expect(trainer.length).toBeLessThan(9);
  });

  /**
   * A coverage floor, held against the type codes actually observed over
   * Paris, London, Frankfurt, New York, Dubai, Amsterdam, Rome and San
   * Francisco, ordered by how common they were. The old table matched none of
   * these; the point of the test is that a future edit cannot quietly drop
   * them again.
   */
  it('gives a sailplane its wing from the type code alone', () => {
    // Most gliders broadcast no emitter category, so the `B1` route never
    // fires and the designator is the only signal there is.
    for (const code of ['DISC', 'ASK21', 'LS8', 'DG1000', 'NIMB', 'SLG2']) {
      const shape = shapeFor(code, null);
      expect(shape.kind, code).toBe('glider');
      expect(shape.spanRatio, code).toBeGreaterThan(2);
      expect(shape.engines, code).toBe(0);
    }
  });

  it('keeps microlights small instead of giving them an airliner', () => {
    for (const code of ['VL3', 'WT9', 'FK9', 'EFOX', 'SIRA']) {
      const shape = shapeFor(code, 'A1');
      expect(shape.kind, code).toBe('piston');
      expect(shape.length, code).toBeLessThan(8);
    }
  });

  it('covers the common type codes that were falling through', () => {
    const observed = [
      'A21N', 'B38M', 'A20N', 'C152', 'DA42', 'PC12', 'A210', 'DR40', 'E55P',
      'DA40', 'C42', 'E75L', 'C56X', 'CL35', 'E295', 'P68', 'GLEX', 'C208',
      'G115', 'CL60', 'RV7', 'F2TH', 'PC24', 'F900', 'DV20', 'BE20', 'C525',
      'GL7T', 'PA34', 'C150', 'LJ35', 'C560', 'B350', 'BE36', 'BE40', 'C510',
      'PA38', 'M20P', 'C68A', 'E550', 'PA44', 'E50P', 'C680', 'M700', 'E35L',
      'P180', 'BE35', 'G280', 'C650', 'K35R', 'C17',
    ];
    const unmatched = observed.filter((code) => {
      // A shape that is identical to the "nothing matched" fallback is a miss.
      const shape = shapeFor(code, null);
      const fallback = shapeFor('ZZZZ', null);
      return JSON.stringify(shape) === JSON.stringify(fallback);
    });
    expect(unmatched).toEqual([]);
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

describe('isSurfaceVehicle', () => {
  /**
   * Airport ground fleets broadcast ADS-B on the same feed as the traffic, so
   * a snapshot taken near a field carries a dozen of them. Their type codes
   * (`GND`, `TWR`, `SERV`) match nothing, so each was drawn as a 40 m airliner
   * parked on a taxiway — the spikes around airports.
   */
  it('recognises the surface and obstacle emitter categories', () => {
    for (const cat of ['C0', 'C1', 'C2', 'C3', 'c2']) {
      expect(isSurfaceVehicle(cat), cat).toBe(true);
    }
  });

  it('does not claim anything that flies', () => {
    for (const cat of ['A1', 'A3', 'A7', 'B1', 'B4', 'B6', null, undefined, '']) {
      expect(isSurfaceVehicle(cat), String(cat)).toBe(false);
    }
  });
});
