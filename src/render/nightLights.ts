/**
 * City lights, at night.
 *
 * The ground's imagery is a daytime photograph, so at night it went the
 * colour of the sky and nothing else — every city on Earth switched off. The
 * lights come from NASA's Black Marble (VIIRS day/night band, 2016 composite),
 * which is public domain and is exactly what the ground looks like from a
 * window seat at night: the street grids of the towns, the motorways between
 * them, the dark of the countryside and the sea.
 *
 * ## Two textures
 *
 *  - **The world**, 4096 × 2048, shipped with the app (`public/night`): about
 *    ten kilometres a texel, the glow of a city seen from cruise.
 *  - **The region about the aircraft**, 2048 × 2048 from NASA GIBS, at the
 *    composite's own resolution (about 450 m): the shape of the city when
 *    descending into it. Fetched only at night, re-centred when the aircraft
 *    nears its edge, faded in over the world's.
 *
 * Both are sampled by latitude and longitude, worked out in the shader from the
 * fragment's position (`cityLights`), so every terrain tile shares them
 * whatever its zoom and nothing has to be fetched per tile.
 */

import { LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture } from 'three';

/** NASA GIBS WMS, plate carrée. Public domain imagery; CORS-enabled. */
const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
const LAYER = 'VIIRS_Black_Marble';
const WORLD_URL = `${import.meta.env.BASE_URL ?? '/'}night/black-marble-4096.webp`;

/** The region's height in degrees of latitude; its width is the same distance east-west. */
const REGION_LAT_SPAN = 5;
const REGION_PX = 2048;
/** Re-centre once the aircraft is this far through the region towards an edge (0 centre, 1 edge). */
const RECENTRE_AT = 0.55;
/** Lights only when it is this dark (the shared night factor, 0 day … 1 night). */
const NIGHT_FROM = 0.02;

/**
 * [0] region: west longitude, south latitude, 1 / width, 1 / height (degrees)
 * [1] x: region weight (0 none … 1 in), y: brightness
 */
const data = new Float32Array(8);
data[5] = 1.5;

const world = new Texture();
world.colorSpace = SRGBColorSpace;
world.minFilter = LinearMipmapLinearFilter;
world.magFilter = LinearFilter;
world.name = 'night lights (world)';

const region = new Texture();
region.colorSpace = SRGBColorSpace;
region.minFilter = LinearMipmapLinearFilter;
region.magFilter = LinearFilter;
region.name = 'night lights (region)';

// No image until loaded: three samples a texture it has never uploaded as black, which is no lights.

/**
 * Attach to a `ShaderMaterial` after construction (its constructor clones
 * texture uniforms, which would cut them off from the loads below).
 */
export function attachNightLights(uniforms: Record<string, { value: unknown }>): void {
  uniforms['nightLights'] = NIGHT_UNIFORMS.nightLights;
  uniforms['nightWorld'] = NIGHT_UNIFORMS.nightWorld;
  uniforms['nightRegion'] = NIGHT_UNIFORMS.nightRegion;
}

const NIGHT_UNIFORMS = {
  nightLights: { value: data },
  nightWorld: { value: world },
  nightRegion: { value: region },
};

