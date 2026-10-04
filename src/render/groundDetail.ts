/**
 * Sharp ground, from the map, over imagery that is soft.
 *
 * See `workers/nightmap/ground.ts` for what is drawn and why. This is the page
 * side: it keeps two squares of it centred on the aircraft (a worker draws
 * each from the OpenStreetMap vector tiles, as it does the night map), and the
 * GLSL the terrain shader paints them over the photograph with.
 *
 * The shader decides *where*, not this class. A tile whose imagery is already
 * sharp — a national orthophoto, a few metres a pixel or less — takes none of
 * it; the soft global mosaic takes all of it up close, fading out with
 * distance as a pixel grows beyond what the detail can resolve.
 */

import { LinearFilter, LinearMipmapLinearFilter, Texture } from 'three';

import { GROUND_LEVELS } from '@/workers/nightmap/ground';
import { levelBounds } from '@/workers/nightmap/levels';
import type { NightMapRequest, NightMapResponse } from '@/workers/nightmap.worker';
import { vectorTileTemplate } from './vectorTiles';

/** Re-draw a level once the aircraft is this far through it towards an edge (0 centre, 1 edge). */
const RECENTRE_AT = 0.4;
/** How far ahead of the aircraft a level is centred, in seconds of flight, capped by the level's size. */
const LEAD_S = 10;

/** Per level: west, south, 1/width, 1/height of the square (degrees). Width 0 means "not drawn yet". */
const levelBox = new Float32Array(GROUND_LEVELS.length * 4);
/** Per level: x opacity (fades in once), y texel size in metres. */
const levelFx = new Float32Array(GROUND_LEVELS.length * 4);
GROUND_LEVELS.forEach((level, i) => {
  levelFx[i * 4 + 1] = (level.spanKm * 1000) / level.px;
});

function makeTexture(name: string): Texture {
  const t = new Texture();
  // Colours are stored premultiplied by coverage (see the shader), so that
  // averaging texels into mipmaps averages light, not light and black.
  t.premultiplyAlpha = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.name = name;
  return t;
}

const levelTextures = GROUND_LEVELS.map((_, i) => makeTexture(`ground detail (level ${i})`));

const GROUND_UNIFORMS: Record<string, { value: unknown }> = {
  groundBox: { value: levelBox },
  groundFx: { value: levelFx },
  groundMap0: { value: levelTextures[0] },
  groundMap1: { value: levelTextures[1] },
};

/** Attach to a `ShaderMaterial` after construction, like `attachNightLights`. */
export function attachGroundDetail(uniforms: Record<string, { value: unknown }>): void {
  for (const [name, uniform] of Object.entries(GROUND_UNIFORMS)) uniforms[name] = uniform;
}

/** Needs `ATMO_GLSL` and `NIGHT_GLSL` (for `nightEdge`) before it. */
export const GROUND_GLSL = /* glsl */ `
uniform sampler2D groundMap0;
uniform sampler2D groundMap1;
uniform vec4 groundBox[2];
uniform vec4 groundFx[2];

// Premultiplied colour and coverage of one level here, its edges kept crisp
// while a pixel is smaller than the level's texels: a road two texels wide,
// stretched, would otherwise be a soft grey smear.
vec4 groundSample(sampler2D map, vec2 r, float texel, float ground) {
  vec4 t = texture2D(map, vec2(r.x, 1.0 - r.y));
  float k = clamp(texel / max(ground, 0.01), 1.0, 3.0);
  if (k > 1.05 && t.a > 0.002) {
    vec3 c = t.rgb / t.a;
    float a = clamp((t.a - 0.5) * k + 0.5, 0.0, 1.0);
    t = vec4(c * a, a);
  }
  return t;
}

/*
 * The photograph's colour with the map's roads, rails, runways and roofs
 * painted on it. albedo: linear; texelM: Web Mercator metres of one texel of
 * the imagery drawn here; footprint: the same for one screen pixel.
 */
vec3 groundApply(vec3 albedo, vec3 worldPos, float footprint, float texelM) {
  if (groundFx[0].x + groundFx[1].x <= 0.002) return albedo;

  vec3 p = worldPos - atmo[0].xyz;
  float lat = degrees(atan(p.z, length(p.xy) * 0.99330562));
  float lon = degrees(atan(p.y, p.x));
  float cosLat = cos(radians(lat));
  float ground = footprint * cosLat;

  // Only where the imagery is soft, and only while the screen can resolve the detail.
  float soft = smoothstep(2.5, 5.0, texelM * cosLat) * (1.0 - smoothstep(40.0, 160.0, ground));
  if (soft <= 0.0) return albedo;

  vec4 g = vec4(0.0);
  vec2 r0 = (vec2(lon, lat) - groundBox[0].xy) * groundBox[0].zw;
  float c0 = nightEdge(r0) * groundFx[0].x;
  if (c0 > 0.0) g = groundSample(groundMap0, r0, groundFx[0].y, ground) * c0;

  vec2 r1 = (vec2(lon, lat) - groundBox[1].xy) * groundBox[1].zw;
  float c1 = nightEdge(r1) * groundFx[1].x;
  if (c1 > 0.0) g = mix(g, groundSample(groundMap1, r1, groundFx[1].y, ground), c1);

  float a = g.a * soft;
  if (a <= 0.002) return albedo;
  // Straight colour back out of the premultiplied pair, sRGB to linear.
  vec3 paint = pow(g.rgb / max(g.a, 0.002), vec3(2.2));
  return mix(albedo, paint, a);
}
`;

