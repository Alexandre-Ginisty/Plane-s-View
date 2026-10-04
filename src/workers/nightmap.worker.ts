/**
 * Night map worker: draw one level of the lights of a place.
 *
 * Fetches the vector tiles that cover a square about the aircraft, reads their
 * roads, runways, buildings and built-up land, and draws them additively onto
 * a canvas — red for warm street light, green for warm-white glow, blue for
 * cool white — which goes back to the page as an `ImageBitmap` the terrain
 * shader samples. All of it off the main thread: a dense city tile is a
 * megabyte of protocol buffer and a few thousand strokes.
 */

import { coveringTiles, levelBounds, NIGHT_LEVELS } from './nightmap/levels';
import { GROUND_LEVELS, groundAerowayAreaRgb, groundAerowayStyle, groundRoadStyle, roofColour } from './nightmap/ground';
import { readNightLayers, type VectorFeature } from './nightmap/layers';
import { makeProjector } from './nightmap/project';
import { aerowayAreaStyle, aerowayStyle, landuseStyle, pointsAlong, roadStyle, thinLineGain } from './nightmap/style';

export interface NightMapRequest {
  id: number;
  /** Which set of levels `level` indexes: the lights of the night, or the ground by day. */
  mode?: 'night' | 'ground';
  level: number;
  lat: number;
  lon: number;
  /** Vector tile URL with `{z}`, `{x}`, `{y}`. */
  template: string;
}

export type NightMapResponse =
  | {
      id: number;
      ok: true;
      level: number;
      mode: 'night' | 'ground';
      bitmap: ImageBitmap;
      south: number;
      north: number;
      west: number;
      east: number;
    }
  | { id: number; ok: false };

/** The tile host is checked here as well as where the URL is built. */
const ALLOWED = new Set(['tiles.openfreemap.org']);

/** Raw tiles kept for the next redraw: the aircraft moves, the tiles it needs mostly do not. */
const CACHE_LIMIT = 48;
const cache = new Map<string, Uint8Array>();

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  if (raw[0] === 0x1f && raw[1] === 0x8b && typeof DecompressionStream === 'function') {
    const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return raw;
}

async function tileBytes(template: string, z: number, x: number, y: number): Promise<Uint8Array | null> {
  const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !ALLOWED.has(parsed.hostname)) throw new Error('host');
  const res = await fetch(parsed, { cache: 'force-cache', credentials: 'omit' });
  if (!res.ok) return null;
  const bytes = await inflate(new Uint8Array(await res.arrayBuffer()));
  cache.set(key, bytes);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return bytes;
}

const channel = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
const rgb = (r: number, g: number, b: number): string => `rgb(${channel(r)},${channel(g)},${channel(b)})`;

/** Spacing of street lamps along a road, metres. Motorways are lit further apart, by taller masts. */
function lampSpacing(kind: string): number {
  return kind === 'motorway' || kind === 'trunk' ? 42 : 28;
}

