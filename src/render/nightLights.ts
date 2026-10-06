/**
 * City lights, at night.
 *
 * The ground's imagery is a daytime photograph, so at night it went the
 * colour of the sky and nothing else — every city on Earth switched off. What a
 * city looks like from a window at night is its *plan*: the streets as threads
 * of orange, the motorways brighter and whiter, the dark of a river or a park
 * cutting through the glow, the runways and taxiways of an airport in white and
 * blue. So the lights are drawn from the map, not guessed from the photograph.
 *
 * ## Four levels of the map, and the world
 *
 * `workers/nightmap/levels.ts` describes four squares of light centred on the
 * aircraft, each finer and smaller than the last (320, 80, 20 and 3 km a
 * side). A worker draws each from the OpenStreetMap vector tiles: roads by class, runways, built-up land and
 * building footprints, and — in the finest — every street lamp as a point.
 * Red carries warm sodium light, green warm-white glow, blue cool white.
 *
 * Under them, NASA's Black Marble (VIIRS day/night band, public domain) gives
 * the measured glow of every town — what the map's streets cannot say, how
 * much light a place really throws up. Two textures of it: the world, shipped
 * at 4096 × 2048 in `public/night`, about ten kilometres a texel; and the
 * region about the aircraft, 1024 × 1024 from NASA GIBS, about 900 m a texel, fetched only at night.
 *
 * All four are sampled by latitude and longitude, worked out in the shader from
 * the fragment's position (`cityLights`), so every terrain tile shares them
 * whatever its zoom and nothing has to be fetched per tile. A level is re-drawn
 * about the aircraft as it flies on; the new square shows the same ground as
 * the old one under the aircraft, so the swap is not seen.
 */

import { LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture } from 'three';

import { levelBounds, NIGHT_LEVELS } from '@/workers/nightmap/levels';
import { vectorTileTemplate } from './vectorTiles';
import type { NightMapRequest, NightMapResponse } from '@/workers/nightmap.worker';

const WORLD_URL = `${import.meta.env.BASE_URL ?? '/'}night/black-marble-4096.webp`;
/** NASA GIBS WMS, plate carrée. Public domain imagery; CORS-enabled. */
const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
const LAYER = 'VIIRS_Black_Marble';
/** The region's height in degrees of latitude; its width is the same distance east-west. */
const REGION_LAT_SPAN = 5;
const REGION_PX = 1024;
const REGION_RECENTRE_AT = 0.55;

/** Lights only when it is this dark (the shared night factor, 0 day … 1 night). */
const NIGHT_FROM = 0.02;
/** Re-draw a level once the aircraft is this far through it towards an edge (0 centre, 1 edge). */
const RECENTRE_AT = 0.45;
/** How far ahead of the aircraft a level is centred, in seconds of flight, capped by the level's size. */
const LEAD_S = 12;

/**
 * [0] region: west longitude, south latitude, 1 / width, 1 / height (degrees)
 * [1] x: region weight (0 none … 1 in), y: brightness
 */
const data = new Float32Array(8);
// Brightness of the lights, set against the night exposure: a lit street is
// a few times brighter than the moonlit ground, not a sheet of neon. Only the
// densest cores and the runways come near the bloom threshold.
data[5] = 1.0;

/** Per level: west, south, 1/width, 1/height of the square (degrees). Width 0 means "not drawn yet". */
const levelBox = new Float32Array(NIGHT_LEVELS.length * 4);
/** Per level: x opacity (fades in once), y texel size in metres. */
const levelFx = new Float32Array(NIGHT_LEVELS.length * 4);
NIGHT_LEVELS.forEach((level, i) => {
  levelFx[i * 4 + 1] = (level.spanKm * 1000) / level.px;
});

function makeTexture(name: string): Texture {
  const t = new Texture();
  t.colorSpace = SRGBColorSpace;
  // Mipmapped: a coarse look at a fine level averages its streets into the
  // glow they make, instead of shimmering as single texels switch on and off.
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  // From a cockpit the ground is seen at a grazing angle, where plain
  // mipmapping picks a level for the long axis of the pixel's footprint and
  // smears every street into a streak. The terrain's imagery has had
  // anisotropy from the start; the lights went without, which is most of why
  // the night looked out of focus when the day did not.
  t.anisotropy = 8;
  t.name = name;
  return t;
}

const world = makeTexture('night lights (world)');
const region = makeTexture('night lights (region)');
const levelTextures = NIGHT_LEVELS.map((_, i) => makeTexture(`night lights (level ${i})`));

