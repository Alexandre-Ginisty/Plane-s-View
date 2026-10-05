/**
 * The frame after the scene: bloom, the sun's glare and lens flare.
 *
 * ## Where the scene is drawn
 *
 * Into an offscreen half-float target, multisampled, with a 32-bit float
 * depth buffer. Two things come of that:
 *
 *  - **Depth.** With float depth and three's reversed depth range (where the
 *    browser has `EXT_clip_control`), precision is a constant fraction of the
 *    distance — a millimetre at ten kilometres — so the logarithmic depth
 *    buffer is no longer needed. That one writes `gl_FragDepth` from every
 *    fragment, which switches off the GPU's early depth rejection: every
 *    hidden pixel of terrain, fuselage and cockpit was shaded and thrown
 *    away. Without it, hidden pixels are skipped before they are shaded.
 *  - **Range.** Materials still tone-map and encode exactly as they would
 *    onto the screen (the target is flagged as an output target, see
 *    `outputTarget`), so the picture is unchanged — but light that only adds
 *    (aircraft lights, strobes, fire, the sun's disc) is free to go past
 *    white instead of clipping, and what is past white is what glows.
 *
 * ## Bloom
 *
 * A soft threshold just under white, then a mip chain from a quarter of the
 * resolution down: each level a four-tap downsample, then back up with a tent filter,
 * each level added to the one above. Every pass after the first runs at a
 * quarter of the pixels of the one before, so the whole chain costs about a
 * third of one full-screen pass. A NaN or infinity in the scene — one bad
 * normal is enough — is zeroed in the first pass: blurred, a single invalid
 * pixel would otherwise spread into a black block across the screen.
 *
 * ## The sun
 *
 * Whether the sun is seen is read off the frame itself: a one-pixel pass
 * samples the scene around the disc, and only a disc brighter than white
 * counts, so terrain, a wing or the cockpit frame in front of it put the
 * flare out. Smoothed over a few frames so it fades rather than flickers.
 */

import {
  AddEquation,
  CustomBlending,
  DepthTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoBlending,
  OneFactor,
  OrthographicCamera,
  BufferGeometry,
  BufferAttribute,
  SRGBColorSpace,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type Texture,
  type WebGLRenderer,
} from 'three';

import { projectAhead } from '../projection';

/**
 * Levels in the bloom chain, from a quarter of the resolution down. A glow is
 * soft by nature: starting at half resolution cost four times the pixels for
 * a difference nobody could point to, and the four-tap threshold pass still
 * reads every full-resolution pixel, so a one-pixel light is never missed.
 */
const LEVELS = 5;
/** Seconds the sun's visibility keeps being read after it leaves the screen, to let the flare fade. */
const SUN_LINGER_S = 0.6;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const SANITIZE = /* glsl */ `
vec3 sanitize(vec3 c) {
  if (any(isnan(c)) || any(isinf(c))) return vec3(0.0);
  return clamp(c, vec3(0.0), vec3(64.0));
}
`;

const PREFILTER = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 texel;
uniform float threshold;
uniform float knee;
varying vec2 vUv;
${SANITIZE}
vec3 tap(vec2 o) { return sanitize(texture2D(tSource, vUv + o * texel).rgb); }
void main() {
  // Sixteen texels in four bilinear taps: no shimmer as the view moves.
  vec3 c = (tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0))) * 0.25;
  float b = max(c.r, max(c.g, c.b));
  float soft = clamp(b - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float k = max(soft, b - threshold) / max(b, 1e-4);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

const DOWN = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSource, vUv).rgb * 4.0;
  c += texture2D(tSource, vUv + vec2(-1.0, -1.0) * texel).rgb;
  c += texture2D(tSource, vUv + vec2(1.0, -1.0) * texel).rgb;
  c += texture2D(tSource, vUv + vec2(-1.0, 1.0) * texel).rgb;
  c += texture2D(tSource, vUv + vec2(1.0, 1.0) * texel).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}