/** Needs `ATMO_GLSL` before it: the planet's centre and the night factor come from there. */
export const NIGHT_GLSL = /* glsl */ `
uniform vec4 nightLights[2];
uniform sampler2D nightWorld;
uniform sampler2D nightRegion;

float nightHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// How lit the ground is here, 0..1, from the composite.
float nightIntensity(vec3 worldPos) {
  vec3 p = worldPos - atmo[0].xyz;
  // Geodetic latitude on the surface: the ellipsoid normal, not the radius
  // (which is a fifth of a degree out at mid latitudes — twenty kilometres).
  float lat = degrees(atan(p.z, length(p.xy) * 0.99330562));
  float lon = degrees(atan(p.y, p.x));
  vec3 c = texture2D(nightWorld, vec2(lon / 360.0 + 0.5, lat / 180.0 + 0.5)).rgb;
  vec2 r = (vec2(lon, lat) - nightLights[0].xy) * nightLights[0].zw;
  if (nightLights[1].x > 0.0 && r.x > 0.0 && r.y > 0.0 && r.x < 1.0 && r.y < 1.0) {
    float edge = min(min(r.x, 1.0 - r.x), min(r.y, 1.0 - r.y));
    c = mix(c, texture2D(nightRegion, r).rgb, smoothstep(0.0, 0.06, edge) * nightLights[1].x);
  }
  // The composite's land is moonlit grey-blue: only what stands above it is light.
  return smoothstep(0.03, 0.75, max(c.r, c.g));
}

/*
 * Emitted light at a point on the ground, linear, before aerial perspective.
 *
 * The composite says how lit a place is, at half a kilometre a texel: a glow,
 * with no streets in it. The streets come from the daytime imagery under it:
 * roads, car parks and concrete are the bright, grey part of a city by day
 * and the lit part by night, while parks, gardens and dark roofs are not —
 * so the city's own plan is what lights up, at whatever scale the imagery is
 * drawn. Close in, separate lamps (sodium orange, some LED white) sparkle in
 * the lit parts; where a lamp is smaller than a pixel it fades to its average,
 * so nothing shimmers or changes as the aircraft climbs away.
 *
 * q: ground position in Web Mercator metres (the terrain's grain frame);
 * footprint: metres per pixel there; albedo: the day imagery's colour.
 */
vec3 cityLights(vec3 worldPos, vec2 q, float footprint, vec3 albedo) {
  float night = atmo[5].w;
  if (night <= ${NIGHT_FROM.toFixed(3)}) return vec3(0.0);
  float lit = nightIntensity(worldPos);
  if (lit <= 0.0) return vec3(0.0);

  float luma = dot(albedo, vec3(0.299, 0.587, 0.114));
  float green = clamp((albedo.g - max(albedo.r, albedo.b)) * 8.0, 0.0, 1.0);
  float paved = smoothstep(0.12, 0.42, luma) * (1.0 - 0.85 * green);
  float field = lit * (0.06 + 0.94 * paved);

  // Lamps on a 12 m grid, in a share of the cells set by how lit the ground is.
  const float CELL = 12.0;
  vec2 cell = floor(q / CELL);
  float on = step(1.0 - field * 0.7, nightHash(cell));
  vec2 jitter = vec2(nightHash(cell + 17.0), nightHash(cell + 41.0)) - 0.5;
  float d = length(fract(q / CELL) - 0.5 - jitter * 0.7) * CELL;
  float radius = max(1.8, footprint * 0.75);
  float pool = on * smoothstep(radius, 0.0, d) * min(1.0, (1.8 * 1.8) / (radius * radius)) * 3.0;
  float near = 1.0 - smoothstep(CELL * 0.2, CELL * 0.8, footprint);

  vec3 sodium = vec3(1.0, 0.56, 0.22);
  vec3 led = vec3(0.86, 0.9, 1.0);
  vec3 lampTint = mix(sodium, led, step(0.72, nightHash(cell + 5.0)));
  vec3 cityTint = mix(sodium, vec3(1.0, 0.82, 0.6), 0.35);
  vec3 light = cityTint * field * 0.55 + lampTint * pool * near;
  return light * nightLights[1].y * smoothstep(${NIGHT_FROM.toFixed(3)}, 0.6, night);
}
`;

async function bitmap(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
  const res = await fetch(url, { signal, credentials: 'omit', mode: 'cors' });
  if (!res.ok) throw new Error(`night lights: ${res.status}`);
  // Flipped so that v = 0 is the south edge, as the shader reads it.
  return createImageBitmap(await res.blob(), { imageOrientation: 'flipY' });
}

/** Keeps the region texture about the aircraft, at night. */
export class NightLights {
  private worldLoading = false;
  private centre: { lat: number; lon: number; latHalf: number; lonHalf: number } | null = null;
  private loading: AbortController | null = null;
  private target = 0;
  private disposed = false;

  /** Call once a frame with where the aircraft is and the night factor. */
  update(lat: number, lon: number, night: number, dt: number): void {
    if (this.disposed) return;
    // By day nothing is fetched at all.
    if (night <= NIGHT_FROM) return;
    if (!this.worldLoading) this.loadWorld();

    data[4] += (this.target - data[4]) * Math.min(1, dt * 1.5);

    const c = this.centre;
    const near =
      c !== null &&
      Math.abs(lat - c.lat) < c.latHalf * RECENTRE_AT &&
      Math.abs(lonDelta(c.lon, lon)) < c.lonHalf * RECENTRE_AT;
    if (!near && !this.loading) void this.loadRegion(lat, lon);
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
    this.loading = controller;
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
      this.centre = { lat: (south + north) / 2, lon: (west + east) / 2, latHalf: (north - south) / 2, lonHalf };
      this.target = 1;
      // Faded in from nothing rather than over the previous region's placement.
      data[4] = 0;
    } catch {
      // Try again on a later frame once the aircraft has moved on; never in a tight loop.
      this.centre = { lat, lon, latHalf, lonHalf };
    } finally {
      if (this.loading === controller) this.loading = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.loading?.abort();
  }
}

/**
 * A new image of a different size into the same texture object, so every
 * material holding it sees the change. The GPU side has to go first: three
 * allocates a texture's storage once, at the size of its first image, and a
 * different-sized image uploaded into it afterwards is silently dropped —
 * which is how the region, after the first, stayed on the old one.
 */
function replaceImage(texture: Texture, img: ImageBitmap): void {
  texture.dispose();
  texture.image = img;
  texture.needsUpdate = true;
}

function lonDelta(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}