// No image until loaded: three samples a texture it has never uploaded as black, which is no lights.

/**
 * Attach to a `ShaderMaterial` after construction (its constructor clones
 * texture uniforms, which would cut them off from the loads below).
 */
export function attachNightLights(uniforms: Record<string, { value: unknown }>): void {
  for (const [name, uniform] of Object.entries(NIGHT_UNIFORMS)) uniforms[name] = uniform;
}

const NIGHT_UNIFORMS: Record<string, { value: unknown }> = {
  nightLights: { value: data },
  nightWorld: { value: world },
  nightRegion: { value: region },
  nightMapBox: { value: levelBox },
  nightMapFx: { value: levelFx },
  nightMap0: { value: levelTextures[0] },
  nightMap1: { value: levelTextures[1] },
  nightMap2: { value: levelTextures[2] },
  nightMap3: { value: levelTextures[3] },
};

/** Needs `ATMO_GLSL` before it: the planet's centre and the night factor come from there. */
export const NIGHT_GLSL = /* glsl */ `
uniform vec4 nightLights[2];
uniform sampler2D nightWorld;
uniform sampler2D nightRegion;
uniform sampler2D nightMap0;
uniform sampler2D nightMap1;
uniform sampler2D nightMap2;
uniform sampler2D nightMap3;
uniform vec4 nightMapBox[4];
uniform vec4 nightMapFx[4];

float nightHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// How much of a level's square covers this point, 0 outside, ramping in at its edge.
float nightEdge(vec2 r) {
  if (r.x <= 0.0 || r.y <= 0.0 || r.x >= 1.0 || r.y >= 1.0) return 0.0;
  return smoothstep(0.0, 0.07, min(min(r.x, 1.0 - r.x), min(r.y, 1.0 - r.y)));
}

/*
 * A city from the air is points, not lines: lamps every thirty metres or so,
 * each far brighter than the street between them. The map's streets are
 * lines a texel wide, so up close they are broken into lamps here — a random
 * point in each cell of a world-fixed grid, sharp while the pixel is small
 * against the spacing — and from far off, where a pixel covers several
 * lamps, the pattern averages to exactly 1 and the street keeps the
 * brightness it had. A lamp that lands off a street lights nothing, so a
 * street shows as a dotted thread with the irregular rhythm of real ones.
 *
 * q: Mercator metres (stable as the camera moves); footprint: metres a pixel
 * covers there.
 */
float nightLamps(vec2 q, float footprint) {
  const float cell = 32.0;
  float far = smoothstep(cell * 0.35, cell * 1.4, footprint);
  if (far >= 1.0) return 1.0;
  vec2 g = q / cell;
  vec2 id = floor(g);
  vec2 f = fract(g);
  float lamps = 0.0;
  // This cell and its neighbours: a lamp near an edge lights across it.
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 at = o + vec2(nightHash(id + o), nightHash(id + o + 37.1)) * 0.8 + 0.1;
      vec2 d = f - at;
      // A lamp's pool on the ground is ten metres or so across its bright
      // part, soft-edged — a hard little disc reads as a polka dot from low
      // down — and never sharper than the pixel can show.
      float r = max(9.0, footprint * 0.6) / cell;
      lamps += exp(-dot(d, d) / (r * r)) / (3.14159 * r * r);
    }
  }
  // Each lamp's integral over the plane is 1 per cell, so the mean is 1.
  return mix(min(lamps, 3.0), 1.0, far);
}

// How much a finer level should be used at this pixel size: all of it while a
// pixel is smaller than its texels, none once a pixel is several of them.
float nightFinerThan(float texelM, float footprint) {
  return 1.0 - smoothstep(texelM * 0.8, texelM * 3.5, footprint);
}

/*
 * Emitted light at a point on the ground, linear, before aerial perspective.
 *
 * worldPos: the fragment in render space; footprint: Web Mercator metres a
 * screen pixel covers there. The caller adds the result to the lit ground.
 */
vec3 cityLights(vec3 worldPos, vec2 q, float footprint, vec3 albedo) {
  float night = atmo[5].w;
  if (night <= ${NIGHT_FROM.toFixed(3)}) return vec3(0.0);

  vec3 p = worldPos - atmo[0].xyz;
  // Geodetic latitude on the surface: the ellipsoid normal, not the radius
  // (which is a fifth of a degree out at mid latitudes — twenty kilometres).
  float lat = degrees(atan(p.z, length(p.xy) * 0.99330562));
  float lon = degrees(atan(p.y, p.x));
  // Mercator metres overstate ground distance by 1 / cos(latitude).
  float ground = footprint * cos(radians(lat));

  // The measured glow of the towns: the world at ten kilometres a texel, the
  // region about the aircraft at about 450 m. The composite's land is moonlit
  // grey-blue: only what stands above it is light.
  vec3 wc = texture2D(nightWorld, vec2(lon / 360.0 + 0.5, lat / 180.0 + 0.5)).rgb;
  vec2 rr = (vec2(lon, lat) - nightLights[0].xy) * nightLights[0].zw;
  if (nightLights[1].x > 0.0) {
    wc = mix(wc, texture2D(nightRegion, rr).rgb, nightEdge(rr) * nightLights[1].x);
  }
  float glow = smoothstep(0.03, 0.75, max(wc.r, wc.g));
  vec3 m = vec3(0.0);

  // The map, coarse to fine: each level is mixed in over the last where its
  // square covers this point and its texels are no bigger than the pixel.
  vec2 r0 = (vec2(lon, lat) - nightMapBox[0].xy) * nightMapBox[0].zw;
  float c0 = nightEdge(r0) * nightMapFx[0].x;
  if (c0 > 0.0) m = mix(m, texture2D(nightMap0, vec2(r0.x, 1.0 - r0.y)).rgb, c0);

  vec2 r1 = (vec2(lon, lat) - nightMapBox[1].xy) * nightMapBox[1].zw;
  float c1 = nightEdge(r1) * nightMapFx[1].x * nightFinerThan(nightMapFx[1].y, ground);
  if (c1 > 0.0) m = mix(m, texture2D(nightMap1, vec2(r1.x, 1.0 - r1.y)).rgb, c1);

  vec2 r2 = (vec2(lon, lat) - nightMapBox[2].xy) * nightMapBox[2].zw;
  float c2 = nightEdge(r2) * nightMapFx[2].x * nightFinerThan(nightMapFx[2].y, ground);
  if (c2 > 0.0) m = mix(m, texture2D(nightMap2, vec2(r2.x, 1.0 - r2.y)).rgb, c2);

  vec2 r3 = (vec2(lon, lat) - nightMapBox[3].xy) * nightMapBox[3].zw;
  float c3 = nightEdge(r3) * nightMapFx[3].x * nightFinerThan(nightMapFx[3].y, ground);
  if (c3 > 0.0) m = mix(m, texture2D(nightMap3, vec2(r3.x, 1.0 - r3.y)).rgb, c3);

  // What the satellite measured says how much light a place really throws up: it
  // brightens the streets where it saw more, and is the only light beyond the
  // map. On its own it would flood a whole city in one flat colour — it is
  // saturated across the whole of an urban area — so it never stands in for them.
  // Roads between towns are dark: in most of the world only built-up streets,
  // junctions and airports are lit. The satellite knows where light really
  // is, so a road it saw no light on keeps a trace of headlights and no more —
  // which is what turns a road map into a night: islands of towns in the dark.
  float urban = smoothstep(0.0, 0.3, glow);
  m *= mix(0.12, 1.0, urban) * (0.65 + glow * 0.5);
  // The lamps, but not on the finest level, which draws every lamp itself.
  m *= mix(nightLamps(q * cos(radians(lat)), ground), 1.0, c3);
  // The satellite's glow is the light a town throws up: from low down a faint
  // halo round the streets, from high up most of what a town is — a pool of
  // orange whose streets are too fine to tell apart.
  // It stands in for the streets' average where they are too fine to draw, so
  // it is no brighter than they are on average: most of a city's area is
  // roofs, yards and parks, dark between the lamps.
  float aloft = smoothstep(60.0, 450.0, ground);
  m += vec3(glow * 0.62, glow * 0.36, glow * 0.12) * mix(0.03, 0.34, aloft);

  // Measured colours, not poster ones. High-pressure sodium is a yellow-orange
  // (about 2000 K), and most European and American cities are now half LED at
  // 3000-4000 K, so from the air a city reads as a warm, slightly yellow white
  // with orange threads, not as saturated orange.
  vec3 sodium = vec3(1.0, 0.60, 0.26);
  vec3 warm = vec3(1.0, 0.84, 0.64);
  vec3 cool = vec3(0.84, 0.90, 1.0);
  vec3 light = m.r * sodium + m.g * warm * 0.85 + m.b * cool * 1.1;

  // Linear while dim — a faint glow stays faint — and rolling off as it
  // brightens, so a dense core settles under white rather than glaring.
  light = light / (1.0 + light * 1.3);

  return light * nightLights[1].y * smoothstep(${NIGHT_FROM.toFixed(3)}, 0.6, night);
}
`;

