import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGERY,
  IMAGERY_FALLBACK_ORDER,
  IMAGERY_SOURCES,
  TERRARIUM,
  TERRARIUM_NODATA,
  decodeTerrarium,
  fillTemplate,
} from './sources';

describe('tile templates', () => {
  it('substitutes every placeholder', () => {
    expect(fillTemplate('a/{z}/{x}/{y}.png', 5, 11, 13)).toBe('a/5/11/13.png');
  });

  /**
   * Esri's REST endpoint is `{z}/{y}/{x}`. Every source must agree with its
   * own `url()` — an earlier version derived the template by probing `url()`
   * with sample indices, which silently failed to substitute `{x}` and served
   * one repeated column of imagery across the whole map.
   */
  it('keeps template and url() in agreement for every source', () => {
    for (const source of IMAGERY_SOURCES) {
      for (const [z, x, y] of [[0, 0, 0], [7, 11, 13], [14, 8531, 5789]] as const) {
        expect(fillTemplate(source.template, z, x, y)).toBe(source.url(z, x, y));
      }
    }
  });

  it('puts Esri on the y/x axis order', () => {
    const url = DEFAULT_IMAGERY.url(7, 11, 13);
    expect(url.endsWith('/7/13/11')).toBe(true);
  });

  it('leaves no unsubstituted placeholders in a built url', () => {
    for (const source of IMAGERY_SOURCES) {
      const url = source.url(9, 100, 200);
      expect(url).not.toMatch(/\{[zxy]\}/);
    }
  });

  it('serves only https', () => {
    for (const source of [...IMAGERY_SOURCES, TERRARIUM]) {
      expect(source.url(3, 2, 1).startsWith('https://')).toBe(true);
    }
  });

  it('declares attribution for every source', () => {
    for (const source of [...IMAGERY_SOURCES, TERRARIUM]) {
      expect(source.attribution.length).toBeGreaterThan(10);
      expect(source.attributionUrl.startsWith('https://')).toBe(true);
    }
  });

  it('only offers layers it can actually fall back to', () => {
    for (const source of IMAGERY_FALLBACK_ORDER) {
      expect(IMAGERY_SOURCES).toContain(source);
    }
  });
});

describe('terrarium decoding', () => {
  it('decodes sea level', () => {
    // 32768 = 128 * 256, so R=128 G=0 B=0 is exactly 0 m.
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
  });

  it('decodes a known summit height', () => {
    // Everest, 8849 m -> 32768 + 8849 = 41617 = 162*256 + 145
    expect(decodeTerrarium(162, 145, 0)).toBeCloseTo(8849, 6);
  });

  it('decodes below sea level', () => {
    expect(decodeTerrarium(127, 156, 0)).toBeCloseTo(-100, 6);
  });

  it('resolves the sub-metre blue channel', () => {
    expect(decodeTerrarium(128, 0, 128)).toBeCloseTo(0.5, 9);
  });

  it('produces the documented no-data sentinel at zero', () => {
    expect(decodeTerrarium(0, 0, 0)).toBe(TERRARIUM_NODATA);
  });

  it('stops at zoom 15, where the service stops', () => {
    // Verified against the live service: z15 serves, z16 returns 404.
    expect(TERRARIUM.maxZoom).toBe(15);
  });
});
