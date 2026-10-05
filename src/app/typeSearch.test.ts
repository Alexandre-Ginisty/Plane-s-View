import { describe, expect, it } from 'vitest';

import { searchTypes } from '@/data/meta/typeNames';
import type { AircraftState } from '@/data/types';
import { pickOfType } from './typeSearch';

const plane = (hex: string, over: Partial<AircraftState> = {}): AircraftState =>
  ({ hex, lat: 48, lon: 2, trackDeg: 90, headingDeg: 90, onGround: false, altBaroFt: 30_000, altGeomFt: 30_500, groundSpeedKt: 450, ...over }) as AircraftState;

describe('picking an aircraft of a model', () => {
  it('prefers one that is flying, over any number parked', () => {
    const parked = Array.from({ length: 20 }, (_, i) => plane(`p${i}`, { onGround: true, altBaroFt: 0, groundSpeedKt: 0 }));
    const flying = plane('fly');
    for (let i = 0; i < 20; i++) expect(pickOfType([...parked, flying], { random: () => i / 20 })?.hex).toBe('fly');
  });

  it('settles for a slow one in the air before a parked one', () => {
    const slow = plane('slow', { groundSpeedKt: 40, altBaroFt: 800, altGeomFt: 800 });
    const parked = plane('p', { onGround: true });
    expect(pickOfType([parked, slow])?.hex).toBe('slow');
  });

  it('gives nothing when every one is on the ground, or none is trackable', () => {
    expect(pickOfType([plane('a', { onGround: true })])).toBeNull();
    expect(pickOfType([plane('b', { trackDeg: null, headingDeg: null })])).toBeNull();
    expect(pickOfType([])).toBeNull();
  });

  it('skips the aircraft being flown', () => {
    expect(pickOfType([plane('me'), plane('you')], { excludeHex: 'me', random: () => 0 })?.hex).toBe('you');
  });
});

describe('finding a model by what people type', () => {
  it('knows a designator, a marketing number and a name', () => {
    expect(searchTypes('a388')[0]?.code).toBe('A388');
    expect(searchTypes('a380')[0]?.code).toBe('A388');
    expect(searchTypes('737').map((c) => c.code)).toContain('B738');
    expect(searchTypes('king air').map((c) => c.code)).toContain('B350');
    // Accents are ignored, as they are for places.
    expect(searchTypes('Airbüs')[0]?.name).toContain('Airbus');
  });

  it('returns nothing for nothing', () => {
    expect(searchTypes('')).toEqual([]);
    expect(searchTypes('zzzz')).toEqual([]);
  });
});
