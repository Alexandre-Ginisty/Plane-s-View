/**
 * The atmosphere on the GPU: one set of uniforms, one GLSL function, every
 * material.
 *
 * ## What every material shares
 *
 * `ATMO_UNIFORMS` holds a small `vec4` array (planet centre, extinction
 * coefficients, horizon dip, sun) and the sky table built by
 * `buildSkyLut`. The uniform *objects* are shared, not copied, so writing
 * new values once a frame reaches every program with no recompile.
 *
 * ## How built-in materials get it
 *
 * three's own fog chunks are replaced, so any material with `fog: true` in a
 * scene with `scene.fog` set — which is every built-in material by default —
 * hazes by the atmosphere instead of by a flat `FogExp2`. Two details matter:
 *
 *  - **Uniforms.** three clones a built-in material's uniforms when it compiles
 *    the program, and cloning a texture uniform makes a second `Texture` that
 *    shares the source but not the upload bookkeeping: a clone of a data
 *    texture that is updated later samples black. So the shared uniform
 *    objects are put back into the program's uniforms in `onBeforeCompile`,
 *    patched onto `Material.prototype`, after the clone.
 *  - **Colour space.** three applies fog *after* encoding the fragment to sRGB.
 *    The haze is a linear display value like the terrain's, so the chunk
 *    decodes, mixes and re-encodes; mixing in sRGB would put a visible step
 *    between an aircraft and the ground behind it at the same distance.
 *
 * Custom shaders (terrain, particles) include `ATMO_GLSL` and call
 * `atmoApply` themselves.
 */

import {
  DataTexture,
  HalfFloatType,
  LinearFilter,
  ClampToEdgeWrapping,
  Material,
  RGBAFormat,
  ShaderChunk,
} from 'three';

import { LUT_HALF, LUT_HEIGHT, LUT_WIDTH } from './model';

/** vec4 slots in the shared uniform array. */
const ATMO_VEC4S = 6;

/**
 * Layout (see `packAtmosphere` in `./index.ts`):
 * [0] planet centre (render space), planet radius
 * [1] Rayleigh extinction rgb (per metre, sea level), Rayleigh scale height
 * [2] Mie extinction, Mie scale height, horizon dip (rad), enabled flag
 * [3] sun direction (unit), sky exposure of the disc
 * [4] sunlight on surfaces rgb (tint x strength), skylight on surfaces
 * [5] skylight tint rgb (luminance about 1: the colour shadows take), unused
 */
export const atmoData = new Float32Array(ATMO_VEC4S * 4);

export const skyLut = new DataTexture(
  new Uint16Array(LUT_WIDTH * LUT_HEIGHT * 4),
  LUT_WIDTH,
  LUT_HEIGHT,
  RGBAFormat,
  HalfFloatType,
);
skyLut.minFilter = LinearFilter;
skyLut.magFilter = LinearFilter;
skyLut.wrapS = ClampToEdgeWrapping;
skyLut.wrapT = ClampToEdgeWrapping;
skyLut.generateMipmaps = false;
skyLut.name = 'sky lut';

export const ATMO_UNIFORMS = {
  atmo: { value: atmoData },
  atmoLut: { value: skyLut },
};

