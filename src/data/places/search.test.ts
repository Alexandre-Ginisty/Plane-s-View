import { describe, expect, it } from 'vitest';

import { fold, matchScore } from './search';

describe('place search matching', () => {
  it('folds accents and case the way people type', () => {
    expect(fold('Zürich')).toBe('zurich');
    expect(fold('  São Paulo ')).toBe('sao paulo');
  });

  it('ranks a whole name over its start, and its start over a later word', () => {
    const whole = matchScore('paris', ['paris'], []);
    const start = matchScore('par', ['paris'], []);
    const word = matchScore('york', ['new york'], []);
    expect(whole).toBeGreaterThan(start);
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(0);
    expect(matchScore('ork', ['new york'], [])).toBe(0);
  });

  it('finds a city under its other names, just behind its own', () => {
    expect(matchScore('londres', ['london', 'londres'], [])).toBeGreaterThan(0);
    expect(matchScore('london', ['london', 'londres'], [])).toBeGreaterThan(matchScore('londres', ['london', 'londres'], []));
  });

  it('puts an airport code above everything', () => {
    expect(matchScore('cdg', ['paris charles de gaulle airport'], ['CDG', 'LFPG'])).toBe(120);
    expect(matchScore('lfpg', ['x'], ['CDG', 'LFPG'])).toBe(120);
  });
});
