/**
 * Which airframe, and in whose colours.
 *
 * Two reported faults, both of the same shape: the app drew an aeroplane that
 * was confidently and specifically wrong. Every 777 wore one airline's paint
 * because the converted model happened to be authored in it, and a type with
 * no model got a generated mesh rather than a real airframe of the same kind.
 *
 * The rule these tests defend is that a substitution must never be a *claim*.
 * Standing in a 737 for an unknown narrowbody is an approximation anyone can
 * see is one; putting Emirates' scheme on a Qatar aircraft is a statement about
 * a specific aeroplane, and it is false.
 */

import { describe, expect, it } from 'vitest';

import { operatorOf } from './library';

describe('operatorOf', () => {
  it('reads the airline off a commercial callsign', () => {
    expect(operatorOf('AFR1180')).toBe('AFR');
    expect(operatorOf('BAW117')).toBe('BAW');
    expect(operatorOf('UAE202')).toBe('UAE');
  });

  it('tolerates the padding the feeds send', () => {
    // ADS-B callsigns are a fixed-width field, so they arrive space-padded
    // more often than not.
    expect(operatorOf('KLM1234  ')).toBe('KLM');
    expect(operatorOf('  JAL44')).toBe('JAL');
  });

  it('accepts lower case, which some providers normalise to', () => {
    expect(operatorOf('afr1180')).toBe('AFR');
  });

  it('refuses a registration', () => {
    // A privately flown aircraft broadcasts its registration, and `F-GKXA`
    // starts with letters that are not an airline. Reading three characters
    // and hoping is how a Cessna ends up in Air France colours.
    expect(operatorOf('F-GKXA')).toBeNull();
    expect(operatorOf('N172SP')).toBeNull();
    expect(operatorOf('G-EZBA')).toBeNull();
  });

  it('refuses anything that is not three letters then a digit', () => {
    for (const bad of ['', '   ', 'A1', 'AF12', '1234', 'ABCDEF', 'AB1234']) {
      expect(operatorOf(bad)).toBeNull();
    }
  });

  it('handles a missing callsign', () => {
    expect(operatorOf(null)).toBeNull();
    expect(operatorOf(undefined)).toBeNull();
  });
});

describe('the catalogue the converter writes', () => {
  /**
   * Read from disk rather than mocked. The shape of `index.json` is a contract
   * between a build script nobody runs often and a loader that fails silently
   * when it is wrong — the aircraft simply stays procedural, which looks like
   * a missing model rather than a broken catalogue.
   */
  const index = JSON.parse(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').readFileSync('public/models/index.json', 'utf8'),
  ) as {
    types: Record<string, string>;
    liveries: Record<string, Record<string, string>>;
    fallback: Record<string, string>;
  };

  it('covers the busiest type designators', () => {
    for (const type of ['B738', 'B77W', 'B788', 'A388', 'AT72', 'DH8D', 'CRJ7', 'E145']) {
      expect(index.types[type]).toBeTruthy();
    }
  });

  it('offers a fallback for every airframe kind that has one', () => {
    for (const kind of ['jet', 'turboprop', 'rotorcraft']) {
      const id = index.fallback[kind];
      expect(id, `no fallback for ${kind}`).toBeTruthy();
      // A fallback that names a model nobody converted is worse than none: the
      // loader would download a 404 on every unknown aircraft.
      expect(Object.values(index.types)).toContain(id);
    }
  });

  it('never falls back across kinds', () => {
    // The one substitution that must not happen. A helicopter standing in for
    // an airliner is not an approximation, it is a different aircraft.
    expect(index.fallback['rotorcraft']).not.toBe(index.fallback['jet']);
    expect(index.fallback['rotorcraft']).not.toBe(index.fallback['turboprop']);
  });

  it('ships a neutral livery wherever it ships operator liveries', () => {
    // The fallback that keeps a substitution honest: with no NEUTRAL entry the
    // loader would have to choose some airline's paint for an operator it does
    // not know, which is the fault this whole mechanism exists to fix.
    for (const [model, liveries] of Object.entries(index.liveries)) {
      expect(liveries['NEUTRAL'], `${model} has no neutral livery`).toBeTruthy();
    }
  });

  it('names liveries by ICAO airline designator', () => {
    // The join between a callsign and a paint scheme. A file keyed by anything
    // else can never be found from a callsign, however many of them ship.
    for (const liveries of Object.values(index.liveries)) {
      for (const code of Object.keys(liveries)) {
        expect(code).toMatch(/^([A-Z]{3}|NEUTRAL)$/);
      }
    }
  });
});