interface LevelState {
  centre: { lat: number; lon: number; latHalf: number; lonHalf: number } | null;
  loading: boolean;
  everDrawn: boolean;
}

/** Where the aircraft is, for deciding which levels to draw and where. */
export interface GroundView {
  aglM: number;
  /** The ground is still loading: fetch nothing new until it is done. */
  hold?: boolean;
  trackDeg: number;
  groundSpeedMs: number;
}

/** Keeps the ground detail about the aircraft. */
export class GroundDetail {
  private template: string | null = null;
  private templateLoading = false;
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly inFlight = new Map<number, number>();
  private readonly levels: LevelState[] = GROUND_LEVELS.map(() => ({ centre: null, loading: false, everDrawn: false }));
  private disposed = false;

  /** Call once a frame. */
  update(lat: number, lon: number, dt: number, view: GroundView): void {
    if (this.disposed) return;
    const agl = view.aglM;
    for (let i = 0; i < GROUND_LEVELS.length; i++) {
      // Fades in the first time, and out of the way of a level too coarse to help from up here.
      const want = agl <= GROUND_LEVELS[i]!.maxAglM && this.levels[i]!.everDrawn ? 1 : 0;
      levelFx[i * 4] = levelFx[i * 4]! + (want - levelFx[i * 4]!) * Math.min(1, Math.max(0, dt) * 1.6);
    }
    if (agl > GROUND_LEVELS[0]!.maxAglM || view.hold) return;

    if (!this.template) {
      void this.loadTemplate();
      return;
    }
    if (this.inFlight.size > 0) return;

    // Finest first when low.
    const order = agl < 2_000 ? [1, 0] : [0, 1];
    const track = (view.trackDeg * Math.PI) / 180;
    for (const i of order) {
      const level = GROUND_LEVELS[i]!;
      const state = this.levels[i]!;
      if (agl > level.maxAglM || state.loading) continue;

      const kmAhead = Math.min(level.spanKm * 0.2, (view.groundSpeedMs * LEAD_S) / 1000);
      const aheadLat = lat + (kmAhead / 111.32) * Math.cos(track);
      const aheadLon = lon + (kmAhead / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))) * Math.sin(track);

      const c = state.centre;
      const near =
        c !== null &&
        Math.abs(lat - c.lat) < c.latHalf * RECENTRE_AT &&
        Math.abs(lonDelta(c.lon, lon)) < c.lonHalf * RECENTRE_AT;
      if (near) continue;
      this.request(i, aheadLat, aheadLon);
      return;
    }
  }

  private request(level: number, lat: number, lon: number): void {
    const template = this.template;
    if (!template) return;
    this.worker ??= this.spawn();
    const id = this.nextId++;
    this.inFlight.set(id, level);
    const state = this.levels[level]!;
    state.loading = true;
    // Whatever happens, ask again only after the aircraft has moved on.
    const bounds = levelBounds(GROUND_LEVELS[level]!, lat, lon);
    state.centre = {
      lat: (bounds.south + bounds.north) / 2,
      lon: (bounds.west + bounds.east) / 2,
      latHalf: (bounds.north - bounds.south) / 2,
      lonHalf: (bounds.east - bounds.west) / 2,
    };
    this.worker.postMessage({ id, mode: 'ground', level, lat, lon, template } satisfies NightMapRequest);
  }

  private spawn(): Worker {
    const worker = new Worker(new URL('../workers/nightmap.worker.ts', import.meta.url), {
      type: 'module',
      name: 'planesview-groundmap',
    });
    worker.onmessage = (e: MessageEvent<NightMapResponse>) => this.receive(e.data);
    worker.onerror = () => {
      for (const state of this.levels) state.loading = false;
      this.inFlight.clear();
    };
    return worker;
  }

  private receive(msg: NightMapResponse): void {
    const index = this.inFlight.get(msg.id);
    this.inFlight.delete(msg.id);
    if (index === undefined) return;
    const state = this.levels[index]!;
    state.loading = false;
    if (!msg.ok) return;
    if (this.disposed) return msg.bitmap.close();

    const texture = levelTextures[index]!;
    const old = texture.image;
    // See `replaceImage` in nightLights: the GPU copy has to go before a new size can come.
    texture.dispose();
    texture.image = msg.bitmap;
    texture.needsUpdate = true;
    if (old instanceof ImageBitmap) old.close();

    const b = index * 4;
    levelBox[b] = msg.west;
    levelBox[b + 1] = msg.south;
    levelBox[b + 2] = 1 / (msg.east - msg.west);
    levelBox[b + 3] = 1 / (msg.north - msg.south);
    state.everDrawn = true;
  }

  private async loadTemplate(): Promise<void> {
    if (this.templateLoading) return;
    this.templateLoading = true;
    try {
      this.template = await vectorTileTemplate();
    } finally {
      this.templateLoading = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
  }
}

function lonDelta(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}