`;

const UP = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 texel;
uniform float weight;
varying vec2 vUv;
void main() {
  // 3x3 tent, added onto the level above by the blend state.
  vec3 c = texture2D(tSource, vUv).rgb * 4.0;
  c += (texture2D(tSource, vUv + vec2(-texel.x, 0.0)).rgb + texture2D(tSource, vUv + vec2(texel.x, 0.0)).rgb +
        texture2D(tSource, vUv + vec2(0.0, -texel.y)).rgb + texture2D(tSource, vUv + vec2(0.0, texel.y)).rgb) * 2.0;
  c += texture2D(tSource, vUv + vec2(-texel.x, -texel.y)).rgb + texture2D(tSource, vUv + vec2(texel.x, -texel.y)).rgb +
       texture2D(tSource, vUv + vec2(-texel.x, texel.y)).rgb + texture2D(tSource, vUv + vec2(texel.x, texel.y)).rgb;
  gl_FragColor = vec4(c / 16.0 * weight, 1.0);
}
`;

const SUN_VIS = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tPrevious;
uniform vec2 sunUv;
uniform vec2 texel;
uniform float onScreen;
varying vec2 vUv;
${SANITIZE}
void main() {
  float seen = 0.0;
  // Twelve taps over the disc, about five pixels across at a typical field of view.
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    float r = i < 6 ? 1.5 : 3.0;
    vec3 c = sanitize(texture2D(tScene, sunUv + vec2(cos(a), sin(a)) * r * texel).rgb);
    seen += smoothstep(1.0, 1.25, max(c.r, max(c.g, c.b)));
  }
  float now = seen / 12.0 * onScreen;
  float before = texture2D(tPrevious, vec2(0.5)).r;
  gl_FragColor = vec4(mix(before, now, 0.3), 0.0, 0.0, 1.0);
}
`;

const COMPOSITE = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tSunVis;
uniform float bloomStrength;
uniform vec2 sunUv;
uniform vec3 sunColor;
uniform float flareStrength;
uniform float aspect;
varying vec2 vUv;
${SANITIZE}

float disc(vec2 uv, vec2 at, float r, float soft) {
  float d = length((uv - at) * vec2(aspect, 1.0));
  return 1.0 - smoothstep(r * (1.0 - soft), r, d);
}

vec3 flare(vec2 uv) {
  vec2 axis = vec2(0.5) - sunUv;
  vec3 acc = vec3(0.0);
  // Ghosts down the line through the centre, each a lens element's reflection.
  acc += vec3(0.30, 0.55, 1.00) * disc(uv, sunUv + axis * 0.55, 0.035, 0.6) * 0.18;
  acc += vec3(0.95, 0.75, 0.35) * disc(uv, sunUv + axis * 0.85, 0.06, 0.8) * 0.10;
  acc += vec3(0.40, 1.00, 0.55) * disc(uv, sunUv + axis * 1.25, 0.022, 0.5) * 0.22;
  acc += vec3(0.85, 0.45, 1.00) * disc(uv, sunUv + axis * 1.6, 0.09, 0.9) * 0.07;
  acc += vec3(0.55, 0.80, 1.00) * disc(uv, sunUv + axis * 2.1, 0.045, 0.7) * 0.12;
  // A faint ring about the centre.
  float ring = length((uv - (sunUv + axis * 1.0)) * vec2(aspect, 1.0));
  acc += vec3(0.6, 0.75, 1.0) * smoothstep(0.02, 0.0, abs(ring - 0.28)) * 0.05;
  // Glare about the sun: a soft glow and a thin horizontal streak.
  vec2 d = (uv - sunUv) * vec2(aspect, 1.0);
  float l = length(d);
  acc += vec3(1.0) * (0.012 / (l + 0.012)) * 0.35;
  acc += vec3(1.0) * exp(-abs(d.y) * 260.0) * exp(-abs(d.x) * 5.0) * 0.18;
  return acc * sunColor;
}

float dither(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
}

void main() {
  vec3 c = sanitize(texture2D(tScene, vUv).rgb);
  c += texture2D(tBloom, vUv).rgb * bloomStrength;
  float vis = texture2D(tSunVis, vec2(0.5)).r * flareStrength;
  if (vis > 0.002) c += flare(vUv) * vis;
  // Past white is spent in the glow; what reaches the screen rolls off gently.
  c = mix(c, 1.0 - exp(-c), smoothstep(0.85, 1.6, c));
  c += dither(gl_FragCoord.xy) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}
`;

