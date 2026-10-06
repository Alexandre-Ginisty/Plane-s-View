/**
 * The HUD minimap's geometry: Web Mercator, the tiles that cover a small
 * window, and how far that window should reach.
 *
 * Plain image tiles laid out by hand rather than a second MapLibre: one map
 * the size of a postcard does not need a WebGL context of its own (a phone
 * has only a handful), a style, or a worker. A dozen `<img>` elements come
 * from the same imagery servers — and so mostly the same browser cache — as
 * the globe and the 2D map.
 */

const TILE_PX = 256;
const MAX_LAT = 85.0511;
/** Metres per pixel at zoom 0 on the equator, for 256-pixel tiles. */
const EQUATOR_M_PER_PX = 156543.034;
export const METRES_PER_NM = 1852;

/** Web Mercator, as fractions of the world: x east from the antimeridian, y south from the top. */
export function mercator(lat: number, lon: number): [number, number] {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return [(lon + 180) / 360, (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2];
}

export interface MiniTile {
  /** Unique within one layout, so a keyed list keeps the image that is already loaded. */
  key: string;
  z: number;
  x: number;
  y: number;
  left: number;
  top: number;
  size: number;
}

/**
 * The tiles covering a `width` × `height` window centred on `centre` (from
 * `mercator`) at a fractional `zoom`, positioned in CSS pixels.
 *
 * Tiles are taken `detail` levels deeper than the zoom and drawn smaller —
 * one level is what keeps the picture sharp on a high-density screen — and
 * never deeper than the source serves. Edges are rounded so neighbouring
 * tiles share a pixel boundary: fractional ones leave hairline seams.
 */
export function coverTiles(
  centre: readonly [number, number],
  zoom: number,
  width: number,
  height: number,
  detail: number,
  maxZoom: number,
): MiniTile[] {
  const z = Math.max(0, Math.min(maxZoom, Math.floor(zoom) + detail));
  const count = 2 ** z;
  const size = TILE_PX * 2 ** (zoom - z);
  const cx = centre[0] * count;
  const cy = centre[1] * count;
  const edge = (i: number, c: number, half: number): number => Math.round(half + (i - c) * size);
  const tiles: MiniTile[] = [];
  for (let j = Math.floor(cy - height / 2 / size); j <= Math.floor(cy + height / 2 / size); j++) {
    if (j < 0 || j >= count) continue;
    const top = edge(j, cy, height / 2);
    for (let i = Math.floor(cx - width / 2 / size); i <= Math.floor(cx + width / 2 / size); i++) {
      const left = edge(i, cx, width / 2);
      // Across the antimeridian the world simply repeats.
      const x = ((i % count) + count) % count;
      tiles.push({ key: `${z}/${i}/${j}`, z, x, y: j, left, top, size: edge(i + 1, cx, width / 2) - left });
    }
  }
  return tiles;
}

/** Metres covered by one CSS pixel at this zoom and latitude. */
export function metresPerPixel(zoom: number, lat: number): number {
  return (EQUATOR_M_PER_PX * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * The zoom at which a window `widthPx` across spans about the right distance
 * for this altitude: a couple of kilometres either side on the ground — the
 * runways and the taxiways — growing to about eighty from cruise, where a
 * minute of flight is fifteen kilometres. `steps` is the visitor's own
 * adjustment, one zoom level each.
 */
export function autoZoom(altFt: number, lat: number, widthPx: number, steps = 0): number {
  const halfKm = Math.max(1.5, Math.min(90, 1.5 + Math.max(0, altFt) / 450));
  const zoom = Math.log2((EQUATOR_M_PER_PX * Math.cos((lat * Math.PI) / 180) * widthPx) / (halfKm * 2000));
  return Math.max(3, Math.min(16, zoom + steps));
}