async function bitmap(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
  const res = await fetch(url, { signal, credentials: 'omit', mode: 'cors' });
  if (!res.ok) throw new Error(`night lights: ${res.status}`);
  // Flipped so that v = 0 is the south edge, as the shader reads it.
  return createImageBitmap(await res.blob(), { imageOrientation: 'flipY' });
}

/** Where the aircraft is, for deciding which levels to draw and where. */
export interface NightView {
  /** Height above the ground, metres. */
  aglM: number;
  /** The ground is still loading: fetch nothing new until it is done. */
  hold?: boolean;
  trackDeg: number;
  groundSpeedMs: number;
}

interface LevelState {
  /** Centre of the square last drawn, and its half-sizes in degrees. */
  centre: { lat: number; lon: number; latHalf: number; lonHalf: number } | null;
  loading: boolean;
  /** Level has been fetched at least once: from then on it is only re-centred, never faded again. */
  everDrawn: boolean;
}

/** Keeps the night map about the aircraft, at night. */
export class NightLights {
  private worldLoading = false;
  private regionCentre: { lat: number; lon: number; latHalf: number; lonHalf: number } | null = null;
  private regionLoading: AbortController | null = null;
  private regionTarget = 0;
  private template: string | null = null;
  private templateLoading = false;
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly inFlight = new Map<number, number>();
  private readonly levels: LevelState[] = NIGHT_LEVELS.map(() => ({ centre: null, loading: false, everDrawn: false }));
  private disposed = false;

