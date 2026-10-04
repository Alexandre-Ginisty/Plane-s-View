/**
 * Tile source registry — imagery and elevation.
 *
 * Every source here was verified to serve XYZ tiles with
 * `Access-Control-Allow-Origin: *`, with no key and no account, so the globe
 * and the 2D map both work from a purely static deployment.
 *
 * Attribution strings are not decorative. EOX, NASA, Mapzen and OpenStreetMap
 * all require visible credit, and the UI renders `attribution` for whichever
 * layer is active.
 */

/** A raster imagery layer. */
export interface ImagerySource {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly attribution: string;
  readonly attributionUrl: string;
  readonly minZoom: number;
  /** Deepest zoom the service actually serves. Verified, not assumed. */
  readonly maxZoom: number;
  readonly tileSize: number;
  /**
   * Already as sharp as the sharpest national aerial imagery everywhere it
   * matters, so `regional.ts` lays none over it (and cuts no seams into it).
   */
  readonly sharp?: boolean;
  /** Extension hint for the disk cache. */
  readonly format: 'jpeg' | 'png';
  /**
   * URL template with `{z}` `{x}` `{y}` placeholders.
   *
   * Declared, not inferred. Deriving it by probing `url()` with sample indices
   * and substituting them back looks clever and is quietly wrong: Esri's axis
   * order is `{z}/{y}/{x}`, so the probe values land in surprising places and
   * a placeholder can silently fail to match — producing a template that
   * always requests the same column. One field removes the guesswork, and
   * `url()` is derived from it so the two can never disagree.
   */
  readonly template: string;
  url(z: number, x: number, y: number): string;
}

/** Fill a tile template. The single place `{z}/{x}/{y}` is interpreted. */
export function fillTemplate(template: string, z: number, x: number, y: number): string {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

const esri: ImagerySource = {
  id: 'esri',
  label: 'Satellite HD',
  description: 'Esri World Imagery — the sharpest free global coverage.',
  attribution:
    'Imagery © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  attributionUrl: 'https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9',
  minZoom: 0,
  maxZoom: 19,
  tileSize: 256,
  format: 'jpeg',
  // Already as sharp as any national orthophoto, so none is laid over it.
  sharp: true,
  // Note the axis order: Esri's REST tile endpoint is {z}/{y}/{x}, not
  // {z}/{x}/{y}. Swapping them yields plausible-looking imagery of entirely
  // the wrong place.
  template:
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  url: (z, x, y) => fillTemplate(esri.template, z, x, y),
};

const sentinel: ImagerySource = {
  id: 'sentinel',
  label: 'Satellite',
  description: 'Sentinel-2 cloudless 2016 — cloud-free, seamless, 10 m.',
  attribution:
    'Sentinel-2 cloudless (2016) by EOX IT Services GmbH — Contains modified Copernicus Sentinel data 2016',
  attributionUrl: 'https://s2maps.eu',
  minZoom: 0,
  // The mosaic is built from 10 m imagery, which is zoom 14. The server also
  // answers deeper, but only with the same pixels enlarged.
  maxZoom: 14,
  tileSize: 256,
  format: 'jpeg',
  // `s2cloudless_3857` is the 2016 edition and nothing else: the later editions
  // are `s2cloudless-YYYY_3857` and are licensed CC BY-NC-SA, which a public
  // product cannot use. Axis order is WMTS's {z}/{row}/{col}, i.e. {z}/{y}/{x}.
  template:
    'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg',
  url: (z, x, y) => fillTemplate(sentinel.template, z, x, y),
};

/**
 * NASA Blue Marble Next Generation: the whole Earth at 500 m, public domain.
 * Only there so the globe is never bare if the Sentinel server is unreachable.
 */
const blueMarble: ImagerySource = {
  id: 'bluemarble',
  label: 'Blue Marble',
  description: 'NASA Blue Marble — the whole Earth at 500 m, public domain.',
  attribution: 'Imagery: NASA Earth Observatory — Blue Marble Next Generation, via NASA GIBS',
  attributionUrl: 'https://visibleearth.nasa.gov/collection/1484/blue-marble',
  minZoom: 0,
  maxZoom: 8,
  tileSize: 256,
  format: 'jpeg',
  template:
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
  url: (z, x, y) => fillTemplate(blueMarble.template, z, x, y),
};

/**
 * Selectable layers.
 *
 * Esri World Imagery is the default: the sharpest free global coverage, and
 * the one the ground looks best in at every altitude. It is licensed for
 * ArcGIS subscribers, not for a commercial product — fine for a site shown as
 * a demonstration, and the first thing to replace before charging anyone or
 * carrying advertising. The layers below it are the ones that may be used
 * commercially: Sentinel-2 cloudless 2016 (CC BY 4.0; the later editions are
 * non-commercial) with the national open orthophotos of `regional.ts` laid
 * over it, and NASA Blue Marble. `THIRD_PARTY_NOTICES.md` says the same.
 */
export const IMAGERY_SOURCES: readonly ImagerySource[] = [esri, sentinel, blueMarble];

/** Order tried when a layer fails to serve a tile. */
export const IMAGERY_FALLBACK_ORDER: readonly ImagerySource[] = [esri, sentinel, blueMarble];

export const DEFAULT_IMAGERY = esri;

export function imageryById(id: string): ImagerySource | undefined {
  return IMAGERY_SOURCES.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

export interface ElevationSource {
  readonly id: string;
  readonly label: string;
  readonly attribution: string;
  readonly attributionUrl: string;
  readonly maxZoom: number;
  readonly tileSize: number;
  url(z: number, x: number, y: number): string;
}

/**
 * Mapzen Terrarium on AWS Open Data.
 *
 * Elevation is RGB-encoded: `height_m = (R * 256 + G + B / 256) - 32768`.
 * That gives a 1/256 m quantum over a +/-32 km range, which is far finer than
 * the underlying data (SRTM at ~30 m, coarser at sea).
 *
 * Verified: zoom 15 serves, zoom 16 returns 404. Deeper imagery zooms inherit
 * elevation from their z15 ancestor by sampling the parent heightmap.
 */
export const TERRARIUM: ElevationSource = {
  id: 'terrarium',
  label: 'Mapzen Terrain Tiles',
  attribution:
    'Elevation: Mapzen Terrain Tiles on AWS Open Data — SRTM, GMTED, ETOPO1, NED and others',
  attributionUrl: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md',
  maxZoom: 15,
  tileSize: 256,
  url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
};

/** Decode one Terrarium texel to metres. Kept here so the worker and the
 *  picking code cannot drift apart. */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Terrarium's sentinel for "no data" decodes to exactly -32768 m. Left raw it
 * punches a 32 km pit through the globe.
 */
export const TERRARIUM_NODATA = -32768;
