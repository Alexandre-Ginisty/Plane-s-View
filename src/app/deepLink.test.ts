import { describe, expect, it } from 'vitest';

import { formatDeepLink, parseDeepLink } from './deepLink';

describe('parseDeepLink', () => {
  it('reads an aircraft, with or without a seat', () => {
    expect(parseDeepLink('#ac=3C6444')).toEqual({ kind: 'aircraft', hex: '3c6444', cam: null });
    expect(parseDeepLink('#ac=3c6444&cam=wing')).toEqual({ kind: 'aircraft', hex: '3c6444', cam: 'wing' });
    expect(parseDeepLink('#ac=~2a1b3c')).toEqual({ kind: 'aircraft', hex: '~2a1b3c', cam: null });
  });

  it('ignores a seat that does not exist rather than the whole link', () => {
    expect(parseDeepLink('#ac=3c6444&cam=toilet')).toEqual({ kind: 'aircraft', hex: '3c6444', cam: null });
  });

  it('reads a place on the map', () => {
    expect(parseDeepLink('#map=8/48.857/2.352')).toEqual({ kind: 'map', lat: 48.857, lon: 2.352, zoom: 8 });
  });

  it('refuses anything malformed', () => {
    for (const bad of ['', '#', '#ac=xyz', '#ac=3c64445', '#ac=<script>', '#map=8/48', '#map=8/95/2', '#map=40/1/1', '#map=a/b/c']) {
      expect(parseDeepLink(bad), bad).toBeNull();
    }
  });

  it('round-trips what it writes', () => {
    for (const link of [
      { kind: 'aircraft', hex: '3c6444', cam: 'cockpit' },
      { kind: 'aircraft', hex: 'a1b2c3', cam: null },
      { kind: 'map', lat: -33.868, lon: 151.209, zoom: 9.5 },
    ] as const) {
      expect(parseDeepLink(formatDeepLink(link))).toEqual(link);
    }
  });
});
