/**
 * Display formatting.
 *
 * These are the strings the HUD and the dossier panel show, so a bug here is
 * a number the user reads as fact.
 */

import { describe, expect, it } from 'vitest';

import { heading, mach, speed } from './format';

describe('mach', () => {
  /** The conventional cockpit form drops the leading zero. */
  it('drops the leading zero below Mach 1', () => {
    expect(mach(0.786)).toBe('M.786');
    expect(mach(0.5)).toBe('M.500');
  });

  /**
   * Regression: the integer digit was thrown away.
   *
   * Trimming the first character assumed the value always started with `0`,
   * so Mach 1.2 rendered as `M.200` — not a rounding slip but a supersonic
   * aircraft displayed as subsonic.
   */
  it('keeps the integer digit at and above Mach 1', () => {
    expect(mach(1.2)).toBe('M1.200');
    expect(mach(1)).toBe('M1.000');
    expect(mach(2.05)).toBe('M2.050');
  });

  it('has a placeholder for nothing to show', () => {
    expect(mach(null)).toBe(mach(Number.NaN));
    expect(mach(Number.POSITIVE_INFINITY)).toBe(mach(null));
  });
});

describe('heading', () => {
  it('always shows three digits', () => {
    expect(heading(7)).toBe('007°');
    expect(heading(360)).toBe('000°');
    expect(heading(-10)).toBe('350°');
  });
});

describe('speed', () => {
  it('labels the unit', () => {
    expect(speed(450)).toContain('kt');
    expect(speed(null)).not.toContain('kt');
  });
});
