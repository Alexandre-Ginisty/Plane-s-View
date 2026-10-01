/**
 * Terrain tile material.
 *
 * A stock `MeshStandardMaterial` cannot express the one thing that makes the
 * globe feel like it is not loading, so this is a custom shader.
 *
 * ## Two textures, always
 *
 * Every tile samples **two** textures and mixes between them:
 *
 *  - `mapA` is the *inherited* image: the nearest loaded ancestor's texture,
 *    addressed through `uvA`, which offsets and scales this tile's UVs into
 *    the ancestor's. A brand-new tile therefore already shows the right
 *    picture of the right place — blurrier, but never blank, never a
 *    placeholder colour, never a visible seam.
 *  - `mapB` is the tile's own image once it arrives.
 *
 * `blend` then ramps 0 -> 1 over a few hundred milliseconds, so detail
 * *sharpens into place* instead of snapping. That single mechanism removes
 * nearly all of the perceived loading.
 *
 * ## Aerial perspective
 *
 * Distant terrain fades into the sky through the shared atmosphere
 * (`@/render/sky`): per channel, so the far ground turns blue before it turns
 * into sky, and towards the exact colour the dome shows behind it. This is
 * not only atmosphere: it is what hides the LOD horizon, where tiles are at
 * their coarsest. Without it the eye immediately finds the boundary.
 *
 * ## Geomorphing
 *
 * A finer tile arrives shaped like its parent (`morph`, from the worker) and
 * slides onto its own relief over `morphK`, so the ground reshapes instead of
 * popping as the levels of detail change under a descending aircraft.
 *
 * ## Detail grain
 *
 * Low over the ground, the imagery runs out of resolution well before the
 * screen does and turns to smooth colour. A faint grain — luminance only, a
 * few per cent — is added at the scales the imagery cannot show: each octave
 * only where the tile's texels are coarser than it, and only while a screen
 * pixel is finer than it, so it never paints over real detail and fades out
 * with distance by itself. It is laid in Web Mercator metres, which are
 * continuous from tile to tile (see `setDetail`).
 *
 * ## Shadows
 *
 * The part of the light that is not the sun is the sky's: slopes turned away
 * are lit blue, sunlit ones a little warm, balanced so a surface facing the
 * sun keeps the imagery's own colour (`atmo[5]`).
 */

import { FrontSide, ShaderMaterial, Texture, Vector3, Vector4 } from 'three';
import { ATMO_GLSL, ATMO_UNIFORMS } from './sky/shader';
import { CLOUD_SHADOW_GLSL, cloudNoise, cloudShadowData } from './clouds';

