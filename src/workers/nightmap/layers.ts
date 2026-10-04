/**
 * The layers of a vector tile that make light at night: roads, runways,
 * buildings, built-up land and water.
 *
 * Like the rest of the night map it uses `mvt.ts` — whose protocol-buffer cursor this reuses — it reads
 * only what it needs and steps over the rest, which for a city tile is most of
 * the bytes (labels, points of interest, every path and footway in the park).
 */

import { Pbf, readValue, zigzag, decodeRings, type Value } from './mvt';

/** The layers worth decoding, by name. */
const WANTED = new Set(['transportation', 'aeroway', 'building', 'landuse', 'water']);

export interface VectorFeature {
  layer: string;
  /** 2 = line, 3 = polygon. */
  type: 2 | 3;
  /** The one tag that classifies it: `class` (`subclass` for landuse where `class` is empty). */
  kind: string;
  /** `bridge`, `tunnel`, `ford` or ''. */
  structure: string;
  /** Lines: one polyline each. Polygons: outer ring then holes. Flat x,y pairs in tile units. */
  paths: Float64Array[];
}

export interface VectorTileLayers {
  extent: number;
  features: VectorFeature[];
}

/** Open polylines of a line feature's geometry commands. */
function decodeLines(cmds: number[]): Float64Array[] {
  const lines: Float64Array[] = [];
  let x = 0;
  let y = 0;
  let line: number[] = [];
  for (let i = 0; i < cmds.length; ) {
    const c = cmds[i++]!;
    const id = c & 7;
    const count = c >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count && i + 1 < cmds.length; k++) {
        x += zigzag(cmds[i++]!);
        y += zigzag(cmds[i++]!);
        if (id === 1) {
          if (line.length >= 4) lines.push(Float64Array.from(line));
          line = [];
        }
        line.push(x, y);
      }
    }
  }
  if (line.length >= 4) lines.push(Float64Array.from(line));
  return lines;
}

function readLayer(layer: Pbf, extentOut: { extent: number }, features: VectorFeature[]): void {
  let name = '';
  const keys: string[] = [];
  const values: Value[] = [];
  const raw: Pbf[] = [];
  while (!layer.end) {
    const tag = layer.varint();
    const field = tag >> 3;
    if (field === 1) {
      name = layer.string();
      if (!WANTED.has(name)) return;
    } else if (field === 2) raw.push(layer.message());
    else if (field === 3) keys.push(layer.string());
    else if (field === 4) values.push(readValue(layer.message()));
    else if (field === 5) extentOut.extent = layer.varint();
    else layer.skip(tag & 7);
  }
  if (!WANTED.has(name)) return;

  for (const f of raw) {
    let type = 0;
    let tags: number[] = [];
    let geometry: number[] = [];
    while (!f.end) {
      const tag = f.varint();
      const field = tag >> 3;
      if (field === 2) tags = f.packed();
      else if (field === 3) type = f.varint();
      else if (field === 4) geometry = f.packed();
      else f.skip(tag & 7);
    }
    if (type !== 2 && type !== 3) continue;

    let kind = '';
    let subclass = '';
    let structure = '';
    for (let i = 0; i + 1 < tags.length; i += 2) {
      const key = keys[tags[i]!];
      const value = values[tags[i + 1]!];
      if (typeof value === 'string') {
        if (key === 'class') kind = value;
        else if (key === 'subclass') subclass = value;
        else if (key === 'brunnel') structure = value;
      }
    }
    // Landuse is classified by `class` where mapped, else by `subclass`.
    if (name === 'landuse' && !kind) kind = subclass;

    const paths = type === 2 ? decodeLines(geometry) : decodeRings(geometry);
    if (paths.length > 0) features.push({ layer: name, type, kind, structure, paths });
  }
}

/** The light-making layers of a tile. Empty, not an error, for a tile that has none. */
export function readNightLayers(bytes: Uint8Array): VectorTileLayers {
  const tile = new Pbf(bytes);
  const out: VectorTileLayers = { extent: 4096, features: [] };
  const extent = { extent: 4096 };
  while (!tile.end) {
    const tag = tile.varint();
    if (tag >> 3 === 3 && (tag & 7) === 2) readLayer(tile.message(), extent, out.features);
    else tile.skip(tag & 7);
  }
  out.extent = extent.extent;
  return out;
}
