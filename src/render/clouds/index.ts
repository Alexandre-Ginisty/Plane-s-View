/**
 * The real cloud layers, from the weather model.
 *
 * MET Norway reports cover in three layers — low, mid and high — and the
 * temperature and dew point that put the base of the low one at about
 * 125 m per degree of spread. Each layer is drawn as a sheet at its height:
 * cumulus and stratocumulus low, altocumulus in the middle, cirrus high and
 * drawn out along the wind. They drift with the wind the traffic measures at
 * their height, cast their shadows on the ground (the low layer, see
 * `CLOUD_SHADOW_GLSL`) and fade into the same haze as everything else.
 *
 * ## Cheap on purpose
 *
 * Volumetric clouds over a sky with hundreds of aircraft would cost more
 * than the rest of the frame. A sheet is one draw call: a disc of a few
 * thousand vertices that follows the Earth's curvature, centred under the
 * camera, sampling a small pre-computed noise texture four times a pixel —
 * no noise is evaluated in the shader. Their look comes from the shading:
 * sunlit tops from above, grey bases from below, a darker side away from
 * the sun read off the same noise one step towards it, and the silver edge
 * of thin cloud between the eye and the sun.
 *
 * ## Fixed to the ground
 *
 * The pattern is laid in east/north metres from a fixed point, wrapped to
 * the noise's period on the CPU in double precision, so it stays put under a
 * moving camera and continues seamlessly as it wraps; only the wind moves it.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  Group,
  NormalBlending,
  RGBAFormat,
  RepeatWrapping,
  ShaderMaterial,
  Vector3,
  type PerspectiveCamera,
} from 'three';

import { ecefToGeodetic } from '@/core/math/geo';
import type { SceneLight } from '@/render/sky/model';
import { ATMO_GLSL, ATMO_UNIFORMS } from '@/render/sky/shader';

/** The noise repeats every this many metres; every octave divides it. */
const PERIOD_M = 51_200;
const NOISE_PX = 256;
/** Sheet radius, metres: past this the haze has taken the cloud anyway. */
const RADIUS_M = 160_000;
const RINGS = 40;
const SEGMENTS = 96;
const EARTH_R = 6_371_000;
const M_PER_DEG = 111_320;

/** Tileable value noise, four octaves per channel, each channel its own seed. */
function makeNoise(): DataTexture {
  const n = NOISE_PX;
  const data = new Uint8Array(n * n * 4);
  const lattice = (seed: number, period: number) => {
    const g = new Float32Array(period * period);
    let s = seed;
    for (let i = 0; i < g.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      g[i] = s / 4294967296;
    }
    return g;
  };
  const fade = (t: number) => t * t * (3 - 2 * t);
  for (let ch = 0; ch < 4; ch++) {
    const octaves = [4, 8, 16, 32].map((p, o) => ({ p, g: lattice(7919 * (ch + 1) + o * 104729, p), w: 0.5 ** o }));
    const norm = octaves.reduce((a, o) => a + o.w, 0);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let v = 0;
        for (const { p, g, w } of octaves) {
          const fx = (x / n) * p;
          const fy = (y / n) * p;
          const x0 = Math.floor(fx), y0 = Math.floor(fy);
          const tx = fade(fx - x0), ty = fade(fy - y0);
          const x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
          const a = g[y0 * p + x0]!, b = g[y0 * p + x1]!, c = g[y1 * p + x0]!, d = g[y1 * p + x1]!;
          v += (a + (b - a) * tx + (c - a + (a - b - c + d) * tx) * ty) * w;
        }
        data[(y * n + x) * 4 + ch] = Math.round((v / norm) * 255);
      }
    }
  }
  const t = new DataTexture(data, n, n, RGBAFormat);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  t.name = 'cloud noise';
  return t;
}

/** One noise for the sheets and the ground's shadows, so they agree. */
export const cloudNoise = makeNoise();

/**
 * The low layer, for the terrain's shadows: shared by reference, like the
 * atmosphere's uniforms.
 * [0] sheet centre (render space), enabled
 * [1] east (unit), cover threshold
 * [2] north (unit), shadow strength
 * [3] pattern offset (m, wrapped), seconds (for the water's ripples), unused
 */
export const cloudShadowData = new Float32Array(16);