/** The grain repeats every this many Web Mercator metres: a multiple of every octave (2, 8 and 32 m). */
export const GRAIN_PERIOD_M = 4096;

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  attribute vec3 morph;
  uniform float morphK;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;

    // Tile model matrices are pure translation (the floating origin), so the
    // upper 3x3 is identity and the normal passes through unchanged. Going
    // through mat3(modelMatrix) anyway keeps this correct if that ever changes.
    vWorldNormal = normalize(mat3(modelMatrix) * normal);

    vec4 worldPosition = modelMatrix * vec4(position + morph * (1.0 - morphK), 1.0);
    vWorldPosition = worldPosition.xyz;

    gl_Position = projectionMatrix * viewMatrix * worldPosition;

    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform sampler2D mapA;
  uniform sampler2D mapB;
  uniform vec4 uvA;
  uniform vec4 uvB;
  uniform float blend;
  uniform float tileOpacity;

  uniform vec3 sunDirection;
  ${ATMO_GLSL}
  ${CLOUD_SHADOW_GLSL}
  uniform float ambient;
  // xy: the tile's north-west corner in Web Mercator metres, wrapped to the
  // grain's period; z: the tile's side in the same metres.
  uniform vec3 detail;
  // Ground size of one texel of the imagery drawn, same metres.
  uniform float texelM;

  // Dave Hoskins' hash: no sin(), so no precision loss at large cell numbers.
  float grainHash(vec2 i) {
    vec3 p = fract(vec3(i.xyx) * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  // Value noise that tiles every 'period' cells, so it continues across the
  // wrap of the tile origins.
  float grainNoise(vec2 p, float period) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = grainHash(mod(i, period));
    float b = grainHash(mod(i + vec2(1.0, 0.0), period));
    float c = grainHash(mod(i + vec2(0.0, 1.0), period));
    float d = grainHash(mod(i + vec2(1.0, 1.0), period));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float grainOctave(vec2 q, float footprint, float lambda) {
    // Only finer than the imagery, and only while the screen resolves it.
    float w = (1.0 - smoothstep(0.3 * lambda, 0.7 * lambda, footprint)) * smoothstep(0.35 * lambda, 1.2 * lambda, texelM);
    if (w <= 0.0) return 0.0;
    return (grainNoise(q / lambda, ${GRAIN_PERIOD_M.toFixed(1)} / lambda) - 0.5) * w;
  }

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    #include <logdepthbuf_fragment>

    // uv*.xy is the offset into the source texture, uv*.zw the scale.
    vec2 coordA = vUv * uvA.zw + uvA.xy;
    vec2 coordB = vUv * uvB.zw + uvB.xy;

    vec3 colorA = texture2D(mapA, coordA).rgb;
    vec3 colorB = texture2D(mapB, coordB).rgb;
    vec3 albedo = mix(colorA, colorB, blend);

    // Detail grain: see the header.
    vec2 q = detail.xy + vec2(vUv.x, 1.0 - vUv.y) * detail.z;
    float footprint = length(fwidth(q));
    float grain = grainOctave(q, footprint, 2.0) * 0.55 + grainOctave(q, footprint, 8.0) * 0.8 + grainOctave(q, footprint, 32.0);
    // Not on open water: a dark, blue surface stays as the imagery has it.
    float luma = dot(albedo, vec3(0.299, 0.587, 0.114));
    float water = step(albedo.r + 0.02, albedo.b) * (1.0 - smoothstep(0.12, 0.28, luma));
    albedo *= 1.0 + grain * 0.16 * (1.0 - water);

    vec3 normal = normalize(vWorldNormal);
    float lambert = max(dot(normal, normalize(sunDirection)), 0.0);
    // The low cloud's shadow, drifting across the ground with the wind.
    lambert *= cloudSunlight(vWorldPosition, normalize(sunDirection));

    // Satellite imagery already contains the sun that lit it, so shading is
    // kept gentle: enough to reveal relief, not enough to double-light it.
    // The sun's colour and strength come from the atmosphere, relative to
    // noon (atmo[4]): orange at sunset, gone at night, where the skylight
    // term keeps the imagery legible.
    // Skylight tinted by the sky, the sun by what balances it (see header).
    vec3 skyTint = atmo[5].rgb;
    vec3 sunTint = (1.0 - ambient * skyTint) / (1.0 - ambient);
    vec3 lit = albedo * (ambient * atmo[4].w * skyTint + (1.0 - ambient) * lambert * atmo[4].rgb * sunTint);

    // Aerial perspective, shared with every other material and with the sky
    // itself: see @/render/sky. This is also what removes the ring of colour
    // around the aircraft, where the imagery provider switches from recent
    // aerial survey to a warmer satellite composite with zoom: fifty
    // kilometres of air washes the difference out, as from a real window.
    // Open water lives: the sky in it at a grazing angle, and the sun in its
    // ripples — a glitter close by, a path of light across the sea far off.
    if (water > 0.01) {
      vec3 view = normalize(vWorldPosition - cameraPosition);
      vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), normal));
      vec3 northT = cross(normal, east);
      float t = cloudShadow[3].z;
      float ripples = 1.0 - smoothstep(3.0, 40.0, footprint);
      vec2 n1 = texture2D(cloudTex, q / 32.0 + vec2(t * 0.011, t * 0.006)).rg - 0.5;
      vec2 n2 = texture2D(cloudTex, q / 16.0 - vec2(t * 0.019, -t * 0.015)).ba - 0.5;
      vec2 slope = (n1 + n2 * 0.6) * 0.5 * ripples;
      vec3 wn = normalize(normal + east * slope.x + northT * slope.y);
      vec3 r = reflect(view, wn);
      float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(-view, normal), 0.0), 5.0);
      lit = mix(lit, atmoSky(reflect(view, normal)) * atmo[4].w, fresnel * 0.6 * water);
      float sharp = mix(60.0, 900.0, ripples);
      float glint = pow(max(dot(r, normalize(sunDirection)), 0.0), sharp) * mix(1.5, 9.0, ripples);
      lit += atmo[4].rgb * glint * water * cloudSunlight(vWorldPosition, normalize(sunDirection));
    }

    vec3 finalColor = atmoApply(lit, vWorldPosition);

    gl_FragColor = vec4(finalColor, tileOpacity);

    #include <colorspace_fragment>
  }
