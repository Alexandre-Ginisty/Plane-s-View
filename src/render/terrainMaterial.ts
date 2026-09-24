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
 * Distant terrain fades towards the sky colour with an exponential falloff.
 * This is not only atmosphere: it is what hides the LOD horizon, where tiles
 * are at their coarsest. Without it the eye immediately finds the boundary.
 */

import { CLEAR_DAY_DENSITY, EARTH_RADIUS_M, SCALE_HEIGHT_M } from './atmosphere';
import {
  BackSide,
  Color,
  FrontSide,
  ShaderMaterial,
  Texture,
  Vector3,
  Vector4,
} from 'three';

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
  uniform vec3 fogColor;
  // Sea-level extinction per metre. See @/render/atmosphere.
  uniform float fogDensity;
  uniform float fogScaleHeight;
  // Planet centre in render space, i.e. minus the floating origin.
  uniform vec3 planetCenter;
  uniform float earthRadius;
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
    vec3 lit = albedo * (ambient + (1.0 - ambient) * lambert);

    /*
     * Aerial perspective through an exponential atmosphere.
     *
     * A transcription of opticalDepth in @/render/atmosphere -- see that
     * file for why a constant density is wrong in both directions at once, and
     * for the tests that pin these numbers. Keep the two in step.
     *
     * This is what removes the ring of colour around the aircraft: the imagery
     * provider serves a different dataset at deep zoom than at shallow, so the
     * ground near the aircraft is graded cooler than the ground at the horizon.
     * Fifty kilometres of air washes the difference out, exactly as it does
     * from a real window.
     */
    float rayLength = length(vWorldPosition - cameraPosition);
    float hFrag = max(length(vWorldPosition - planetCenter) - earthRadius, 0.0);
    float hCam = max(length(cameraPosition - planetCenter) - earthRadius, 0.0);
    float dh = hFrag - hCam;

    float tau;
    if (abs(dh) < 1.0) {
      // Level ray: the closed form below divides by dh.
      tau = fogDensity * exp(-hCam / fogScaleHeight) * rayLength;
    } else {
      tau = abs(
        fogDensity * fogScaleHeight * (rayLength / dh) *
        (exp(-hCam / fogScaleHeight) - exp(-hFrag / fogScaleHeight))
      );
    }

    float fogAmount = 1.0 - exp(-tau);
    vec3 finalColor = mix(lit, fogColor, clamp(fogAmount, 0.0, 1.0));

    gl_FragColor = vec4(finalColor, tileOpacity);

    #include <colorspace_fragment>
  }
`;

/** UV transform meaning "sample this texture one-to-one". */
export const IDENTITY_UV = new Vector4(0, 0, 1, 1);

export interface TerrainMaterialOptions {
  fogColor?: Color;
  fogDensity?: number;
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
        fogColor: { value: options.fogColor?.clone() ?? new Color(0x8fb2d4) },
        fogDensity: { value: options.fogDensity ?? CLEAR_DAY_DENSITY },
        fogScaleHeight: { value: SCALE_HEIGHT_M },
        planetCenter: { value: new Vector3(0, 0, 0) },
        earthRadius: { value: EARTH_RADIUS_M },
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

  /**
   * @param planetCentre Where the centre of the Earth is in render space —
   * the negated floating origin. Needed every frame because the origin moves,
   * and an altitude measured against a stale centre puts the whole world at
   * the wrong density after every rebase.
   */
  setFog(color: Color, density: number, planetCentre: Vector3): void {
    (this.uniforms['fogColor']!.value as Color).copy(color);
    this.uniforms['fogDensity']!.value = density;
    (this.uniforms['planetCenter']!.value as Vector3).copy(planetCentre);
  }
}

/**
 * Sky shell.
 *
 * Drawn on the inside of a large sphere around the camera. Its colour is the
 * same one the terrain fogs towards, so the horizon dissolves instead of
 * ending at a hard line — which is what would otherwise reveal exactly how far
 * the loaded terrain extends.
 */
export function createSkyMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: {
      horizonColor: { value: new Color(0x9dc0e3) },
      zenithColor: { value: new Color(0x1b3f77) },
      groundColor: { value: new Color(0x0a1420) },
      sunDirection: { value: new Vector3(1, 0, 0) },
      upDirection: { value: new Vector3(0, 0, 1) },
      sunIntensity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        // Force the sky to the far plane so it never occludes terrain.
        gl_Position.z = gl_Position.w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 horizonColor;
      uniform vec3 zenithColor;
      uniform vec3 groundColor;
      uniform vec3 sunDirection;
      uniform vec3 upDirection;
      uniform float sunIntensity;

      varying vec3 vDirection;

      void main() {
        vec3 dir = normalize(vDirection);
        float elevation = dot(dir, normalize(upDirection));

        // Above the horizon: horizon -> zenith. Below: fade to a dark ground
        // haze, which is what you see looking down from altitude.
        vec3 sky = mix(horizonColor, zenithColor, pow(clamp(elevation, 0.0, 1.0), 0.55));
        vec3 below = mix(horizonColor, groundColor, pow(clamp(-elevation, 0.0, 1.0), 0.4));
        vec3 color = elevation >= 0.0 ? sky : below;

        // Cheap sun glow; no scattering integral, just enough to place the sun.
        float sunDot = max(dot(dir, normalize(sunDirection)), 0.0);
        color += vec3(1.0, 0.92, 0.78) * pow(sunDot, 350.0) * 2.0 * sunIntensity;
        color += vec3(1.0, 0.85, 0.65) * pow(sunDot, 12.0) * 0.12 * sunIntensity;

        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}
