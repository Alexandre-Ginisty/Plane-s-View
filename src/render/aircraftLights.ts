/**
 * The lights every aircraft carries, drawn as glowing points.
 *
 * At night an aeroplane is its lights. Seen from another aircraft, traffic is
 * a red and a green point and a white one astern, a red beacon pulsing on the
 * spine and the belly, and the white double flash of the wingtip strobes —
 * visible from tens of kilometres, long after the airframe itself is lost in
 * the dark. By day the strobes still catch the eye; the rest wash out.
 *
 * Fitted to the model actually drawn (`lightAnchorsFor`): the wingtips, the
 * tail cone, the crown and the belly of that airframe, so a light sits on the
 * skin rather than a metre or two off it. Without a model — traffic far
 * beyond the drawing range, seen at night as nothing but its lights — they
 * are placed from the type's nominal shape, where an error that size is far
 * below a pixel.
 *
 * One `Points` object for all of it: a vertex per light, rewritten each frame
 * in render space. The flashing is done in the shader from a per-light phase,
 * so a beacon's rhythm costs nothing on the CPU and no two aircraft flash in
 * step.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Points,
  ShaderMaterial,
  Vector3,
  type Matrix4,
} from 'three';

import type { AirframeShape } from './aircraft';
import type { LightAnchors } from './aircraft/lightAnchors';
import type { SceneLight } from './sky/model';

/** Steady, beacon (a red pulse a second), strobe (a white double flash), landing light. */
const STEADY = 0;
const BEACON = 1;
const STROBE = 2;
const LANDING = 3;

const CAPACITY = 6000;