function draw(
  ctx: OffscreenCanvasRenderingContext2D,
  features: VectorFeature[],
  extent: number,
  zoom: number,
  tile: { x: number; y: number },
  bounds: { south: number; north: number; west: number; east: number },
  px: number,
  texelM: number,
  lamps: boolean,
  buildings: boolean,
  landuse: boolean,
): void {
  const { toPx, visible, trace: traceRings } = makeProjector(extent, zoom, tile, bounds, px);
  const trace = (rings: number[][]): void => traceRings(ctx, rings);
  const polygons = (layer: string, fill: (f: VectorFeature) => string | null, mode: GlobalCompositeOperation): void => {
    ctx.globalCompositeOperation = mode;
    for (const f of features) {
      if (f.layer !== layer || f.type !== 3) continue;
      const colour = fill(f);
      if (!colour) continue;
      const rings = f.paths.map(toPx);
      if (!rings.some(visible)) continue;
      ctx.fillStyle = colour;
      trace(rings);
      ctx.fill('evenodd');
    }
  };

  // 1. Where it is built up.
  if (landuse) {
    polygons(
      'landuse',
      (f) => {
        const a = landuseStyle(f.kind);
        return a ? rgb(a.warm, a.glow, a.cool) : null;
      },
      'lighter',
    );
  }
  if (buildings) polygons('building', () => rgb(0.1, 0.2, 0.02), 'lighter');
  // Aprons and helipads are floodlit at every scale.
  polygons(
    'aeroway',
    (f) => {
      const a = aerowayAreaStyle(f.kind);
      return a ? rgb(a.warm, a.glow, a.cool) : null;
    },
    'lighter',
  );

  // 2. Water is dark, and cuts the glow of what is built beside it.
  polygons('water', () => '#000', 'source-over');

  // 3. The lines.
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const f of features) {
    if (f.type !== 2) continue;
    // A tunnel is dark; a bridge is lit like the road it carries.
    if (f.structure === 'tunnel') continue;
    const style = f.layer === 'transportation' ? roadStyle(f.kind) : f.layer === 'aeroway' ? aerowayStyle(f.kind) : null;
    if (!style) continue;

    const gain = thinLineGain(style.widthM, texelM);
    const widthPx = Math.max(0.9, style.widthM / texelM);
    for (const path of f.paths) {
      const p = toPx(path);
      if (!visible(p)) continue;

      // Close in, the lamps are points; the line under them is only the glow.
      const lineGain = lamps && f.layer === 'transportation' ? 0.28 : 1;
      ctx.strokeStyle = rgb(style.warm * gain * lineGain, 0, style.cool * gain * lineGain);
      ctx.lineWidth = widthPx;
      ctx.beginPath();
      ctx.moveTo(p[0]!, p[1]!);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
      ctx.stroke();

      if (lamps && f.layer === 'transportation') {
        // A lamp is a point of light a couple of metres across, not a texel-sized lump.
        const radius = Math.max(0.8, 1.1 / texelM);
        ctx.fillStyle = rgb(style.warm, style.warm * 0.12, style.cool);
        for (const [x, y] of pointsAlong(p, lampSpacing(f.kind) / texelM)) {
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
}


/**
 * The ground: roads, rail, runways and building footprints as flat colour
 * with alpha, drawn in order of importance so a motorway lies over a lane.
 */
function drawGround(
  ctx: OffscreenCanvasRenderingContext2D,
  features: VectorFeature[],
  extent: number,
  zoom: number,
  tile: { x: number; y: number },
  bounds: { south: number; north: number; west: number; east: number },
  px: number,
  texelM: number,
  footprints: boolean,
): void {
  const { toPx, visible, trace: traceRings } = makeProjector(extent, zoom, tile, bounds, px);
  const css = (c: readonly [number, number, number], a: number): string =>
    `rgba(${channel(c[0])},${channel(c[1])},${channel(c[2])},${a})`;
  ctx.globalCompositeOperation = 'source-over';

  // Aprons first, then the roofs on them.
  for (const f of features) {
    if (f.layer !== 'aeroway' || f.type !== 3) continue;
    const c = groundAerowayAreaRgb(f.kind);
    if (!c) continue;
    const rings = f.paths.map(toPx);
    if (!rings.some(visible)) continue;
    ctx.fillStyle = css(c, 0.88);
    traceRings(ctx, rings);
    ctx.fill('evenodd');
  }
  if (footprints) {
    for (const f of features) {
      if (f.layer !== 'building' || f.type !== 3) continue;
      const rings = f.paths.map(toPx);
      if (!rings.some(visible)) continue;
      const first = f.paths[0]!;
      ctx.fillStyle = css(roofColour(first[0]! * 31 + first[1]! * 17), 0.9);
      traceRings(ctx, rings);
      ctx.fill('evenodd');
    }
  }

  // Lines, least important first.
  const lines: { style: NonNullable<ReturnType<typeof groundRoadStyle>>; f: VectorFeature }[] = [];
  for (const f of features) {
    if (f.type !== 2 || f.structure === 'tunnel') continue;
    const style = f.layer === 'transportation' ? groundRoadStyle(f.kind) : f.layer === 'aeroway' ? groundAerowayStyle(f.kind) : null;
    if (style) lines.push({ style, f });
  }
  lines.sort((a, b) => a.style.rank - b.style.rank);

  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  const stroke = (p: number[]): void => {
    ctx.beginPath();
    ctx.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
    ctx.stroke();
  };
  for (const { style, f } of lines) {
    // A road narrower than a pixel is drawn a pixel wide and fainter, so it still thins into the far field.
    const widthPx = style.widthM / texelM;
    const w = Math.max(1, widthPx);
    const a = style.alpha * Math.min(1, widthPx);
    for (const path of f.paths) {
      const p = toPx(path);
      if (!visible(p)) continue;
      // Edge, then surface: a darker, slightly wider line under the road gives it a verge.
      if (widthPx >= 2.5) {
        ctx.strokeStyle = css([style.rgb[0] * 0.6, style.rgb[1] * 0.6, style.rgb[2] * 0.6], a * 0.55);
        ctx.lineWidth = w + 1.6;
        stroke(p);
      }
      ctx.strokeStyle = css(style.rgb, a);
      ctx.lineWidth = w;
      stroke(p);
      if (f.layer === 'aeroway' && widthPx >= 6) {
        // The centreline: white on a runway, yellow on a taxiway.
        ctx.strokeStyle = f.kind === 'runway' ? 'rgba(235,235,230,0.9)' : 'rgba(225,190,60,0.9)';
        ctx.lineWidth = Math.max(1, (f.kind === 'runway' ? 0.9 : 0.25) / texelM);
        ctx.setLineDash(f.kind === 'runway' ? [30 / texelM, 20 / texelM] : []);
        stroke(p);
        ctx.setLineDash([]);
      }
    }
  }
}

self.onmessage = async (event: MessageEvent<NightMapRequest>) => {
  const { id, level: index, lat, lon, template } = event.data;
  const mode = event.data.mode ?? 'night';
  const post = (msg: NightMapResponse, transfer: Transferable[] = []): void =>
    (self as unknown as Worker).postMessage(msg, transfer);
  try {
    const level = mode === 'ground' ? GROUND_LEVELS[index] : NIGHT_LEVELS[index];
    if (!level) throw new Error('level');
    const bounds = levelBounds(level, lat, lon);
    const tiles = coveringTiles(bounds, level.zoom);

    const decoded = await Promise.all(
      tiles.map(async (t) => {
        const bytes = await tileBytes(template, level.zoom, t.x, t.y);
        return bytes ? { tile: t, layers: readNightLayers(bytes) } : null;
      }),
    );

    const canvas = new OffscreenCanvas(level.px, level.px);
    const ctx = canvas.getContext('2d', { alpha: mode === 'ground' });
    if (!ctx) throw new Error('2d');
    if (mode === 'night') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, level.px, level.px);
    }

    const texelM = (level.spanKm * 1000) / level.px;
    for (const d of decoded) {
      if (!d) continue;
      if (mode === 'ground') {
        const footprints = (level as (typeof GROUND_LEVELS)[number]).footprints;
        drawGround(ctx, d.layers.features, d.layers.extent, level.zoom, d.tile, bounds, level.px, texelM, footprints);
      } else {
        draw(ctx, d.layers.features, d.layers.extent, level.zoom, d.tile, bounds, level.px, texelM, level.lamps, level.buildings, level.landuse);
      }
    }

    const bitmap = canvas.transferToImageBitmap();
    post({ id, ok: true, level: index, mode, bitmap, ...bounds }, [bitmap]);
  } catch {
    post({ id, ok: false });
  }
};
