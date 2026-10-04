import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { tileBounds } from '@/core/math/geo';
import {
  imageryFor,
  imageryMaxZoom,
  imageryMaxZoomAt,
  regionalLayerFor,
  REGIONAL_LAYERS,
} from './regional';
import { IMAGERY_SOURCES } from './sources';

// The national layers lie over the layers that are not already sharp: the Sentinel-2 mosaic.
const DEFAULT_IMAGERY = IMAGERY_SOURCES.find((s) => !s.sharp)!;

/** The tile at a position and zoom. */
function tileAt(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return { x, y };
}
const layerAt = (lat: number, lon: number, z: number) => {
  const { x, y } = tileAt(lat, lon, z);
  return regionalLayerFor(z, x, y)?.id ?? null;
};

describe('which national layer draws a tile', () => {
  it('uses each agency inside its own country', () => {
    expect(layerAt(48.8566, 2.3522, 16)).toBe('ign-fr'); // Paris
    expect(layerAt(52.3702, 4.8952, 16)).toBe('pdok-nl'); // Amsterdam
    expect(layerAt(48.2082, 16.3738, 16)).toBe('basemap-at'); // Vienna
    expect(layerAt(40.4168, -3.7038, 16)).toBe('pnoa-es'); // Madrid
    expect(layerAt(47.3769, 8.5417, 16)).toBe('swissimage-ch'); // Zurich
    expect(layerAt(49.6116, 6.1319, 16)).toBe('geoportail-lu'); // Luxembourg
    expect(layerAt(59.437, 24.7536, 16)).toBe('maaamet-ee'); // Tallinn
    expect(layerAt(39.7392, -104.9903, 15)).toBe('usgs-us'); // Denver
    expect(layerAt(40.7794, -73.9632, 15)).toBe('usgs-us'); // Manhattan, an island
    expect(layerAt(50.9375, 6.9603, 16)).toBe('nrw-de'); // Cologne
    expect(layerAt(48.1351, 11.582, 16)).toBe('bayern-de'); // Munich
  });

  it('leaves everywhere else to the global layer', () => {
    expect(layerAt(51.5074, -0.1278, 16)).toBeNull(); // London: no open national service
    expect(layerAt(50.1109, 8.6821, 16)).toBeNull(); // Frankfurt: Hesse is not in the list
    expect(layerAt(35.6762, 139.6503, 16)).toBeNull(); // Tokyo: GSI sends no CORS headers
    expect(layerAt(52.52, 13.405, 16)).toBeNull(); // Berlin
    expect(layerAt(45, -30, 16)).toBeNull(); // open sea
  });

  it('never uses Alaska or Hawaii, whose orthoimagery is commercially licensed', () => {
    expect(layerAt(61.2181, -149.9003, 15)).toBeNull(); // Anchorage
    expect(layerAt(21.3069, -157.8583, 15)).toBeNull(); // Honolulu
  });

  it('does not use the overseas territories of a country with a mainland service', () => {
    expect(layerAt(4.9372, -52.3260, 16)).toBeNull(); // Cayenne, French Guiana
    expect(layerAt(12.1696, -68.99, 16)).toBeNull(); // Willemstad, Curaçao
  });

  it('only replaces the global layer from zoom 13', () => {
    expect(layerAt(48.8566, 2.3522, 12)).toBeNull();
    expect(layerAt(48.8566, 2.3522, 13)).toBe('ign-fr');
  });

  it('stops at the layer\'s own maximum, where the tile inherits its parent', () => {
    expect(layerAt(39.7392, -104.9903, 16)).toBe('usgs-us');
    expect(layerAt(39.7392, -104.9903, 17)).toBeNull();
    const deep = tileAt(39.7392, -104.9903, 17);
    expect(imageryFor(DEFAULT_IMAGERY, 17, deep.x, deep.y)).toBeNull();
  });

  it('keeps the global imagery for a tile that straddles a border', () => {
    // The Rhine at Basel, where France, Germany and Switzerland meet: tiles
    // half in one country would be half blank in that country's imagery.
    const z = 15;
    const border = tileAt(47.5896, 7.5897, z);
    expect(regionalLayerFor(z, border.x, border.y)).toBeNull();
  });

  it('asks for deeper refinement where a national layer goes deeper', () => {
    const paris = tileAt(48.8566, 2.3522, 12);
    expect(imageryMaxZoom(DEFAULT_IMAGERY, 12, paris.x, paris.y)).toBe(19);
    const london = tileAt(51.5074, -0.1278, 12);
    expect(imageryMaxZoom(DEFAULT_IMAGERY, 12, london.x, london.y)).toBe(DEFAULT_IMAGERY.maxZoom);
    expect(imageryMaxZoomAt(DEFAULT_IMAGERY, 48.8566, 2.3522)).toBe(19);
    expect(imageryMaxZoomAt(DEFAULT_IMAGERY, 51.5074, -0.1278)).toBe(DEFAULT_IMAGERY.maxZoom);
  });

  it('answers for a tile on the wrapped side of the antimeridian', () => {
    expect(() => regionalLayerFor(15, 0, 12000)).not.toThrow();
  });

  it('lays a national layer only inside the tile it was chosen for', () => {
    const { x, y } = tileAt(48.8566, 2.3522, 16);
    const b = tileBounds(16, x, y);
    expect(b.west).toBeLessThan(2.3522);
    expect(b.east).toBeGreaterThan(2.3522);
  });
});

