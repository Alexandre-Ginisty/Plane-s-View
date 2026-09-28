/**
 * Tile source registry — imagery and elevation.
 *
 * Every source here was verified to serve XYZ tiles with
 * `Access-Control-Allow-Origin: *`, with no key and no account, so the globe
 * and the 2D map both work from a purely static deployment.
 *
 * Attribution strings are not decorative. Esri, EOX, NASA and OpenStreetMap
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
  // Note the axis order: Esri's REST tile endpoint is {z}/{y}/{x}, not
  // {z}/{x}/{y}. Swapping them yields plausible-looking imagery of entirely
  // the wrong place.
  template:
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  url: (z, x, y) => fillTemplate(esri.template, z, x, y),
};

const sentinel: ImagerySource = {
  id: 'sentinel',
  label: 'Sentinel-2 cloudless',
  description: 'EOX s2cloudless 2020 — cloud-free, seamless, consistent colour.',
  attribution:
    'Sentinel-2 cloudless (2020) by EOX IT Services GmbH — Contains modified Copernicus Sentinel data',
  attributionUrl: 'https://s2maps.eu',
  minZoom: 0,
  maxZoom: 15,
  tileSize: 256,
  format: 'jpeg',
  template:
    'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg',
  url: (z, x, y) => fillTemplate(sentinel.template, z, x, y),
};

/**
 * Selectable layers.
 *
 * Deliberately two, not four. NASA GIBS (daily MODIS) and OpenStreetMap were
 * both built and both worked, but neither belongs in this app: GIBS stops at
 * zoom 9, which is a blurry smear from a cockpit at any altitude, and OSM is a
 * street map whose tile-usage policy explicitly asks bulk consumers not to
 * send the kind of traffic a terrain renderer generates. Esri for sharpness,
 * Sentinel-2 cloudless for consistent colour, and nothing that makes the view
 * worse.
 */
export const IMAGERY_SOURCES: readonly ImagerySource[] = [esri, sentinel];

/** Order tried when a layer fails to serve a tile. */
export const IMAGERY_FALLBACK_ORDER: readonly ImagerySource[] = [esri, sentinel];

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
  attributionUrl: 'https://registry.opendata.aws/terrain-tiles/',
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
