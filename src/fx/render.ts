/**
 * The effects simulation (`./sim`) on the globe: ONE sorted, instanced draw
 * call for every smoke, dust, fire and spark particle, an instanced mesh of
 * tumbling debris, and a flickering point light at the fire.
 *
 * Premultiplied-alpha blending unifies additive fire and alpha-blended smoke,
 * so fire seen through smoke and smoke in front of fire both composite
 * correctly — the one thing two separate pools (the sandbox's first effects)
 * could never get right. Every particle looks different and moves: the shader
 * derives a mirror flip, a noise offset and an animation rate from its seed
 * and scrolls a tiling noise texture through it — puffs boil and fray and are
 * lit like volumes by the sun, fireballs are a rolling temperature field that
 * cools patch by patch into soot, flames are tongues licking upward, sparks
 * are motion-blurred streaks.
 *
 * ## The frame
 *
 * The simulation runs in a local tangent frame (x east, y up, z south) whose
 * anchor stays near the camera; the group carrying the meshes maps it into
 * render space every frame, so a floating-origin rebase moves nothing. When
 * the camera has flown `REANCHOR_M` from the anchor, everything alive is moved
 * into a new frame, so the local vertical never visibly tilts.
 *
 * ## Haze and depth
 *
 * The renderer uses a logarithmic depth buffer and the atmosphere of
 * `@/render/sky`, not three's fog: the shader opts into both. Smoke far away
 * sinks into the haze; fire, which only adds light, just dims.
 *
 * Adapted from Tater's Flight Sim (https://github.com/JaredTate/tatertotsflightsim),
 * MIT licence, Copyright (c) 2026 Jared Tate — see ./LICENSE.
 */

import {
  AddEquation,
  Color,
  CustomBlending,
  DataTexture,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PerspectiveCamera,
  PointLight,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  ShaderMaterial,
  Vector3,
  Vector4,
  BoxGeometry,
  type BufferAttribute,
  type BufferGeometry,
} from 'three';

import type { FloatingOrigin } from '@/core/frame';
import { ATMO_GLSL, ATMO_UNIFORMS, atmoData } from '@/render/sky/shader';
import { FX } from './config';
import { particleAlpha, particleHeat, particleSize, type ParticlePool } from './pool';
import { FIRE_GLSL } from './shading';
import { createSortScratch, sortBackToFront } from './sort';
import { generateNoiseTexture, generateParticleAtlas } from './sprites';
import { FxSim } from './sim';

