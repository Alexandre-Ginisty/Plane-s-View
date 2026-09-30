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
 */

import { FrontSide, ShaderMaterial, Texture, Vector3, Vector4 } from 'three';
import { ATMO_GLSL, ATMO_UNIFORMS } from './sky/shader';

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;

    // Tile model matrices are pure translation (the floating origin), so the
    // upper 3x3 is identity and the normal passes through unchanged. Going
    // through mat3(modelMatrix) anyway keeps this correct if that ever changes.
    vWorldNormal = normalize(mat3(modelMatrix) * normal);

    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
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
  uniform float ambient;

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

    vec3 normal = normalize(vWorldNormal);
    float lambert = max(dot(normal, normalize(sunDirection)), 0.0);

    // Satellite imagery already contains the sun that lit it, so shading is
    // kept gentle: enough to reveal relief, not enough to double-light it.
    // The sun's colour and strength come from the atmosphere, relative to
    // noon (atmo[4]): orange at sunset, gone at night, where the skylight
    // term keeps the imagery legible.
    vec3 lit = albedo * (ambient * atmo[4].w + (1.0 - ambient) * lambert * atmo[4].rgb);

    // Aerial perspective, shared with every other material and with the sky
    // itself: see @/render/sky. This is also what removes the ring of colour
    // around the aircraft, where the imagery provider switches from recent
    // aerial survey to a warmer satellite composite with zoom: fifty
    // kilometres of air washes the difference out, as from a real window.
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
      },
      side: FrontSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });
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