  /** Call once a frame with where the aircraft is and the night factor. */
  update(lat: number, lon: number, night: number, dt: number, view?: NightView): void {
    if (this.disposed) return;
    // By day nothing is fetched at all.
    if (night <= NIGHT_FROM) return;
    if (view?.hold) return;
    if (!this.worldLoading) this.loadWorld();

    // A negative or absurd step (a stalled tab, a clock that jumped back) must not
    // push the fade out of 0..1: a NaN here is a NaN in every terrain uniform.
    data[4] += (this.regionTarget - data[4]) * Math.min(1, Math.max(0, dt) * 1.5);
    const rc = this.regionCentre;
    const regionNear =
      rc !== null &&
      Math.abs(lat - rc.lat) < rc.latHalf * REGION_RECENTRE_AT &&
      Math.abs(lonDelta(rc.lon, lon)) < rc.lonHalf * REGION_RECENTRE_AT;
    if (!regionNear && !this.regionLoading) void this.loadRegion(lat, lon);

    if (!this.template) {
      void this.loadTemplate();
      return;
    }

    const agl = view?.aglM ?? 0;
    const speed = view?.groundSpeedMs ?? 0;
    const track = ((view?.trackDeg ?? 0) * Math.PI) / 180;

    // Finest first when low, coarsest first when high: what the window shows.
    const order = agl < 2500 ? [3, 2, 1, 0] : agl < 7000 ? [2, 1, 0, 3] : agl < 16_000 ? [1, 0, 2, 3] : [0, 1, 2, 3];

    for (let i = 0; i < NIGHT_LEVELS.length; i++) {
      const level = NIGHT_LEVELS[i]!;
      const state = this.levels[i]!;
      // Fades in the first time, and out of the way of a level too fine to matter from here.
      const want = agl <= level.maxAglM && state.everDrawn ? 1 : 0;
      const fx = i * 4;
      levelFx[fx] = levelFx[fx]! + (want - levelFx[fx]!) * Math.min(1, Math.max(0, dt) * 1.4);
    }

    if (this.inFlight.size > 0) return;
    for (const i of order) {
      const level = NIGHT_LEVELS[i]!;
      const state = this.levels[i]!;
      if (agl > level.maxAglM || state.loading) continue;

      // Centred a little ahead, so the square is where the aircraft is going.
      const kmAhead = Math.min(level.spanKm * 0.2, (speed * LEAD_S) / 1000);
      const aheadLat = lat + (kmAhead / 111.32) * Math.cos(track);
      const aheadLon = lon + (kmAhead / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))) * Math.sin(track);

