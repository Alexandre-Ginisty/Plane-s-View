/**
 * National aerial imagery, laid over the global layer where it exists.
 *
 * The global layer (Sentinel-2 cloudless 2016) is 10 m a pixel, which is right
 * from cruise and soft from a few hundred metres up. Commercial imagery is
 * sharper everywhere and none of it may be used here (see `THIRD_PARTY_NOTICES.md`),
 * but national mapping agencies publish theirs as open data — 5 to 40 cm, free
 * to use in a product, for a credit. Where one covers the ground, the globe
 * draws that instead, from zoom 13 down.
 *
 * ## What qualifies
 *
 * A layer is here only if all of these were checked against the live service
 * and the agency's own terms:
 *
 *  - a licence that allows commercial use (the `licence` field says which);
 *  - no key, no account, no registration;
 *  - `Access-Control-Allow-Origin`, so the page can fetch it directly.
 *
 * Left out for failing one: Japan (GSI, no CORS), Czechia (no CORS), Poland
 * (terms forbid "harvesting"), Denmark, Finland, Sweden and New Zealand (a key),
 * the United Kingdom, Italy, Ireland and Canada (no open national service),
 * Alaska and Hawaii (commercially licensed orthoimagery). Adding a country is
 * one entry below, its outline in `coverage.json` (`tools/tiles/build-coverage.mjs`)
 * and its host in the CSP (`public/_headers`).
 *
 * ## How a tile picks its layer
 *
 * By where the tile *is*: a tile is drawn from a national layer only if its
 * centre and all four corners are inside that country's outline, so a tile
 * straddling a border — half of it outside the agency's coverage, and drawn
 * there as blank — keeps the global imagery. One provider per tile, always;
 * the rule in `loadTexture` still stands.
 */

import { tileBounds, tileCenterLatLon } from '@/core/math/geo';
import coverage from './coverage.json';
import { fillTemplate, type ImagerySource } from './sources';

/** A national layer: an imagery source plus where it applies. */
export interface RegionalLayer extends ImagerySource {
  /** Key into `coverage.json`. */
  readonly region: string;
  /** The licence, as the agency names it. Shown with the credit. */
  readonly licence: string;
  /**
   * A reply shorter than this is the server's blank tile or error page, not a
   * photograph. Several agencies answer 200 with an empty picture outside
   * their coverage rather than 404; a real 256 px aerial JPEG is never this
   * small except over featureless water, which then keeps the global imagery.
   */
  readonly minBytes: number;
}

const MIN_BYTES = 2500;

/** From this zoom the national layer replaces the global one. */
const FROM_ZOOM = 13;

function layer(
  spec: Omit<RegionalLayer, 'minZoom' | 'tileSize' | 'format' | 'minBytes' | 'url' | 'description'> & {
    description?: string;
    url?: (z: number, x: number, y: number) => string;
  },
): RegionalLayer {
  const self: RegionalLayer = {
    ...spec,
    description: spec.description ?? `${spec.label} — open aerial imagery, ${spec.licence}.`,
    minZoom: FROM_ZOOM,
    tileSize: 256,
    format: 'jpeg',
    minBytes: MIN_BYTES,
    url: spec.url ?? ((z, x, y) => fillTemplate(self.template, z, x, y)),
  };
  return self;
}