/** Cloud density at a pattern coordinate, metres. `threshold` sets the cover. */
const CLOUD_GLSL = /* glsl */ `
float cloudNoise4(sampler2D tex, vec2 c) {
  float n = texture2D(tex, c / ${PERIOD_M.toFixed(1)}).r * 0.5;
  n += texture2D(tex, c / ${(PERIOD_M / 4).toFixed(1)} + vec2(0.37, 0.11)).g * 0.28;
  n += texture2D(tex, c / ${(PERIOD_M / 16).toFixed(1)} + vec2(0.71, 0.53)).b * 0.15;
  n += texture2D(tex, c / ${(PERIOD_M / 64).toFixed(1)} + vec2(0.13, 0.89)).a * 0.07;
  return n;
}
float cloudDensity(sampler2D tex, vec2 c, float threshold, float softness) {
  return smoothstep(threshold, threshold + softness, cloudNoise4(tex, c));
}
`;

/** For the terrain: how much sunlight the low layer lets through at a ground point. */
export const CLOUD_SHADOW_GLSL = /* glsl */ `
uniform vec4 cloudShadow[4];
uniform sampler2D cloudTex;
${CLOUD_GLSL}
float cloudSunlight(vec3 ground, vec3 sunDir) {
  if (cloudShadow[0].w < 0.5) return 1.0;
  vec3 east = cloudShadow[1].xyz;
  vec3 north = cloudShadow[2].xyz;
  vec3 up = cross(east, north);
  float s = dot(sunDir, up);
  if (s < 0.05) return 1.0;
  // Along the sun's ray from the ground to the sheet.
  float t = dot(cloudShadow[0].xyz - ground, up) / s;
  if (t < 0.0) return 1.0;
  vec3 hit = ground + sunDir * t - cloudShadow[0].xyz;
  vec2 c = vec2(dot(hit, east), dot(hit, north)) + cloudShadow[3].xy;
  float d = cloudDensity(cloudTex, c, cloudShadow[1].w, 0.2);
  return 1.0 - d * cloudShadow[2].w;
}
`;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vLocal;
varying vec3 vWorld;
varying float vEdge;
void main() {
  vLocal = position.xy;
  vEdge = length(position.xy) / ${RADIUS_M.toFixed(1)};
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMO_GLSL}
${CLOUD_GLSL}
uniform sampler2D cloudTex;
uniform vec2 offset;
uniform float threshold;
uniform float softness;
uniform float opacity;
uniform float above;     // 1 seen from above, 0 from below
uniform vec2 stretch;    // cirrus: drawn out along the wind (x along, y across)
uniform vec2 windDir;
uniform vec3 sunLocal;   // the sun in the sheet's east/north/up
uniform vec3 sunColor;
uniform vec3 skyColor;
varying vec2 vLocal;
varying vec3 vWorld;
varying float vEdge;

vec3 finishColor(vec3 c) {
  #ifdef TONE_MAPPING
    c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}

vec2 pattern(vec2 p) {
  vec2 along = windDir;
  vec2 across = vec2(-windDir.y, windDir.x);
  return vec2(dot(p, along) / stretch.x, dot(p, across) / stretch.y);
}