      const c = state.centre;
      const near =
        c !== null &&
        Math.abs(lat - c.lat) < c.latHalf * RECENTRE_AT &&
        Math.abs(lonDelta(c.lon, lon)) < c.lonHalf * RECENTRE_AT;
      if (near) continue;
      this.request(i, aheadLat, aheadLon);
      return; // one at a time: the worker is one core, and the render loop is the point
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
    const bounds = levelBounds(NIGHT_LEVELS[level]!, lat, lon);
    state.centre = {
      lat: (bounds.south + bounds.north) / 2,
      lon: (bounds.west + bounds.east) / 2,
      latHalf: (bounds.north - bounds.south) / 2,
      lonHalf: (bounds.east - bounds.west) / 2,
    };
    this.worker.postMessage({ id, level, lat, lon, template } satisfies NightMapRequest);
  }

  private spawn(): Worker {
    const worker = new Worker(new URL('../workers/nightmap.worker.ts', import.meta.url), {
      type: 'module',
      name: 'planesview-nightmap',
    });
    worker.onmessage = (e: MessageEvent<NightMapResponse>) => this.receive(e.data);
    worker.onerror = () => {
      // A worker that cannot start leaves the night as the world's glow alone.
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
    if (!msg.ok) {
      // Retried when the aircraft has moved far enough to ask again; never in a tight loop.
      return;
    }
    if (this.disposed) return msg.bitmap.close();

    const texture = levelTextures[index]!;
    const old = texture.image;
    replaceImage(texture, msg.bitmap);
    if (old instanceof ImageBitmap) old.close();

    const b = index * 4;
    levelBox[b] = msg.west;
    levelBox[b + 1] = msg.south;
    levelBox[b + 2] = 1 / (msg.east - msg.west);
    levelBox[b + 3] = 1 / (msg.north - msg.south);
    state.everDrawn = true;
  }

  private loadWorld(): void {
    this.worldLoading = true;
    bitmap(WORLD_URL)
      .then((img) => {
        if (this.disposed) return img.close();
        replaceImage(world, img);
      })
      // Decoration: without it the night is merely dark, as it was.
      .catch(() => undefined);
  }

  private async loadRegion(lat: number, lon: number): Promise<void> {
    const latHalf = REGION_LAT_SPAN / 2;
    // The same ground distance east-west, so texels come out square.
    const lonHalf = Math.min(30, latHalf / Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
    const south = Math.max(-90, lat - latHalf);
    const north = Math.min(90, lat + latHalf);
    // Kept clear of the antimeridian: the shader does not wrap the region.
    const west = Math.max(-180, Math.min(180 - 2 * lonHalf, lon - lonHalf));
    const east = west + 2 * lonHalf;

    const controller = new AbortController();
    this.regionLoading = controller;
    const params = new URLSearchParams({
      SERVICE: 'WMS',
      VERSION: '1.3.0',
      REQUEST: 'GetMap',
      FORMAT: 'image/jpeg',
      LAYERS: LAYER,
      STYLES: '',
      CRS: 'EPSG:4326',
      // WMS 1.3.0 in EPSG:4326 is latitude first.
      BBOX: `${south.toFixed(4)},${west.toFixed(4)},${north.toFixed(4)},${east.toFixed(4)}`,
      WIDTH: String(REGION_PX),
      HEIGHT: String(REGION_PX),
    });
    try {
      const img = await bitmap(`${GIBS_WMS}?${params}`, controller.signal);
      if (this.disposed) return img.close();
      const old = region.image;
      replaceImage(region, img);
      if (old instanceof ImageBitmap) old.close();
      data[0] = west;
      data[1] = south;
      data[2] = 1 / (east - west);
      data[3] = 1 / (north - south);
      this.regionCentre = { lat: (south + north) / 2, lon: (west + east) / 2, latHalf: (north - south) / 2, lonHalf };
      this.regionTarget = 1;
      // Faded in from nothing rather than over the previous region's placement.
      data[4] = 0;
    } catch {
      // Try again on a later frame once the aircraft has moved on; never in a tight loop.
      this.regionCentre = { lat, lon, latHalf, lonHalf };
    } finally {
      if (this.regionLoading === controller) this.regionLoading = null;
    }
  }

  /** The vector tiles' current URL, once it is known. */
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
    this.regionLoading?.abort();
  }
}

/**
 * A new image of a different size into the same texture object, so every
 * material holding it sees the change. The GPU side has to go first: three
 * allocates a texture's storage once, at the size of its first image, and a
 * different-sized image uploaded into it afterwards is silently dropped.
 */
function replaceImage(texture: Texture, img: ImageBitmap): void {
  texture.dispose();
  texture.image = img;
  texture.needsUpdate = true;
}

function lonDelta(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}
