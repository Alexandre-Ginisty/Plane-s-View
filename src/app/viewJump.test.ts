import { describe, expect, it } from 'vitest';

import { viewJumped } from './viewJump';

const view = (lat: number, lon: number, radiusNm: number) => ({ lat, lon, radiusNm });

describe('viewJumped', () => {
  it('is true for a move to another city', () => {
    expect(viewJumped(view(51.5, -0.1, 80), view(48.85, 2.35, 80))).toBe(true); // London -> Paris
  });

  it('is false for a small pan', () => {
    expect(viewJumped(view(48.85, 2.35, 80), view(48.9, 2.5, 80))).toBe(false);
  });

  it('is true for a zoom to a different scale, in either direction', () => {
    expect(viewJumped(view(48.85, 2.35, 40), view(48.85, 2.35, 120))).toBe(true);
    expect(viewJumped(view(48.85, 2.35, 120), view(48.85, 2.35, 40))).toBe(true);
  });

  it('is false for a nudge of the scale', () => {
    expect(viewJumped(view(48.85, 2.35, 100), view(48.85, 2.35, 110))).toBe(false);
  });

  it('measures across the antimeridian, not around the globe', () => {
    expect(viewJumped(view(0, 179.9, 100), view(0, -179.9, 100))).toBe(false);
  });
});