export const REGIONAL_LAYERS: readonly RegionalLayer[] = [
  layer({
    id: 'ign-fr',
    region: 'fr',
    label: 'France — IGN',
    attribution: 'Aerial imagery © IGN (Géoplateforme)',
    attributionUrl: 'https://geoservices.ign.fr/',
    licence: 'Licence Ouverte Etalab 2.0',
    maxZoom: 19,
    template:
      'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
  }),
  layer({
    id: 'pdok-nl',
    region: 'nl',
    label: 'Netherlands — Beeldmateriaal Nederland',
    attribution: 'Aerial imagery © Beeldmateriaal Nederland (CC BY 4.0)',
    attributionUrl: 'https://www.beeldmateriaal.nl/',
    licence: 'CC BY 4.0',
    maxZoom: 19,
    template:
      'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=Actueel_orthoHR&STYLE=default&FORMAT=image/jpeg&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}',
  }),
  layer({
    id: 'basemap-at',
    region: 'at',
    label: 'Austria — basemap.at',
    attribution: 'Aerial imagery: basemap.at (CC BY 4.0)',
    attributionUrl: 'https://basemap.at/',
    licence: 'CC BY 4.0',
    maxZoom: 19,
    template: 'https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg',
  }),
  layer({
    id: 'pnoa-es',
    region: 'es',
    label: 'Spain — PNOA',
    attribution: 'Aerial imagery: PNOA cedido por © Instituto Geográfico Nacional de España (CC BY 4.0)',
    attributionUrl: 'https://pnoa.ign.es/',
    licence: 'CC BY 4.0',
    maxZoom: 19,
    template:
      'https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&layer=OI.OrthoimageCoverage&style=default&format=image/jpeg&tilematrixset=GoogleMapsCompatible&tilematrix={z}&tilerow={y}&tilecol={x}',
  }),
  layer({
    id: 'swissimage-ch',
    region: 'ch',
    label: 'Switzerland — swisstopo',
    attribution: 'Aerial imagery © swisstopo (SWISSIMAGE)',
    attributionUrl: 'https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10',
    licence: 'Open Government Data, free use with source',
    maxZoom: 19,
    template: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
  }),
  layer({
    id: 'geoportail-lu',
    region: 'lu',
    label: 'Luxembourg — Géoportail',
    attribution: 'Aerial imagery: Administration du cadastre et de la topographie, Luxembourg (CC0)',
    attributionUrl: 'https://data.public.lu/en/datasets/orthophoto-officielle-du-grand-duche-de-luxembourg-edition-ete-2025/',
    licence: 'CC0 1.0',
    maxZoom: 19,
    template: 'https://wmts1.geoportail.lu/opendata/wmts/ortho_latest/GLOBAL_WEBMERCATOR_4_V3/{z}/{x}/{y}.jpeg',
  }),
  layer({
    id: 'maaamet-ee',
    region: 'ee',
    label: 'Estonia — Maa- ja Ruumiamet',
    attribution: 'Aerial imagery © Maa- ja Ruumiamet (Estonian Land Board, open data licence)',
    attributionUrl: 'https://geoportaal.maaruum.ee/avaandmete-litsents',
    licence: 'Estonian Land Board open data licence (CC BY 4.0 equivalent)',
    maxZoom: 18,
    template: 'https://tiles.maaamet.ee/tm/wmts/1.0.0/foto/default/GMC/{z}/{y}/{x}.jpg',
  }),
  layer({
    id: 'usgs-us',
    region: 'us',
    label: 'United States — USGS',
    attribution: 'Aerial imagery: U.S. Geological Survey, The National Map (public domain)',
    attributionUrl: 'https://www.usgs.gov/programs/national-geospatial-program/national-map',
    licence: 'public domain',
    // The tile cache stops at 16 (about 2 m); past it the service answers 404.
    maxZoom: 16,
    template: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
  }),
  layer({
    id: 'nrw-de',
    region: 'de-nw',
    label: 'North Rhine-Westphalia — Geobasis NRW',
    attribution: 'Aerial imagery © Geobasis NRW (dl-de/zero-2.0)',
    attributionUrl: 'https://www.govdata.de/dl-de/zero-2-0',
    licence: 'Datenlizenz Deutschland – Zero 2.0',
    maxZoom: 19,
    template: 'https://www.wmts.nrw.de/geobasis/wmts_nw_dop/tiles/nw_dop/EPSG_3857_16/{z}/{x}/{y}.jpeg',
    // The service's matrix set counts from standard zoom 5, as two digits.
    url: (z, x, y) =>
      `https://www.wmts.nrw.de/geobasis/wmts_nw_dop/tiles/nw_dop/EPSG_3857_16/${String(z - 5).padStart(2, '0')}/${x}/${y}.jpeg`,
  }),
  layer({
    id: 'bayern-de',
    region: 'de-by',
    label: 'Bavaria — Bayerische Vermessungsverwaltung',
    attribution: 'Aerial imagery: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de (CC BY 4.0)',
    attributionUrl: 'https://geodaten.bayern.de/',
    licence: 'CC BY 4.0',
    maxZoom: 19,
    template: 'https://wmtsod1.bayernwolke.de/wmts/by_dop/smerc/{z}/{x}/{y}',
  }),
];