void main() {
  #include <logdepthbuf_fragment>
  vec2 c = pattern(vLocal + offset);
  float d = cloudDensity(cloudTex, c, threshold, softness);
  float fade = 1.0 - smoothstep(0.65, 1.0, vEdge);
  float a = d * opacity * fade;
  if (a < 0.004) discard;

  // A step towards the sun: denser there means this side is in its shadow.
  vec2 toSun = sunLocal.xy / max(length(sunLocal.xy), 1e-3);
  float ahead = cloudDensity(cloudTex, pattern(vLocal + offset + toSun * 600.0), threshold, softness);
  float lit = clamp(1.0 - (ahead - d) * 1.6, 0.35, 1.0);
  float sunUp = clamp(sunLocal.z, 0.0, 1.0);

  vec3 view = normalize(vWorld - cameraPosition);
  float toward = max(dot(view, atmo[3].xyz), 0.0);
  // Thin cloud between the eye and the sun lights up.
  float silver = pow(toward, 12.0) * (1.0 - d) * 2.5;

  vec3 top = sunColor * (0.55 + 0.45 * sunUp) * lit + skyColor * 0.55;
  // From below: the base, darker the thicker the cloud, lit by the sky.
  vec3 base = skyColor * (0.85 - 0.45 * d) + sunColor * 0.18 * sunUp;
  vec3 col = mix(base, top, above) + sunColor * silver;

  vec3 disp = atmoToLinear(finishColor(col));
  if (atmo[2].w > 0.5) {
    vec3 tr = atmoTransmittance(vWorld);
    disp = disp * tr + atmoHaze(view) * (1.0 - tr);
  }
  gl_FragColor = vec4(atmoToSrgb(disp) * a, a);
}
`;

/** The cloud weather: cover by layer, 0..1, and the low base, metres above sea level. */
export interface CloudWeather {
  low: number;
  mid: number;
  high: number;
  lowBaseM: number;
}

interface Layer {
  mesh: Mesh;
  material: ShaderMaterial;
  altM: number;
  cover: number;
  /** Pattern drift, metres. */
  driftE: number;
  driftN: number;
  windE: number;
  windN: number;
}

function sheet(): BufferGeometry {
  const pos: number[] = [0, 0, 0];
  for (let r = 1; r <= RINGS; r++) {
    // Rings closer together near the centre, where the eye is.
    const rad = RADIUS_M * (r / RINGS) ** 1.6;
    // The sheet bends with the Earth: a hundred and sixty kilometres out it
    // is two kilometres below the tangent plane.
    const drop = (rad * rad) / (2 * EARTH_R);
    for (let s = 0; s < SEGMENTS; s++) {
      const a = (s / SEGMENTS) * Math.PI * 2;
      pos.push(Math.cos(a) * rad, Math.sin(a) * rad, -drop);
    }
  }
  const index: number[] = [];
  for (let s = 0; s < SEGMENTS; s++) index.push(0, 1 + s, 1 + ((s + 1) % SEGMENTS));
  for (let r = 1; r < RINGS; r++) {
    const a0 = 1 + (r - 1) * SEGMENTS;
    const b0 = 1 + r * SEGMENTS;
    for (let s = 0; s < SEGMENTS; s++) {
      const s1 = (s + 1) % SEGMENTS;
      index.push(a0 + s, b0 + s, b0 + s1, a0 + s, b0 + s1, a0 + s1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(index);
  return g;
}

const _up = new Vector3();
const _east = new Vector3();
const _north = new Vector3();
const _centre = new Vector3();

export class CloudLayers {
  readonly group = new Group();
  private readonly layers: Layer[] = [];
  private readonly geometry = sheet();
  private weather: CloudWeather | null = null;
  private time = 0;

  constructor() {
    this.group.matrixAutoUpdate = false;
    const kinds = [
      { softness: 0.16, opacity: 0.95, stretch: [1, 1] },
      { softness: 0.2, opacity: 0.85, stretch: [1, 1] },
      // Cirrus: thin, fibrous, drawn out along the wind.
      { softness: 0.3, opacity: 0.55, stretch: [5, 0.8] },
    ];
    for (const k of kinds) {
      const material = new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          ...ATMO_UNIFORMS,
          cloudTex: { value: null },
          offset: { value: [0, 0] },
          threshold: { value: 1 },
          softness: { value: k.softness },
          opacity: { value: k.opacity },
          above: { value: 1 },
          stretch: { value: k.stretch },
          windDir: { value: [1, 0] },
          sunLocal: { value: new Vector3(0, 0, 1) },
          sunColor: { value: new Vector3(1, 1, 1) },
          skyColor: { value: new Vector3(0.6, 0.7, 0.9) },
        },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: NormalBlending,
        premultipliedAlpha: true,
        // Double-sided but one pass: there is no back to draw behind a sheet.
        forceSinglePass: true,
      });
      // After construction: a texture in the constructor's uniforms is cloned.
      material.uniforms['cloudTex']!.value = cloudNoise;
      const mesh = new Mesh(this.geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.name = 'cloud-layer';
      this.group.add(mesh);
      this.layers.push({ mesh, material, altM: 0, cover: 0, driftE: 0, driftN: 0, windE: 0, windN: 0 });
    }
  }

  /** The cover and heights to draw; null for none (unknown weather draws no cloud). */
  setWeather(weather: CloudWeather | null): void {
    this.weather = weather;
  }

  /** Wind at each layer's height, m/s east and north. */
  setWind(layer: 0 | 1 | 2, east: number, north: number): void {
    const l = this.layers[layer]!;
    l.windE = east;
    l.windN = north;
  }

  /** Heights of the layers, metres above sea level, for wind lookups. */
  get heights(): readonly number[] {
    return this.layers.map((l) => l.altM);
  }

  /** The sunlight and skylight the cloud scatters. */
  setLight(light: SceneLight): void {
    for (const l of this.layers) {
      (l.material.uniforms['sunColor']!.value as Vector3).set(light.sunColor[0], light.sunColor[1], light.sunColor[2]).multiplyScalar(light.sunStrength * 1.1);
      (l.material.uniforms['skyColor']!.value as Vector3).set(light.skyColor[0], light.skyColor[1], light.skyColor[2]).multiplyScalar(light.skyStrength * 0.75);
    }
  }

  /**
   * Place the sheets about the camera. `origin` is the floating origin (ECEF
   * of render-space zero), `sunDirection` a unit vector in render space.
   */
  update(camera: PerspectiveCamera, origin: readonly number[], sunDirection: Vector3, dt: number): void {
    const w = this.weather;
    const g = ecefToGeodetic(camera.position.x + origin[0]!, camera.position.y + origin[1]!, camera.position.z + origin[2]!);
    const lat = (g.lat * Math.PI) / 180;
    const lon = (g.lon * Math.PI) / 180;
    _up.set(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
    _east.set(-Math.sin(lon), Math.cos(lon), 0);
    _north.crossVectors(_up, _east);
    // Ground-fixed pattern coordinates of the point under the camera.
    const camE = g.lon * M_PER_DEG * Math.cos((45 * Math.PI) / 180);
    const camN = g.lat * M_PER_DEG;
    const sunE = sunDirection.dot(_east);
    const sunN = sunDirection.dot(_north);
    const sunU = sunDirection.dot(_up);

    const covers = w ? [w.low, w.mid, w.high] : [0, 0, 0];
    const alts = w ? [w.lowBaseM, Math.max(w.lowBaseM + 1800, 4800), Math.max(w.lowBaseM + 4000, 9800)] : [0, 0, 0];
    cloudShadowData[0] = 0;
    this.time = (this.time + dt) % 1000;
    cloudShadowData[14] = this.time;

    this.layers.forEach((l, i) => {
      l.cover = covers[i]!;
      l.altM = alts[i]!;
      l.mesh.visible = l.cover > 0.03;
      if (!l.mesh.visible) return;
      l.driftE += l.windE * dt;
      l.driftN += l.windN * dt;
      const u = l.material.uniforms;
      const offset = u['offset']!.value as number[];
      offset[0] = (((camE - l.driftE) % PERIOD_M) + PERIOD_M) % PERIOD_M;
      offset[1] = (((camN - l.driftN) % PERIOD_M) + PERIOD_M) % PERIOD_M;
      // Cover to a noise threshold: the noise is roughly normal about 0.5.
      u['threshold']!.value = 0.74 - 0.5 * l.cover;
      u['above']!.value = g.height > l.altM ? 1 : 0;
      (u['sunLocal']!.value as Vector3).set(sunE, sunN, sunU);
      const ws = Math.hypot(l.windE, l.windN);
      const dir = u['windDir']!.value as number[];
      // Only the cirrus turns with the wind; the others keep the plain
      // east/north pattern the ground's shadows are computed in.
      if (i === 2 && ws > 0.5) {
        dir[0] = l.windE / ws;
        dir[1] = l.windN / ws;
      }

      _centre.copy(camera.position).addScaledVector(_up, l.altM - g.height);
      l.mesh.matrix.makeBasis(_east, _north, _up).setPosition(_centre);
      l.mesh.matrixWorldNeedsUpdate = true;
      // Nearest drawn last.
      l.mesh.renderOrder = 1 - Math.abs(g.height - l.altM) / 1e5;

      if (i === 0) {
        cloudShadowData.set([_centre.x, _centre.y, _centre.z, 1], 0);
        cloudShadowData.set([_east.x, _east.y, _east.z, u['threshold']!.value as number], 4);
        cloudShadowData.set([_north.x, _north.y, _north.z, 0.55 * Math.min(1, l.cover * 1.4)], 8);
        cloudShadowData[12] = offset[0]!;
        cloudShadowData[13] = offset[1]!;
      }
    });
  }

  dispose(): void {
    this.geometry.dispose();
    for (const l of this.layers) l.material.dispose();
    cloudNoise.dispose();
  }
}
