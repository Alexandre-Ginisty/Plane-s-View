/**
 * Building material.
 *
 * Lit exactly as the terrain is — the same sun, the same sky-tinted shadow,
 * the same cloud shadows drifting over, the same aerial perspective — so a
 * city stands *in* the landscape rather than on top of it. What it adds is
 * the facade, drawn in the shader from two numbers per vertex (how far along
 * the wall, how far up it):
 *
 *  - **Floors and windows**, a storey every 3.2 m and a bay every 3 m, the
 *    glass reflecting the sky at a grazing angle. Beyond the distance a
 *    window is a pixel, the pattern gives way to its average, so a far city
 *    does not shimmer.
 *  - **Curtain walls** on towers: most of the wall glass.
 *  - **Lights at night.** A share of the windows lit warm — different ones
 *    per building, a few changing through the evening — bright enough for
 *    the bloom to catch, so a city from the air at night glows.
 *  - **Ground contact**: walls darken towards the street, the shade a
 *    building's own base gets from its neighbours.
 *
 * A new tile does not pop in: it dissolves in over `appear` (screen-door, so
 * it stays opaque and needs no sorting).
 */

import { FrontSide, ShaderMaterial, Vector3 } from 'three';

import { ATMO_GLSL, ATMO_UNIFORMS } from '../sky/shader';
import { CLOUD_SHADOW_GLSL, cloudNoise, cloudShadowData } from '../clouds';

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  attribute vec4 facade;
  attribute vec4 color;

  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec4 vFacade;
  varying vec3 vColor;

  void main() {
    vFacade = facade;
    vColor = color.rgb;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 sunDirection;
  uniform vec3 localUp;
  uniform float appear;
  uniform float ambient;
  ${ATMO_GLSL}
  ${CLOUD_SHADOW_GLSL}

  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec4 vFacade;
  varying vec3 vColor;

  float bHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }

  void main() {
    #include <logdepthbuf_fragment>

    // Dissolve in: a fixed screen-space pattern, thresholded.
    if (appear < 1.0 && bHash(floor(gl_FragCoord.xy)) > appear) discard;

    vec3 n = normalize(vWorldNormal);
    vec3 albedo = vColor;
    float upness = dot(n, localUp);
    bool wall = upness < 0.5;
    float glass = 0.0;
    vec3 emissive = vec3(0.0);
    vec3 view = normalize(vWorldPosition - cameraPosition);

    if (wall) {
      float u = vFacade.x;
      float v = vFacade.y;
      float height = vFacade.z;
      float seed = vFacade.w;
      bool tower = height > 45.0 && seed > 0.35;
      float bay = tower ? 1.6 : mix(2.6, 3.6, fract(seed * 13.7));
      float storey = tower ? 3.6 : 3.2;
      vec2 cell = vec2(u / bay, v / storey);
      vec2 f = fract(cell);
      vec2 id = floor(cell);
      // Window opening within the cell; towers are nearly all glass.
      vec2 lo = tower ? vec2(0.04, 0.08) : vec2(0.22, 0.3);
      vec2 hi = tower ? vec2(0.96, 0.96) : vec2(0.78, 0.82);
      vec2 aa = fwidth(cell) * 1.2;
      vec2 open = smoothstep(lo - aa, lo + aa, f) * (1.0 - smoothstep(hi - aa, hi + aa, f));
      float win = open.x * open.y;
      // No windows in the foundation, nor on the lowest metre and a half.
      float live = step(1.5, v) * step(v, height - 0.6);
      win *= live;
      // Far off a window is a pixel: fade to its average coverage.
      float coverage = (hi.x - lo.x) * (hi.y - lo.y);
      float far = smoothstep(0.35, 0.9, max(aa.x, aa.y));
      win = mix(win, coverage * step(1.5, v), far);
      glass = win;

      // Frame: the pane is inset, the rim between pane and wall is the frame.
      vec2 inset = tower ? vec2(0.02, 0.03) : vec2(0.06, 0.07);
      vec2 paneOpen = smoothstep(lo + inset - aa, lo + inset + aa, f) * (1.0 - smoothstep(hi - inset - aa, hi - inset + aa, f));
      float pane = paneOpen.x * paneOpen.y * live;
      glass = mix(pane, glass, far);
      float rim = max(win - glass, 0.0);
      albedo = mix(albedo, tower ? vec3(0.2, 0.22, 0.25) : vec3(0.86, 0.85, 0.82) * 0.8, rim * 0.9);
      // Sill under each window, slab line at each floor.
      float sill = smoothstep(lo.y - 0.1 - aa.y, lo.y - 0.1, f.y) * (1.0 - smoothstep(lo.y - 0.02, lo.y, f.y)) * (1.0 - far) * live;
      albedo *= 1.0 + 0.16 * sill * (tower ? 0.0 : 1.0);
      albedo *= 1.0 - 0.14 * (1.0 - smoothstep(0.0, 0.05 + aa.y, f.y)) * (1.0 - far) * step(1.5, v);

      // Material of the wall itself: grain; courses of brick where it is brick.
      vec2 gcell = floor(vec2(u, v) * vec2(3.0, 3.0));
      float grain = bHash(gcell + seed * 91.0);
      float grainFade = 1.0 - smoothstep(0.3, 0.9, max(fwidth(u), fwidth(v)) * 3.0);
      albedo *= 1.0 + (grain - 0.5) * 0.14 * grainFade;
      bool brick = vColor.r > vColor.g * 1.14 && vColor.r > vColor.b * 1.3;
      if (brick) {
        float row = v / 0.14;
        float col = u / 0.42 + 0.5 * mod(floor(row), 2.0);
        vec2 bf = fract(vec2(col, row));
        float bw = max(fwidth(row), fwidth(col)) * 1.5;
        float mortar = 1.0 - smoothstep(0.0, 0.08 + bw, bf.y) * smoothstep(0.0, 0.03 + bw, bf.x);
        float brickFade = 1.0 - smoothstep(0.25, 0.8, bw);
        albedo = mix(albedo, albedo * 0.55 + 0.18, mortar * brickFade * 0.7);
        albedo *= 1.0 + (bHash(floor(vec2(col, row)) + seed * 33.0) - 0.5) * 0.18 * brickFade;
      }

      // Lit windows at night: a share per building, warm, a few changing.
      float night = atmo[5].w;
      if (night > 0.0) {
        float r = bHash(id + seed * 517.0);
        float share = mix(0.18, 0.5, fract(seed * 7.3));
        float lit = step(1.0 - share, r);
        vec3 warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.85, 0.9, 1.0), step(0.82, fract(r * 9.1)));
        // Average glow far away, where single windows are gone.
        float glow = mix(lit, share, far);
        emissive = warm * glow * win * night * mix(2.2, 1.4, far);
      }
      // Darker towards the street.
      albedo *= mix(0.62, 1.0, smoothstep(-1.0, 7.0, v));
      if (tower) albedo = mix(albedo, vec3(0.55, 0.62, 0.68), 0.5);
    } else if (upness > 0.985) {
      // Flat roof: gravel and membrane, blotched; a darker rim at the parapet is
      // left to the ambient term. u, v are its ground position.
      vec2 g = vec2(vFacade.x, vFacade.y);
      float fine = bHash(floor(g * 2.5));
      float blotch = bHash(floor(g * 0.35) + vFacade.w * 71.0);
      float fade = 1.0 - smoothstep(0.3, 0.9, max(fwidth(g.x), fwidth(g.y)) * 2.5);
      albedo *= 1.0 + ((fine - 0.5) * 0.2 + (blotch - 0.5) * 0.18) * fade + (blotch - 0.5) * 0.1 * (1.0 - fade);
    } else {
      // Pitched roof: courses of tiles, each its own tone, offset row to row.
      float row = vFacade.y / 0.3;
      float col = vFacade.x / 0.26 + 0.5 * mod(floor(row), 2.0);
      vec2 tf = fract(vec2(col, row));
      float tw = max(fwidth(row), fwidth(col)) * 1.5;
      float tfade = 1.0 - smoothstep(0.25, 0.8, tw);
      float shadow = 1.0 - smoothstep(0.0, 0.14 + tw, tf.y);
      float seam = 1.0 - smoothstep(0.0, 0.05 + tw, tf.x);
      float tone = bHash(floor(vec2(col, row)) + vFacade.w * 29.0);
      albedo *= (1.0 - 0.3 * shadow - 0.1 * seam + (tone - 0.5) * 0.16) * tfade + (1.0 - tfade) * 0.92;
    }

    vec3 sun = normalize(sunDirection);
    float lambert = max(dot(n, sun), 0.0) * cloudSunlight(vWorldPosition, sun);
    vec3 skyTint = atmo[5].rgb;
    vec3 sunTint = (1.0 - ambient * skyTint) / (1.0 - ambient);
    // Walls take less of the sky than roofs do: half of it is ground.
    float sky = ambient * mix(0.75, 1.0, max(upness, 0.0));
    vec3 lit = albedo * (sky * atmo[4].w * skyTint + (1.0 - ambient) * lambert * atmo[4].rgb * sunTint);

    if (glass > 0.0) {
      // Glass: dark, with the sky in it at a grazing angle and the sun's glint.
      float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(-view, n), 0.0), 5.0);
      vec3 reflected = atmoSky(reflect(view, n)) * atmo[4].w;
      vec3 pane = mix(vec3(0.03, 0.04, 0.05) * atmo[4].w, reflected, clamp(fresnel * 1.4 + 0.15, 0.0, 1.0));
      float spec = pow(max(dot(reflect(view, n), sun), 0.0), 220.0) * 6.0;
      pane += atmo[4].rgb * spec * cloudSunlight(vWorldPosition, sun);
      lit = mix(lit, pane, glass * 0.85);
    }

    vec3 color = atmoApply(lit + emissive, vWorldPosition);
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Shared by every tile's material: written once a frame, read by all. */
const shared = {
  sunDirection: { value: new Vector3(1, 0, 0) },
  ambient: { value: 0.42 },
  cloudShadow: { value: cloudShadowData },
};

export function setBuildingSun(direction: Vector3): void {
  shared.sunDirection.value.copy(direction);
}

export class BuildingMaterial extends ShaderMaterial {
  constructor(up: Vector3) {
    super({
      vertexShader,
      fragmentShader,
      uniforms: {
        ...ATMO_UNIFORMS,
        ...shared,
        cloudTex: { value: null },
        localUp: { value: up.clone() },
        appear: { value: 0 },
      },
      side: FrontSide,
    });
    // After construction: a texture in the constructor's uniforms is cloned.
    this.uniforms['cloudTex']!.value = cloudNoise;
    // The shared uniform objects, not the copies `ShaderMaterial` made.
    for (const [k, u] of Object.entries(shared)) this.uniforms[k] = u;
  }

  set appear(v: number) {
    this.uniforms['appear']!.value = v;
  }

  get appear(): number {
    return this.uniforms['appear']!.value as number;
  }
}