`;

/** UV transform meaning "sample this texture one-to-one". */
export const IDENTITY_UV = new Vector4(0, 0, 1, 1);

export interface TerrainMaterialOptions {
  ambient?: number;
}

export class TerrainMaterial extends ShaderMaterial {
  constructor(options: TerrainMaterialOptions = {}) {
    super({
      vertexShader,
      fragmentShader,
      uniforms: {
        mapA: { value: null },
        mapB: { value: null },
        uvA: { value: IDENTITY_UV.clone() },
        uvB: { value: IDENTITY_UV.clone() },
        blend: { value: 0 },
        tileOpacity: { value: 1 },
        sunDirection: { value: new Vector3(1, 0, 0) },
        ...ATMO_UNIFORMS,
        ambient: { value: options.ambient ?? 0.45 },
        morphK: { value: 1 },
        cloudShadow: { value: cloudShadowData },
        cloudTex: { value: null },
        detail: { value: new Vector3(0, 0, 1) },
        texelM: { value: 0 },
      },
      side: FrontSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });
    // After construction: a texture in the constructor's uniforms is cloned.
    this.uniforms['cloudTex']!.value = cloudNoise;
  }

  setTextures(a: Texture | null, uvA: Vector4, b: Texture | null, uvB: Vector4): void {
    this.uniforms['mapA']!.value = a;
    this.uniforms['mapB']!.value = b ?? a;
    (this.uniforms['uvA']!.value as Vector4).copy(uvA);
    (this.uniforms['uvB']!.value as Vector4).copy(b ? uvB : uvA);
  }

  set blend(v: number) {
    this.uniforms['blend']!.value = v;
  }

  get blend(): number {
    return this.uniforms['blend']!.value as number;
  }

  /**
   * Opacity is driven separately from `transparent` so a tile can be fully
   * opaque (and depth-writing) most of the time and only pay the cost of
   * blending during the few hundred milliseconds it is fading in.
   */
  setFade(opacity: number): void {
    this.uniforms['tileOpacity']!.value = opacity;

    const fading = opacity < 0.999;
    if (this.transparent !== fading) {
      this.transparent = fading;
      // A fading tile sits directly on top of the parent it is replacing.
      // Writing depth would let it occlude itself in the blend; not writing
      // keeps the parent readable underneath for the whole transition.
      this.depthWrite = !fading;
      this.needsUpdate = true;
    }
  }

  /** How far the tile has slid from its parent's shape onto its own, 0..1. */
  set morph(k: number) {
    this.uniforms['morphK']!.value = k;
  }

  /**
   * Where the tile is, for the grain: its north-west corner in Web Mercator
   * metres, already wrapped to `GRAIN_PERIOD_M` (in double precision, on the
   * CPU), its side in the same metres, and the size of the drawn imagery's
   * texels.
   */
  setDetail(originX: number, originY: number, sideM: number, texelM: number): void {
    (this.uniforms['detail']!.value as Vector3).set(originX, originY, sideM);
    this.uniforms['texelM']!.value = texelM;
  }

  setSun(direction: Vector3): void {
    (this.uniforms['sunDirection']!.value as Vector3).copy(direction);
  }

  /**
   * Shadow floor: how bright a slope facing directly away from the sun is.
   *
   * Satellite imagery already contains the sun that lit it, so this stays high
   * enough not to double-light the picture. Lowering it is what makes relief
   * read as relief rather than as a photograph of relief, which is most of
   * what the boosted terrain setting is for — geometry the eye cannot shade is
   * geometry the eye does not see.
   */
  setAmbient(value: number): void {
    this.uniforms['ambient']!.value = value;
  }
}