/** Metres the camera may fly from the frame's anchor before it moves. */
const REANCHOR_M = 25_000;
/** The animation clock wraps (seconds) to keep float precision in the shader. */
const TIME_WRAP = 3600;
const FIRE_LIGHT = new Color(0xff8a3a);
const FLASH_LIGHT = new Color(0xffd9a8);

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 iPos;    // xyz, diameter
attribute vec4 iParams; // rotation, opacity, heat, tile
attribute vec4 iColor;  // albedo, fire glow at the particle
attribute vec4 iExtra;  // ground height under it, seed, age / life, aspect (width / height)
attribute vec4 iVel;    // velocity (m/s)
uniform vec3 uSunView;
uniform float uNearFade;
uniform float uMaxCover;
uniform float uViewportH;
uniform float uMinPx;
uniform float uShutter;
varying vec2 vQ;
varying vec4 vVar;
varying vec3 vLight;
varying vec2 vUpS;
varying vec4 vColor;
varying vec4 vFx;
varying vec2 vGround;
varying float vPhase;
varying float vStreak;
varying vec3 vWorld;
${FIRE_GLSL}
void main() {
  float size = iPos.w;
  float tile = iParams.w;
  float kind = tile < 3.5 ? 0.0 : (tile < 7.5 ? 1.0 : 2.0); // puff, flame, spark
  vec4 va = variation(iExtra.y);
  vec4 mvPosition = modelViewMatrix * vec4(iPos.xyz, 1.0);
  vWorld = (modelMatrix * vec4(iPos.xyz, 1.0)).xyz;
  float depth = -mvPosition.z;
  float p11 = projectionMatrix[1][1];
  float px = size * p11 * 0.5 * uViewportH / max(depth, 0.05);
  float grow = pixelScale(px, uMinPx);
  size *= grow;
  float fade = iParams.y / (grow * grow) * smoothstep(0.1 * size * uNearFade, size * uNearFade, depth) * coverFade(size, depth, p11, uMaxCover);
  mat3 mv = mat3(modelViewMatrix);
  vec3 upV = mv * vec3(0.0, 1.0, 0.0);
  vec2 corner = position.xy;
  vec2 k = corner;
  float rot = iParams.x;
  float streak = 1.0;
  if (kind > 1.5) {
    vec3 vv = mv * iVel.xyz;
    float len = length(vv.xy) * uShutter;
    vec2 ax = length(vv.xy) > 1e-4 ? normalize(vv.xy) : vec2(0.0, 1.0);
    rot = atan(-ax.x, ax.y);
    streak = 1.0 + len / max(size, 1e-3);
    k.y *= streak;
  } else if (kind > 0.5) {
    vec3 axisW = normalize(vec3(iVel.x * 0.35, max(iVel.y, 0.0) * 0.25 + 1.0, iVel.z * 0.35));
    vec3 axisV = mv * axisW;
    float l = length(axisV.xy);
    rot = (l > 1e-3 ? atan(-axisV.x, axisV.y) : iParams.x) + iParams.x;
    float side = smoothstep(0.2, 0.75, l);
    float asp = clamp(iExtra.w, 0.1, 10.0);
    float tall = mix(1.0, inversesqrt(asp), side) * (1.0 + 0.05 * side * max(iVel.y, 0.0));
    float wide = mix(1.0, sqrt(asp), side);
    k = vec2(corner.x * wide, corner.y * tall + 0.3 * tall * side);
  }
  float c = cos(rot);
  float s = sin(rot);
  vec2 off = vec2(c * k.x - s * k.y, s * k.x + c * k.y) * size;
  mvPosition.xy += off;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  if (fade < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vQ = corner;
  vVar = vec4(va.z, va.w, variationRate(iExtra.y), clamp(iExtra.z, 0.0, 1.0));
  vLight = vec3(c * uSunView.x + s * uSunView.y, -s * uSunView.x + c * uSunView.y, uSunView.z);
  vUpS = vec2(c * upV.x + s * upV.y, -s * upV.x + c * upV.y);
  float cosT = dot(normalize(mvPosition.xyz), uSunView);
  vPhase = 0.64 / pow(1.36 - 1.2 * cosT, 1.5);
  vColor = iColor;
  // The sprite's offset back in the local frame: its height over the ground.
  vec3 localOff = vec3(off, 0.0) * mv;
  vGround = vec2(iPos.y + localOff.y - iExtra.x, 1.0 / max(0.05, 0.25 * size));
  vFx = vec4(fade, iParams.z, kind, tile + (va.x < 0.0 ? 16.0 : 0.0));
  vStreak = streak;
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMO_GLSL}
uniform sampler2D uAtlas;
uniform sampler2D uNoise;
uniform float uTime;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uGlowColor;
uniform float uGlowFloor;
uniform float uFireIntensity;
uniform float uFireOcclusion;
uniform float uSparkIntensity;
uniform float uSelfShadow;
varying vec2 vQ;
varying vec4 vVar;
varying vec3 vLight;
varying vec2 vUpS;
varying vec4 vColor;
varying vec4 vFx;
varying vec2 vGround;
varying float vPhase;
varying float vStreak;
varying vec3 vWorld;
${FIRE_GLSL}
// Scene-linear light to a display value, the way every lit material ends.
vec3 finishColor(vec3 c) {
  #ifdef TONE_MAPPING
    c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
vec2 tileUv(float tile, vec2 q) {
  q = clamp(q, -0.5, 0.5);
  return (vec2(mod(tile, 4.0), floor(tile / 4.0)) + q + 0.5) / vec2(4.0, 2.0);
}
void main() {
  #include <logdepthbuf_fragment>
  float kind = vFx.z;
  float heat = vFx.y;
  float flip = vFx.w >= 16.0 ? -1.0 : 1.0;
  float tile = vFx.w - (flip < 0.0 ? 16.0 : 0.0);
  float groundFade = clamp(vGround.x * vGround.y, 0.0, 1.0);
  float base = vFx.x * groundFade;
  if (base < 0.002) discard;
  float a;
  float T = 0.0;
  float occ = 1.0;
  float emisK = uFireIntensity;
  vec3 lit = vec3(0.0);
  if (kind > 1.5) {
    vec2 p = vec2(vQ.x, vQ.y * vStreak);
    p.y = max(abs(p.y) - 0.5 * (vStreak - 1.0), 0.0);
    float d2 = dot(p, p) * 4.0;
    a = exp(-5.0 * d2) * smoothstep(1.0, 0.6, d2) * base * inversesqrt(vStreak);
    if (a < 0.002) discard;
    T = heat;
    occ = 0.0;
    emisK = uFireIntensity * uSparkIntensity;
  } else if (kind > 0.5) {
    vec2 q = vec2(vQ.x * flip, vQ.y);
    float h = vQ.y + 0.5;
    float tt = uTime * vVar.z;
    vec2 nq = vec2(q.x * 0.7, q.y * 0.45 - tt * 0.9) + vVar.xy;
    vec4 n1 = texture2D(uNoise, nq);
    vec4 n2 = texture2D(uNoise, nq * 2.3 + (n1.rg - 0.5) * 0.3 + vec2(0.37, 0.61 - tt * 0.5));
    vec2 d = vec2((n1.r - 0.5) * 0.38 + (n2.g - 0.5) * 0.14, (n1.g - 0.5) * 0.1) * (0.25 + h);
    vec4 env = texture2D(uAtlas, tileUv(tile, q + d));
    float brk = smoothstep(0.0, 0.35, n2.b * 0.8 + n1.a * 0.4 + (1.0 - h) * 0.75 - 0.45);
    a = env.a * brk * base;
    if (a < 0.002) discard;
    T = flameTemperature(heat, env.b + (n2.r - 0.5) * 0.3, h);
    occ = mix(0.2 + 0.6 * h, uFireOcclusion, smoothstep(0.3, 0.9, T));
    lit = vColor.rgb * uAmbient;
  } else {
    vec2 q = vec2(vQ.x * flip, vQ.y);
    float age = vVar.w;
    float hot = smoothstep(0.02, 0.3, heat);
    float tt = uTime * vVar.z * mix(0.05, 0.35, hot);
    vec4 n = texture2D(uNoise, q * 0.6 + vVar.xy + vec2(tt * 0.6, -tt));
    vec2 uq = q + (n.rg - 0.5) * (0.08 + 0.08 * age + 0.12 * hot);
    vec4 tex = texture2D(uAtlas, tileUv(tile, uq));
    float dens = smokeErosion(tex.a, n.b * 0.6 + n.a * 0.4, age);
    a = dens * base;
    if (a < 0.002) discard;
    vec3 nrm = vec3((tex.rg * 2.0 - 1.0) * vec2(flip, 1.0), 0.0);
    nrm.z = sqrt(max(0.0, 1.0 - dot(nrm.xy, nrm.xy)));
    vec3 L = normalize(vLight);
    float diff = clamp(dot(nrm, L) * 0.6 + 0.4, 0.0, 1.0);
    float toward = texture2D(uAtlas, tileUv(tile, uq + vec2(L.x * flip, L.y) * 0.22)).a;
    float sh = mix(1.0, selfShadow(toward + tex.b * max(-L.z, 0.0)), uSelfShadow);
    float phase = mix(1.0, clamp(vPhase, 0.25, 4.0), (1.0 - tex.a) * 0.75);
    float ao = mix(1.0, 0.6, tex.b * tex.a);
    vec3 albedo = vColor.rgb;
    float below = clamp(0.55 - 0.5 * dot(nrm.xy, vUpS), 0.15, 1.0);
    lit = albedo * (uAmbient * ao + uSunColor * diff * sh * phase) + max(albedo, vec3(uGlowFloor)) * uGlowColor * vColor.a * below;
    if (heat > 0.004) {
      T = fireballTemperature(heat, tex.b, n.a * 0.55 + n.b * 0.45) * smoothstep(0.08, 0.55, dens);
      occ = mix(1.0, uFireOcclusion, smoothstep(0.3, 0.9, T));
    }
  }
  vec3 emis = T > 0.0 ? fireRamp(T) * emisK : vec3(0.0);
  float aOcc = a * occ;
  // Haze in display-linear light, like every other surface (see @/render/sky).
  vec3 litD = atmoToLinear(finishColor(lit));
  vec3 emisD = atmoToLinear(finishColor(emis));
  if (atmo[2].w > 0.5) {
    vec3 tr = atmoTransmittance(vWorld);
    litD = litD * tr + atmoHaze(normalize(vWorld - cameraPosition)) * (1.0 - tr);
    emisD *= tr;
  }
  gl_FragColor = vec4(atmoToSrgb(litD) * aOcc + atmoToSrgb(emisD) * a, aOcc);
}
`;

function debrisGeometry(): BufferGeometry {
  const g = new BoxGeometry(1, 0.06, 0.65, 3, 1, 2);
  const p = g.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    p.setY(i, p.getY(i) + 0.12 * Math.sin(x * 7.1 + z * 3.3) + 0.08 * Math.cos(z * 9.7));
  }
  g.computeVertexNormals();
  return g;
}

interface Local {
  x: number;
  y: number;
  z: number;
}

export class FxRenderer {
  readonly group = new Group();
  readonly sim = new FxSim(FX.seed);

  /** The local frame: its anchor (absolute ECEF) and unit axes. */
  private readonly anchor = new Vector3();
  private readonly east = new Vector3();
  private readonly up = new Vector3();
  private readonly north = new Vector3();
  private anchored = false;

  private readonly geo = new InstancedBufferGeometry();
  private readonly mat: ShaderMaterial;
  private readonly mesh: Mesh;
  private readonly attrs: InstancedBufferAttribute[];
  private readonly iPos: InstancedBufferAttribute;
  private readonly iParams: InstancedBufferAttribute;
  private readonly iColor: InstancedBufferAttribute;
  private readonly iExtra: InstancedBufferAttribute;
  private readonly iVel: InstancedBufferAttribute;
  private readonly atlas: DataTexture;
  private readonly noise: DataTexture;
  private readonly debris: InstancedMesh;
  private readonly debrisGeo = debrisGeometry();
  private readonly debrisMat = new MeshLambertMaterial({ color: 0xffffff });
  private readonly light = new PointLight(0xff8a3a, 0, FX.fireLightDistance, 2);

  private readonly depth: Float32Array;
  private readonly ref: Int32Array;
  private readonly order: Int32Array;
  private readonly scratch;
  private clock = 0;
  private drawn = 0;

  constructor(private readonly origin: FloatingOrigin) {
    const cap = this.sim.smoke.capacity + this.sim.fire.capacity;
    this.group.name = 'fx';
    this.group.matrixAutoUpdate = false;

    const atlasData = generateParticleAtlas(128, FX.seed & 0xffff);
    this.atlas = new DataTexture(atlasData.data, atlasData.width, atlasData.height, RGBAFormat);
    this.atlas.generateMipmaps = true;
    this.atlas.minFilter = LinearMipmapLinearFilter;
    this.atlas.magFilter = LinearFilter;
    this.atlas.needsUpdate = true;
    const noiseData = generateNoiseTexture(FX.noiseSize, (FX.seed + 7) & 0xffff);
    this.noise = new DataTexture(noiseData.data, noiseData.width, noiseData.height, RGBAFormat);
    this.noise.wrapS = this.noise.wrapT = RepeatWrapping;
    this.noise.generateMipmaps = true;
    this.noise.minFilter = LinearMipmapLinearFilter;
    this.noise.magFilter = LinearFilter;
    this.noise.needsUpdate = true;

    this.geo.setAttribute('position', new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (n: number) => new InstancedBufferAttribute(new Float32Array(cap * n), n).setUsage(DynamicDrawUsage);
    this.iPos = attr(4);
    this.iParams = attr(4);
    this.iColor = attr(4);
    this.iExtra = attr(4);
    this.iVel = attr(4);
    this.attrs = [this.iPos, this.iParams, this.iColor, this.iExtra, this.iVel];
    this.geo.setAttribute('iPos', this.iPos);
    this.geo.setAttribute('iParams', this.iParams);
    this.geo.setAttribute('iColor', this.iColor);
    this.geo.setAttribute('iExtra', this.iExtra);
    this.geo.setAttribute('iVel', this.iVel);
    this.geo.instanceCount = 0;

    this.mat = new ShaderMaterial({
      uniforms: {
        ...ATMO_UNIFORMS,
        uAtlas: { value: this.atlas },
        uNoise: { value: this.noise },
        uTime: { value: 0 },
        uSunView: { value: new Vector3(0, 1, 0) },
        uSunColor: { value: new Color(1.0, 0.96, 0.9) },
        uAmbient: { value: new Color(0.32, 0.37, 0.46) },
        uGlowColor: { value: new Color(...FX.smokeGlow) },
        uGlowFloor: { value: FX.glowFloor },
        uFireIntensity: { value: FX.fireIntensity },
        uFireOcclusion: { value: FX.fireOcclusion },
        uSparkIntensity: { value: FX.sparkIntensity },
        uSelfShadow: { value: FX.selfShadow },
        uNearFade: { value: FX.nearFade },
        uMaxCover: { value: FX.maxScreenCover },
        uViewportH: { value: 900 },
        uMinPx: { value: FX.minPixels },
        uShutter: { value: FX.shutter },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.mat.blending = CustomBlending;
    this.mat.blendEquation = AddEquation;
    this.mat.blendSrc = OneFactor;
    this.mat.blendDst = OneMinusSrcAlphaFactor;
    this.mat.blendSrcAlpha = OneFactor;
    this.mat.blendDstAlpha = OneMinusSrcAlphaFactor;
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.name = 'fx-particles';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    const viewport = new Vector4();
    this.mesh.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(viewport);
      if (viewport.w > 0) (this.mat.uniforms.uViewportH as { value: number }).value = viewport.w;
    };
    this.group.add(this.mesh);

    this.debris = new InstancedMesh(this.debrisGeo, this.debrisMat, this.sim.debris.capacity);
    this.debris.instanceMatrix.setUsage(DynamicDrawUsage);
    const white = new Color(1, 1, 1);
    for (let i = 0; i < this.sim.debris.capacity; i++) this.debris.setColorAt(i, white);
    this.debris.count = 0;
    this.debris.frustumCulled = false;
    this.group.add(this.debris);

    // Always present, dark when idle: adding a light later would recompile
    // every lit material in the scene.
    this.group.add(this.light);

    this.depth = new Float32Array(cap);
    this.ref = new Int32Array(cap);
    this.order = new Int32Array(cap);
    this.scratch = createSortScratch(cap);
  }

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  /** A point in absolute ECEF, in the local frame (written into `out`). */
  toLocal(x: number, y: number, z: number, out: Local = { x: 0, y: 0, z: 0 }): Local {
    if (!this.anchored) this.setAnchor(x, y, z);
    const dx = x - this.anchor.x;
    const dy = y - this.anchor.y;
    const dz = z - this.anchor.z;
    out.x = dx * this.east.x + dy * this.east.y + dz * this.east.z;
    out.y = dx * this.up.x + dy * this.up.y + dz * this.up.z;
    out.z = -(dx * this.north.x + dy * this.north.y + dz * this.north.z);
    return out;
  }

  /** A direction (velocity) in ECEF axes, in the local frame. */
  vectorToLocal(x: number, y: number, z: number, out: Local = { x: 0, y: 0, z: 0 }): Local {
    out.x = x * this.east.x + y * this.east.y + z * this.east.z;
    out.y = x * this.up.x + y * this.up.y + z * this.up.z;
    out.z = -(x * this.north.x + y * this.north.y + z * this.north.z);
    return out;
  }

  /** A height above the ellipsoid at an ECEF point, as a local y (for the ground under an event). */
  heightToLocalY(x: number, y: number, z: number, heightAboveM: number): number {
    // The point `heightAboveM` below this one along its own vertical.
    const r = Math.hypot(x, y, z) || 1;
    return this.toLocal(x - (x / r) * heightAboveM, y - (y / r) * heightAboveM, z - (z / r) * heightAboveM).y;
  }

  private setAnchor(x: number, y: number, z: number): void {
    const r = Math.hypot(x, y, z) || 1;
    this.anchor.set(x, y, z);
    // Geocentric vertical: close enough to geodetic for a frame that only has
    // to make smoke rise upward.
    this.up.set(x / r, y / r, z / r);
    this.east.set(-y, x, 0);
    if (this.east.lengthSq() < 1e-9) this.east.set(1, 0, 0);
    this.east.normalize();
    this.north.crossVectors(this.up, this.east).normalize();
    this.anchored = true;
  }

  /** Move the frame to (x, y, z), carrying everything alive with it. */
  private reanchor(x: number, y: number, z: number): void {
    const oldAnchor = this.anchor.clone();
    const e0 = this.east.clone();
    const u0 = this.up.clone();
    const n0 = this.north.clone();
    this.setAnchor(x, y, z);
    const w = new Vector3();
    const toEcef = (p: Local, withOrigin: boolean) => {
      w.set(0, 0, 0).addScaledVector(e0, p.x).addScaledVector(u0, p.y).addScaledVector(n0, -p.z);
      if (withOrigin) w.add(oldAnchor);
    };
    this.sim.transform(
      (p) => {
        toEcef(p, true);
        this.toLocal(w.x, w.y, w.z, p);
      },
      (v) => {
        toEcef(v, false);
        this.vectorToLocal(w.x, w.y, w.z, v);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Per frame
  // -------------------------------------------------------------------------

  /**
   * Step and draw. After the camera has been placed for the frame. `wind` is
   * the air's velocity in the local frame, m/s.
   */
  update(camera: PerspectiveCamera, dtIn: number, wind: Local | null): void {
    const o = this.origin.current;
    const camX = camera.position.x + o[0];
    const camY = camera.position.y + o[1];
    const camZ = camera.position.z + o[2];
    if (!this.anchored) this.setAnchor(camX, camY, camZ);
    else if (Math.hypot(camX - this.anchor.x, camY - this.anchor.y, camZ - this.anchor.z) > REANCHOR_M) {
      this.reanchor(camX, camY, camZ);
    }

    // Local frame → render space.
    _basis.makeBasis(this.east, this.up, _south.copy(this.north).negate());
    _basis.setPosition(this.anchor.x - o[0], this.anchor.y - o[1], this.anchor.z - o[2]);
    this.group.matrix.copy(_basis);
    this.group.matrixWorldNeedsUpdate = true;
    this.group.updateMatrixWorld(true);

    const dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 0.25) : 0;
    if (dt > 0) {
      this.sim.step(dt, wind?.x ?? 0, wind?.y ?? 0, wind?.z ?? 0);
      this.clock = (this.clock + dt) % TIME_WRAP;
      (this.mat.uniforms.uTime as { value: number }).value = this.clock;
    }

    this.drawParticles(camX, camY, camZ, camera);
    this.drawDebris();
    this.updateLight();
    this.updateSun(camera);
  }

  private drawParticles(camX: number, camY: number, camZ: number, camera: PerspectiveCamera): void {
    const cam = this.toLocal(camX, camY, camZ, _camLocal);
    const e = camera.matrixWorld.elements;
    const fwd = this.vectorToLocal(-e[8]!, -e[9]!, -e[10]!, _fwdLocal);
    const { smoke, fire } = this.sim;
    const pools = [smoke, fire];
    let n = 0;
    for (let pi = 0; pi < 2; pi++) {
      const p = pools[pi]!;
      for (let i = 0; i < p.capacity; i++) {
        if (!p.alive[i]) continue;
        const d = (p.px[i] - cam.x) * fwd.x + (p.py[i] - cam.y) * fwd.y + (p.pz[i] - cam.z) * fwd.z;
        const size = particleSize(p, i);
        if (!(d > -size) || particleAlpha(p, i) < 0.003) continue;
        this.depth[n] = d;
        this.ref[n] = pi === 0 ? i : -1 - i;
        n++;
      }
    }
    sortBackToFront(this.depth, n, this.order, this.scratch);
    for (let k = 0; k < n; k++) {
      const r = this.ref[this.order[k]!]!;
      if (r >= 0) this.writeInstance(k, smoke, r);
      else this.writeInstance(k, fire, -1 - r);
    }
    this.drawn = n;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      for (const a of this.attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * 4);
        a.needsUpdate = true;
      }
    }
  }

  private writeInstance(slot: number, p: ParticlePool, i: number): void {
    const o = slot * 4;
    const pos = this.iPos.array as Float32Array;
    const par = this.iParams.array as Float32Array;
    const col = this.iColor.array as Float32Array;
    const ex = this.iExtra.array as Float32Array;
    const vel = this.iVel.array as Float32Array;
    const t = p.age[i] / p.life[i];
    const light = 1 + p.lighten[i] * t;
    pos[o] = p.px[i]; pos[o + 1] = p.py[i]; pos[o + 2] = p.pz[i]; pos[o + 3] = particleSize(p, i);
    par[o] = p.rot[i]; par[o + 1] = particleAlpha(p, i); par[o + 2] = particleHeat(p, i); par[o + 3] = p.tile[i];
    col[o] = Math.min(1, p.r[i] * light); col[o + 1] = Math.min(1, p.g[i] * light); col[o + 2] = Math.min(1, p.b[i] * light);
    col[o + 3] = this.sim.glowAt(p.px[i], p.py[i], p.pz[i]);
    ex[o] = Math.max(-1e6, p.groundY[i]); ex[o + 1] = p.seed[i]; ex[o + 2] = Math.min(1, Math.max(0, t)); ex[o + 3] = p.aspect[i];
    vel[o] = p.vx[i]; vel[o + 1] = p.vy[i]; vel[o + 2] = p.vz[i]; vel[o + 3] = 0;
  }

  private drawDebris(): void {
    const d = this.sim.debris;
    let m = 0;
    for (let i = 0; i < d.capacity; i++) {
      if (!d.alive[i]) continue;
      const sd = d.seed[i];
      _axis.set(Math.sin(sd * 91.7), Math.cos(sd * 47.3), Math.sin(sd * 13.1 + 1)).normalize();
      _q.setFromAxisAngle(_axis, d.rot[i]);
      const sc = particleSize(d, i);
      _v.set(d.px[i], d.py[i] + 0.04 * sc, d.pz[i]);
      _s.set(sc, sc, sc);
      _m.compose(_v, _q, _s);
      this.debris.setMatrixAt(m, _m);
      const burn = Math.min(1, particleHeat(d, i) * 3);
      this.debris.setColorAt(m, _c.setRGB(d.r[i] * (1 - 0.8 * burn), d.g[i] * (1 - 0.8 * burn), d.b[i] * (1 - 0.8 * burn)));
      m++;
    }
    this.debris.count = m;
    if (m > 0) {
      this.debris.instanceMatrix.needsUpdate = true;
      if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;
    }
  }

  private updateLight(): void {
    const sim = this.sim;
    const fireI = FX.fireLightIntensity * sim.fireLevel;
    const flashI = FX.flashLightIntensity * sim.flashLevel;
    // Candela grows with the square of the size, so a big fire lights as far,
    // relative to its size, as a small one.
    const s = Math.max(1, sim.flashScale);
    this.light.intensity = (fireI + flashI) * s * s;
    this.light.distance = FX.fireLightDistance * s;
    const p = flashI > fireI ? sim.flashPos : sim.firePos;
    this.light.position.set(p.x, p.y, p.z);
    this.light.color.copy(FIRE_LIGHT).lerp(FLASH_LIGHT, flashI / Math.max(1e-6, fireI + flashI));
    this.light.updateMatrixWorld();
  }

  /** Sun and sky light for the smoke, from the atmosphere's own numbers. */
  private updateSun(camera: PerspectiveCamera): void {
    const u = this.mat.uniforms;
    (u.uSunView!.value as Vector3).set(atmoData[12]!, atmoData[13]!, atmoData[14]!).transformDirection(camera.matrixWorldInverse);
    // Relative to noon (1 = midday sun), which is what the smoke was tuned in.
    (u.uSunColor!.value as Color).setRGB(atmoData[16]!, atmoData[17]!, atmoData[18]!);
    const sky = Math.max(0.05, atmoData[19]!);
    (u.uAmbient!.value as Color).setRGB(0.32 * sky, 0.37 * sky, 0.46 * sky);
  }

  get stats(): { drawn: number; smoke: number; fire: number; debris: number } {
    return { drawn: this.drawn, smoke: this.sim.smoke.count, fire: this.sim.fire.count, debris: this.sim.debris.count };
  }

  clear(): void {
    this.sim.reset();
    this.geo.instanceCount = 0;
    this.mesh.visible = false;
    this.debris.count = 0;
    this.light.intensity = 0;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.atlas.dispose();
    this.noise.dispose();
    this.debrisGeo.dispose();
    this.debrisMat.dispose();
    this.debris.dispose();
    this.light.dispose();
  }
}

const _basis = new Matrix4();
const _south = new Vector3();
const _camLocal: Local = { x: 0, y: 0, z: 0 };
const _fwdLocal: Local = { x: 0, y: 0, z: 0 };
const _m = new Matrix4();
const _q = new Quaternion();
const _v = new Vector3();
const _s = new Vector3();
const _axis = new Vector3();
const _c = new Color();