export const ATMO_GLSL = /* glsl */ `
uniform vec4 atmo[${ATMO_VEC4S}];
uniform sampler2D atmoLut;

// Sea-level-equivalent air along a straight segment through an exponential
// profile. A transcription of column() in @/render/sky/model.
float atmoColumn(float len, float h0, float h1, float scaleH) {
  h0 = max(h0, 0.0);
  h1 = max(h1, 0.0);
  float dh = h1 - h0;
  if (abs(dh) < 1.0) return exp(-h0 / scaleH) * len;
  return abs(scaleH * (len / dh) * (exp(-h0 / scaleH) - exp(-h1 / scaleH)));
}

// Per-channel transmittance from the eye to a point: blue dies first.
vec3 atmoTransmittance(vec3 worldPos) {
  float len = length(worldPos - cameraPosition);
  float radius = atmo[0].w;
  float hEye = length(cameraPosition - atmo[0].xyz) - radius;
  float hPoint = length(worldPos - atmo[0].xyz) - radius;
  float colR = atmoColumn(len, hEye, hPoint, atmo[1].w);
  float colM = atmoColumn(len, hEye, hPoint, atmo[2].y);
  return exp(-atmo[1].rgb * colR - atmo[2].x * colM);
}

// Where a direction lands in the sky table. See lutU / lutV in the model:
// azimuth from the sun (square-root spaced), elevation from the true horizon.
vec2 atmoLutUv(vec3 dir, float lutHalf) {
  vec3 up = normalize(cameraPosition - atmo[0].xyz);
  float s = clamp(dot(dir, up), -1.0, 1.0);
  float elevation = asin(s);
  vec3 sun = atmo[3].xyz;
  vec3 dirH = dir - up * s;
  vec3 sunH = sun - up * dot(sun, up);
  float cosAz = dot(dirH, sunH) * inversesqrt(max(dot(dirH, dirH) * dot(sunH, sunH), 1e-12));
  float u = sqrt(acos(clamp(cosAz, -1.0, 1.0)) / PI);
  float dip = atmo[2].z;
  float l = elevation + dip;
  float v = l >= 0.0
    ? 0.5 + 0.5 * sqrt(min(1.0, l / (1.5707963 + dip)))
    : 0.5 - 0.5 * sqrt(min(1.0, -l / (1.5707963 - dip)));
  // Half a texel in from the edges of this half, so the filter never blends
  // the sky rows into the haze rows.
  v = clamp(v, 0.5 / ${LUT_HALF.toFixed(1)}, 1.0 - 0.5 / ${LUT_HALF.toFixed(1)});
  return vec2(u, (v + lutHalf) * 0.5);
}

vec3 atmoSky(vec3 dir) { return texture2D(atmoLut, atmoLutUv(dir, 0.0)).rgb; }
vec3 atmoHaze(vec3 dir) { return texture2D(atmoLut, atmoLutUv(dir, 1.0)).rgb; }

// Haze a linear display colour seen at worldPos.
vec3 atmoApply(vec3 color, vec3 worldPos) {
  if (atmo[2].w < 0.5) return color;
  vec3 tr = atmoTransmittance(worldPos);
  return color * tr + atmoHaze(normalize(worldPos - cameraPosition)) * (1.0 - tr);
}

// The same for light that only adds (fire, glows): it dims, it does not
// turn into sky.
vec3 atmoApplyAdditive(vec3 color, vec3 worldPos) {
  if (atmo[2].w < 0.5) return color;
  return color * atmoTransmittance(worldPos);
}

vec3 atmoToLinear(vec3 c) {
  return mix(c * 0.0773993808, pow(c * 0.9478672986 + vec3(0.0521327014), vec3(2.4)), vec3(greaterThan(c, vec3(0.04045))));
}
vec3 atmoToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), vec3(greaterThan(c, vec3(0.0031308))));
}
`;

let installed = false;

/**
 * Replace three's fog with the atmosphere, once. Idempotent; must run before
 * the first material compiles, which importing this module from the engine
 * guarantees.
 */
export function installAtmosphere(): void {
  if (installed) return;
  installed = true;

  ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vAtmoWorld;
#endif
`;
  // World position from the view-space one: the view matrix is rigid, so
  // its inverse is the transpose of the rotation applied after removing the
  // translation — cheaper than carrying another matrix, and it works for
  // instanced, skinned and morphed meshes alike because mvPosition already
  // includes all of that.
  ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vAtmoWorld = (mvPosition.xyz - viewMatrix[3].xyz) * mat3(viewMatrix);
#endif
`;
  ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vAtmoWorld;
  ${ATMO_GLSL}
#endif
`;
  ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  gl_FragColor.rgb = atmoToSrgb(atmoApply(atmoToLinear(gl_FragColor.rgb), vAtmoWorld));
#endif
`;

  const proto = Material.prototype as Material & {
    onBeforeCompile: (shader: { uniforms: Record<string, unknown> }) => void;
  };
  proto.onBeforeCompile = function atmosphereUniforms(shader) {
    // After three has cloned the material's uniforms: put the shared objects
    // back so updates reach this program. Unused uniforms are ignored.
    shader.uniforms['atmo'] = ATMO_UNIFORMS.atmo;
    shader.uniforms['atmoLut'] = ATMO_UNIFORMS.atmoLut;
  };
}