const RED: readonly [number, number, number] = [1, 0.12, 0.08];
const GREEN: readonly [number, number, number] = [0.15, 1, 0.35];
const WHITE: readonly [number, number, number] = [1, 0.97, 0.9];
const LANDING_WHITE: readonly [number, number, number] = [1, 0.95, 0.82];

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 tint;
  attribute vec2 light; // x: kind, y: phase
  uniform float time;
  uniform float night;
  uniform float pxPerRad;
  varying vec3 vTint;
  varying float vGain;

  float pulse(float t, float at, float width) {
    float d = abs(t - at);
    return 1.0 - smoothstep(0.0, width, d);
  }

  void main() {
    float kind = light.x;
    float t = time + light.y;
    float gain;
    float glowM; // the halo's size in metres at the light
    if (kind < 0.5) {
      // Nav lights: washed out by day.
      gain = mix(0.18, 1.0, night);
      glowM = 0.6;
    } else if (kind < 1.5) {
      // Beacon: a pulse a second.
      gain = pulse(fract(t * 1.0), 0.08, 0.09) * mix(0.35, 1.2, night);
      glowM = 1.0;
    } else if (kind < 2.5) {
      // Strobes: two flashes in quick succession, every 1.2 s.
      float f = fract(t / 1.2);
      gain = max(pulse(f, 0.03, 0.025), pulse(f, 0.16, 0.025)) * 1.6;
      glowM = 2.0;
    } else {
      // Landing lights: bright, and brighter by night.
      gain = mix(0.45, 1.3, night);
      glowM = 2.4;
    }
    vTint = tint;
    vGain = gain;

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(length(mv.xyz), 1.0);
    // Nudged towards the eye, a fitting's depth, so the skin it sits on does
    // not eat it. Along the line of sight: it does not move on screen.
    mv.xyz *= (d - min(0.5, d * 0.5)) / d;
    gl_Position = projectionMatrix * mv;
    // Physical size, but never smaller than a point the eye still picks out —
    // a light in the dark is visible long after its source has no size at all.
    float px = glowM / d * pxPerRad;
    float floorPx = mix(1.5, 4.0, night) * step(0.02, gain);
    gl_PointSize = clamp(px, floorPx, 64.0);
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec3 vTint;
  varying float vGain;
  void main() {
    #include <logdepthbuf_fragment>
    if (vGain < 0.01) discard;
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    // A hot core and a soft halo.
    float core = exp(-r2 * 18.0);
    float halo = exp(-r2 * 4.0) * 0.45;
    vec3 c = mix(vTint, vec3(1.0), core * 0.7);
    gl_FragColor = vec4(c * (core + halo) * vGain, 1.0);
  }
`;

const _p = new Vector3();

/** A stable number per aircraft, so its lights flash in their own rhythm. */
export function lightSeed(hex: string): number {
  let h = 0;
  for (let i = 0; i < hex.length; i++) h = (h * 31 + hex.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export class AircraftLights {
  readonly points: Points;
  private readonly positions = new Float32Array(CAPACITY * 3);
  private readonly tints = new Float32Array(CAPACITY * 3);
  private readonly kinds = new Float32Array(CAPACITY * 2);
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;
  private count = 0;
  /** 0 by day, 1 at night: how much the steady lights matter. */
  night = 0;

  constructor() {
    const pos = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    const tint = new BufferAttribute(this.tints, 3).setUsage(DynamicDrawUsage);
    const light = new BufferAttribute(this.kinds, 2).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', pos);
    this.geometry.setAttribute('tint', tint);
    this.geometry.setAttribute('light', light);
    this.geometry.setDrawRange(0, 0);
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { time: { value: 0 }, night: { value: 0 }, pxPerRad: { value: 800 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    this.points.renderOrder = 3;
    this.points.name = 'aircraft-lights';
  }

  /** How dark it is, from the light the models get. */
  setLight(light: SceneLight): void {
    // Skylight runs from a night floor of 0.12 to 1 at full day.
    this.night = Math.min(1, Math.max(0, (0.62 - light.skyStrength) / 0.42));
  }

  /** Start a frame's lights. */
  begin(): void {
    this.count = 0;
  }

  /**
   * One aircraft's lights. `matrix` places the unit-length model in render
   * space, scale included (length along +Y, span along X, up +Z); `seed`
   * keeps its flashing out of step with everyone else's.
   */
  add(matrix: Matrix4, shape: AirframeShape, seed: number, landing: boolean, anchors: LightAnchors | null = null): void {
    if (this.count + 9 > CAPACITY) return;
    const phase = (seed % 997) / 997;
    if (anchors) {
      this.fitted(matrix, shape, anchors, phase, landing);
      return;
    }
    const r = shape.radiusRatio;
    if (shape.kind === 'rotorcraft') {
      this.put(matrix, -r * 1.1, 0.05, 0, RED, STEADY, 0);
      this.put(matrix, r * 1.1, 0.05, 0, GREEN, STEADY, 0);
      this.put(matrix, 0, -0.5, r * 0.4, WHITE, STEADY, 0);
      this.put(matrix, 0, 0.0, r * 1.25, RED, BEACON, phase);
      this.put(matrix, 0, 0.1, -r * 1.2, RED, BEACON, phase + 0.5);
      if (landing) this.put(matrix, 0, 0.32, -r * 1.0, LANDING_WHITE, LANDING, 0);
      return;
    }
    const half = shape.spanRatio / 2;
    const sweep = Math.tan((shape.sweepDeg * Math.PI) / 180);
    const dihedral = Math.tan((shape.dihedralDeg * Math.PI) / 180);
    // The wing's root about a twentieth forward of centre, the tip swept back from it.
    const tipY = 0.04 - half * sweep * 0.95;
    const tipZ = -r * 0.35 + half * dihedral;
    const tipX = half * 0.995;
    this.put(matrix, -tipX, tipY, tipZ, RED, STEADY, 0);
    this.put(matrix, tipX, tipY, tipZ, GREEN, STEADY, 0);
    this.put(matrix, -tipX, tipY - 0.012, tipZ, WHITE, STROBE, phase);
    this.put(matrix, tipX, tipY - 0.012, tipZ, WHITE, STROBE, phase);
    // Tail cone: the white position light, and a strobe on the larger types.
    this.put(matrix, 0, -0.495, r * 0.5, WHITE, STEADY, 0);
    if (shape.kind === 'jet' && shape.length > 25) this.put(matrix, 0, -0.5, r * 0.55, WHITE, STROBE, phase + 0.02);
    // Anti-collision beacons, spine and belly, alternating.
    this.put(matrix, 0, 0.02, r * 1.08, RED, BEACON, phase);
    this.put(matrix, 0, 0.06, -r * 1.08, RED, BEACON, phase + 0.5);
    // Landing lights in the wing roots (or the nose gear on small types).
    if (landing) {
      this.put(matrix, -r * 1.9, 0.1, -r * 0.55, LANDING_WHITE, LANDING, 0);
      this.put(matrix, r * 1.9, 0.1, -r * 0.55, LANDING_WHITE, LANDING, 0);
    }
  }

  /** The same lights, on the model's own skin (see `lightAnchorsFor`). */
  private fitted(m: Matrix4, shape: AirframeShape, a: LightAnchors, phase: number, landing: boolean): void {
    const [tx, ty, tz] = a.tip;
    if (shape.kind === 'rotorcraft') {
      // Nav lights on the widest point of the cabin, at mid-height.
      const z = (a.top[2] + a.belly[2]) / 2;
      this.put(m, -tx, ty, z, RED, STEADY, 0);
      this.put(m, tx, ty, z, GREEN, STEADY, 0);
    } else {
      this.put(m, -tx, ty, tz, RED, STEADY, 0);
      this.put(m, tx, ty, tz, GREEN, STEADY, 0);
      // Strobes share the tip fitting, just aft of the nav light.
      this.put(m, -tx, ty - 0.006, tz, WHITE, STROBE, phase);
      this.put(m, tx, ty - 0.006, tz, WHITE, STROBE, phase);
    }
    this.put(m, a.tail[0], a.tail[1], a.tail[2], WHITE, STEADY, 0);
    if (shape.kind === 'jet' && shape.length > 25) this.put(m, a.tail[0], a.tail[1] + 0.003, a.tail[2], WHITE, STROBE, phase + 0.02);
    this.put(m, a.top[0], a.top[1], a.top[2], RED, BEACON, phase);
    this.put(m, a.belly[0], a.belly[1], a.belly[2], RED, BEACON, phase + 0.5);
    if (landing) {
      const [lx, ly, lz] = a.landing;
      if (shape.kind === 'rotorcraft') this.put(m, 0, ly, a.belly[2], LANDING_WHITE, LANDING, 0);
      else {
        this.put(m, -lx, ly, lz, LANDING_WHITE, LANDING, 0);
        this.put(m, lx, ly, lz, LANDING_WHITE, LANDING, 0);
      }
    }
  }

  private put(m: Matrix4, x: number, y: number, z: number, c: readonly [number, number, number], kind: number, phase: number): void {
    _p.set(x, y, z).applyMatrix4(m);
    const i = this.count++;
    this.positions[i * 3] = _p.x;
    this.positions[i * 3 + 1] = _p.y;
    this.positions[i * 3 + 2] = _p.z;
    this.tints[i * 3] = c[0];
    this.tints[i * 3 + 1] = c[1];
    this.tints[i * 3 + 2] = c[2];
    this.kinds[i * 2] = kind;
    this.kinds[i * 2 + 1] = phase * 1.2;
  }

  /**
   * Hand the frame's lights to the GPU. `pxPerRad` is the screen's pixels per
   * radian at the view's centre, so a light's halo has a physical size.
   */
  commit(timeS: number, pxPerRad: number): void {
    this.material.uniforms['time']!.value = timeS;
    this.material.uniforms['night']!.value = this.night;
    this.material.uniforms['pxPerRad']!.value = pxPerRad;
    this.geometry.setDrawRange(0, this.count);
    for (const name of ['position', 'tint', 'light']) {
      const a = this.geometry.getAttribute(name) as BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