// ---------------------------------------------------------------------------
// Where each layer applies
// ---------------------------------------------------------------------------

type Ring = readonly (readonly [number, number])[];

interface Outline {
  ring: Ring;
  west: number;
  east: number;
  south: number;
  north: number;
}

const OUTLINES = new Map<string, Outline[]>(
  Object.entries(coverage as unknown as Record<string, Ring[]>).map(([region, rings]) => [
    region,
    rings.map((ring) => {
      let west = Infinity;
      let east = -Infinity;
      let south = Infinity;
      let north = -Infinity;
      for (const [lon, lat] of ring) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
      return { ring, west, east, south, north };
    }),
  ]),
);

/** Even-odd ray cast. */
function inRing(ring: Ring, lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRegion(region: string, lon: number, lat: number): boolean {
  for (const o of OUTLINES.get(region) ?? []) {
    if (lon < o.west || lon > o.east || lat < o.south || lat > o.north) continue;
    if (inRing(o.ring, lon, lat)) return true;
  }
  return false;
}

/**
 * Lookups are made for every tile, every frame the camera is near the ground,
 * and the answer never changes: remembered. Bounded, so a long flight cannot
 * grow it without limit.
 */
const MEMO_LIMIT = 40_000;
const memoStrict = new Map<string, RegionalLayer | null>();
const memoCentre = new Map<string, RegionalLayer | null>();

function find(z: number, x: number, y: number, strict: boolean): RegionalLayer | null {
  const memo = strict ? memoStrict : memoCentre;
  const key = `${z}/${x}/${y}`;
  const known = memo.get(key);
  if (known !== undefined) return known;

  const c = tileCenterLatLon(z, x, y);
  let found: RegionalLayer | null = null;
  for (const candidate of REGIONAL_LAYERS) {
    if (!inRegion(candidate.region, c.lon, c.lat)) continue;
    if (strict) {
      const b = tileBounds(z, x, y);
      const whole =
        inRegion(candidate.region, b.west, b.north) &&
        inRegion(candidate.region, b.east, b.north) &&
        inRegion(candidate.region, b.west, b.south) &&
        inRegion(candidate.region, b.east, b.south);
      if (!whole) continue;
    }
    found = candidate;
    break;
  }

  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(key, found);
  return found;
}

/**
 * The national layer that draws this tile, or null for the global one.
 * `x` must already be wrapped into `0..2^z`.
 */
export function regionalLayerFor(z: number, x: number, y: number): RegionalLayer | null {
  if (z < FROM_ZOOM) return null;
  const found = find(z, x, y, true);
  return found && z <= found.maxZoom ? found : null;
}

/**
 * How deep the imagery goes at this tile: the national layer's maximum where
 * the tile's centre is in its country, else the global layer's.
 *
 * The centre alone, not the whole tile as `regionalLayerFor` insists on. This
 * answers "is it worth refining here?", and at a border it should be yes: the
 * children that fall wholly inside get sharper imagery and the others inherit
 * their parent's, which is the same as not refining them at all.
 */
export function imageryMaxZoom(global: ImagerySource, z: number, x: number, y: number): number {
  const found = find(z, x, y, false);
  return found ? Math.max(found.maxZoom, global.maxZoom) : global.maxZoom;
}

/** Same question at a point: for the descent prefetch, which has a position, not a tile. */
export function imageryMaxZoomAt(global: ImagerySource, lat: number, lon: number): number {
  for (const candidate of REGIONAL_LAYERS) {
    if (inRegion(candidate.region, lon, lat)) return Math.max(candidate.maxZoom, global.maxZoom);
  }
  return global.maxZoom;
}

/**
 * The layer to request this tile from, or null if none has it.
 *
 * Inside a country and from zoom 13, from its agency; otherwise from the
 * global layer. Past a layer's own maximum there is no tile, and the caller
 * lets the tile inherit its parent's imagery.
 */
export function imageryFor(global: ImagerySource, z: number, x: number, y: number): ImagerySource | null {
  const national = global.sharp ? null : regionalLayerFor(z, x, y);
  if (national) return national;
  return z >= global.minZoom && z <= global.maxZoom ? global : null;
}