describe('the layers themselves', () => {
  it('have unique ids and one outline each', () => {
    const ids = REGIONAL_LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    const regions = REGIONAL_LAYERS.map((l) => l.region);
    expect(new Set(regions).size).toBe(regions.length);
  });

  it('serve only https, with no placeholder left unfilled', () => {
    for (const l of REGIONAL_LAYERS) {
      const url = l.url(16, 33000, 22500);
      expect(url.startsWith('https://'), l.id).toBe(true);
      expect(url, l.id).not.toMatch(/\{[zxy]\}/);
      expect(url, l.id).toContain('33000');
      expect(url, l.id).toContain('22500');
    }
  });

  it('put each agency\'s axes in the order it expects', () => {
    const at = (id: string) => REGIONAL_LAYERS.find((l) => l.id === id)!.url(16, 11, 13);
    expect(at('ign-fr')).toContain('TILEMATRIX=16&TILEROW=13&TILECOL=11');
    expect(at('pdok-nl')).toContain('TILEMATRIX=EPSG:3857:16&TILEROW=13&TILECOL=11');
    expect(at('pnoa-es')).toContain('tilematrix=16&tilerow=13&tilecol=11');
    expect(at('basemap-at')).toMatch(/\/16\/13\/11\.jpeg$/); // {z}/{row}/{col}
    expect(at('usgs-us')).toMatch(/\/16\/13\/11$/);
    expect(at('swissimage-ch')).toMatch(/\/3857\/16\/11\/13\.jpeg$/); // {z}/{col}/{row}
    expect(at('bayern-de')).toMatch(/\/smerc\/16\/11\/13$/);
    expect(at('maaamet-ee')).toMatch(/\/GMC\/16\/13\/11\.jpg$/);
  });

  it('count North Rhine-Westphalia\'s zoom from 5, in two digits', () => {
    const nrw = REGIONAL_LAYERS.find((l) => l.id === 'nrw-de')!;
    expect(nrw.url(15, 100, 200)).toMatch(/EPSG_3857_16\/10\/100\/200\.jpeg$/);
    expect(nrw.url(19, 100, 200)).toMatch(/EPSG_3857_16\/14\/100\/200\.jpeg$/);
  });

  it('all carry a credit and a licence, because the licences require one', () => {
    for (const l of REGIONAL_LAYERS) {
      expect(l.attribution.length, l.id).toBeGreaterThan(15);
      expect(l.attributionUrl.startsWith('https://'), l.id).toBe(true);
      expect(l.licence.length, l.id).toBeGreaterThan(3);
    }
  });

  /**
   * A layer added without its host in the CSP does not fail in review, it fails
   * in production: every tile is refused by the browser and the ground silently
   * stays at 10 m. This is the check that makes that loud.
   */
  it('are all allowed by the Content-Security-Policy', () => {
    const headers = readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8');
    const connect = /connect-src ([^;]*);/.exec(headers)?.[1] ?? '';
    for (const l of REGIONAL_LAYERS) {
      const origin = new URL(l.url(16, 1, 1)).origin;
      expect(connect.split(' '), l.id).toContain(origin);
    }
  });
});

describe('a layer that is already sharp', () => {
  it('has no national layer laid over it', () => {
    const sharp = IMAGERY_SOURCES.find((s) => s.sharp)!;
    const paris = tileAt(48.8566, 2.3522, 16);
    expect(imageryFor(sharp, 16, paris.x, paris.y)).toBe(sharp);
    expect(imageryFor(DEFAULT_IMAGERY, 16, paris.x, paris.y)?.id).toBe('ign-fr');
  });
});