function pass(fragmentShader: string, uniforms: Record<string, { value: unknown }>): ShaderMaterial {
  return new ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false, blending: NoBlending });
}

function target(w: number, h: number): WebGLRenderTarget {
  const t = new WebGLRenderTarget(w, h, { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false });
  return t;
}

const _sun = new Vector3();

export interface PostOptions {
  /** MSAA samples for the scene target. */
  samples?: number;
}

export class PostPipeline {
  /** Where the scene and the cockpit are drawn. */
  readonly scene: WebGLRenderTarget;
  private readonly mips: WebGLRenderTarget[] = [];
  private sunVis = [target(1, 1), target(1, 1)];
  private readonly quad: Mesh;
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly prefilter: ShaderMaterial;
  private readonly down: ShaderMaterial;
  private readonly up: ShaderMaterial;
  private readonly sunPass: ShaderMaterial;
  private readonly composite: ShaderMaterial;
  private width = 1;
  private height = 1;
  /** Seconds since the sun was last on screen. */
  private sunAway = Infinity;
  private lastFinish = 0;

  /** Glow on everything past white. */
  bloomStrength = 0.55;
  /** The sun's glare and ghosts; 0 turns them off. */
  flareStrength = 1;

  constructor(private readonly renderer: WebGLRenderer, options: PostOptions = {}) {
    this.scene = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      samples: options.samples ?? 4,
      depthBuffer: true,
      depthTexture: new DepthTexture(1, 1, FloatType),
      // Depth is only for the draw; nothing samples it afterwards.
      resolveDepthBuffer: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
    });
    // An output target: materials tone-map and encode for display into it, as
    // they would onto the canvas, so the picture is unchanged (see header).
    this.scene.texture.colorSpace = SRGBColorSpace;
    (this.scene as { isXRRenderTarget?: boolean }).isXRRenderTarget = true;

    for (let i = 0; i < LEVELS; i++) this.mips.push(target(1, 1));

    this.prefilter = pass(PREFILTER, { tSource: { value: null }, texel: { value: new Vector2() }, threshold: { value: 0.95 }, knee: { value: 0.2 } });
    this.down = pass(DOWN, { tSource: { value: null }, texel: { value: new Vector2() } });
    this.up = pass(UP, { tSource: { value: null }, texel: { value: new Vector2() }, weight: { value: 1 } });
    this.up.blending = CustomBlending;
    this.up.blendEquation = AddEquation;
    this.up.blendSrc = OneFactor;
    this.up.blendDst = OneFactor;
    this.sunPass = pass(SUN_VIS, {
      tScene: { value: null },
      tPrevious: { value: null },
      sunUv: { value: new Vector2() },
      texel: { value: new Vector2() },
      onScreen: { value: 0 },
    });
    this.composite = pass(COMPOSITE, {
      tScene: { value: null },
      tBloom: { value: null },
      tSunVis: { value: null },
      bloomStrength: { value: this.bloomStrength },
      sunUv: { value: new Vector2() },
      sunColor: { value: new Vector3(1, 1, 1) },
      flareStrength: { value: 0 },
      aspect: { value: 1 },
    });

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new Mesh(geometry, this.composite);
    this.quad.frustumCulled = false;
  }

  /** Drawing-buffer size, pixels. */
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.scene.setSize(width, height);
    let w = Math.max(1, width >> 2);
    let h = Math.max(1, height >> 2);
    for (const m of this.mips) {
      m.setSize(w, h);
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
  }

  private draw(material: ShaderMaterial, into: WebGLRenderTarget | null): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(into);
    this.renderer.render(this.quad, this.camera);
  }

  private source(material: ShaderMaterial, texture: Texture, w: number, h: number): void {
    material.uniforms['tSource']!.value = texture;
    (material.uniforms['texel']!.value as Vector2).set(1 / w, 1 / h);
  }

  /**
   * Bloom and flare from the scene target onto the canvas. `sunDirection` is
   * a unit vector in render space; `sunColor` the sunlight's tint times its
   * strength (0 below the horizon).
   */
  finish(camera: Camera, sunDirection: Vector3, sunColor: readonly [number, number, number], sunStrength: number): void {
    const r = this.renderer;
    const autoClear = r.autoClear;
    r.autoClear = false;

    // Bloom: threshold into the first level, down the chain, back up.
    this.source(this.prefilter, this.scene.texture, this.width, this.height);
    this.draw(this.prefilter, this.mips[0]!);
    for (let i = 1; i < LEVELS; i++) {
      const from = this.mips[i - 1]!;
      this.source(this.down, from.texture, from.width, from.height);
      this.draw(this.down, this.mips[i]!);
    }
    for (let i = LEVELS - 1; i > 0; i--) {
      const from = this.mips[i]!;
      this.source(this.up, from.texture, from.width, from.height);
      this.draw(this.up, this.mips[i - 1]!);
    }

    // The sun: where it is on screen, and whether it is seen.
    _sun.copy(sunDirection).multiplyScalar(1e6).add(camera.position);
    const ahead = projectAhead(_sun, camera) && sunStrength > 0.01;
    const sx = _sun.x * 0.5 + 0.5;
    const sy = _sun.y * 0.5 + 0.5;
    const onScreen = ahead && sx > -0.02 && sx < 1.02 && sy > -0.02 && sy < 1.02 ? 1 : 0;
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - this.lastFinish);
    this.lastFinish = now;
    this.sunAway = onScreen ? 0 : this.sunAway + dt;
    // Off screen for long enough that the flare has faded: nothing to read.
    const sunLive = this.flareStrength > 0 && this.sunAway < SUN_LINGER_S;
    let [prev, next] = this.sunVis as [WebGLRenderTarget, WebGLRenderTarget];
    if (sunLive) {
      this.sunPass.uniforms['tScene']!.value = this.scene.texture;
      this.sunPass.uniforms['tPrevious']!.value = prev.texture;
      (this.sunPass.uniforms['sunUv']!.value as Vector2).set(sx, sy);
      (this.sunPass.uniforms['texel']!.value as Vector2).set(1 / this.width, 1 / this.height);
      this.sunPass.uniforms['onScreen']!.value = onScreen;
      this.draw(this.sunPass, next);
      this.sunVis = [next, prev];
    } else {
      next = prev;
    }

    const u = this.composite.uniforms;
    u['tScene']!.value = this.scene.texture;
    u['tBloom']!.value = this.mips[0]!.texture;
    u['tSunVis']!.value = next.texture;
    u['bloomStrength']!.value = this.bloomStrength;
    (u['sunUv']!.value as Vector2).set(sx, sy);
    (u['sunColor']!.value as Vector3).set(sunColor[0], sunColor[1], sunColor[2]);
    u['flareStrength']!.value = sunLive ? this.flareStrength * Math.min(1, sunStrength * 1.5) : 0;
    u['aspect']!.value = this.width / Math.max(1, this.height);
    this.draw(this.composite, null);

    r.autoClear = autoClear;
  }

  dispose(): void {
    this.scene.depthTexture?.dispose();
    this.scene.dispose();
    for (const m of this.mips) m.dispose();
    for (const t of this.sunVis) t.dispose();
    this.quad.geometry.dispose();
    for (const m of [this.prefilter, this.down, this.up, this.sunPass, this.composite]) m.dispose();
  }
}

/**
 * What the device can do, asked of a throwaway context before the real one
 * is made — the renderer's depth mode is fixed at construction.
 */
export function probePost(): { post: boolean; reversedDepth: boolean } {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return { post: false, reversedDepth: false };
    const post = Boolean(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    const reversedDepth = post && Boolean(gl.getExtension('EXT_clip_control'));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { post, reversedDepth };
  } catch {
    return { post: false, reversedDepth: false };
  }
}
