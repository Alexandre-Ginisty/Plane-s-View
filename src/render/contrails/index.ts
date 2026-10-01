/**
 * Contrails behind the real traffic.
 *
 * Whether an aircraft leaves one is physics (`./physics`): the air's
 * temperature — measured by the aircraft where it broadcasts it — and the
 * weather model's humidity aloft. Where it goes is history: the track's own
 * recorded fixes, each carried downwind by the measured wind for as long as
 * it has been in the air, and sinking with the wake vortices that roll it up.
 *
 * ## What it looks like
 *
 * A camera-facing ribbon per aircraft, resampled along the path by arc length
 * — finely just behind the tail, where it forms, coarsely kilometres back —
 * through a Catmull–Rom curve so a turn is a curve and not a chain of fixes.
 * Across the ribbon the shader draws the plumes: one per engine at first,
 * drawn into the two wingtip vortices within seconds, merging into one band
 * that spreads as it ages. Optical depth falls as it spreads (the ice is
 * conserved), so an old trail is a wide, faint veil. Ice scatters forward: a
 * trail between the eye and the sun glows.
 *
 * One draw call for all of them, the nearest `MAX_TRAILS`, rebuilt each frame
 * in render space.
 */

import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector3,
} from 'three';

import type { FloatingOrigin } from '@/core/frame';
import { FEET_TO_METRES, geodeticToEcef } from '@/core/math/geo';
import type { AloftLevel } from '@/data/types';
import type { WindField } from '@/data/weather/wind';
import type { SampledAircraft } from '@/state/traffic';
import type { TrailPoint } from '@/state/track';
import type { AirframeShape } from '@/render/aircraft/typeTable';
import type { SceneLight } from '@/render/sky/model';
import { ATMO_GLSL, ATMO_UNIFORMS } from '@/render/sky/shader';
import { airAt, trailFor, type AirAt, type TrailVerdict } from './physics';

/** How many aircraft get a trail: the nearest. */
const MAX_TRAILS = 20;
/** Trails further than this are not drawn, metres. */
const RANGE_M = 80_000;
/** Resampled points per trail, at most. */
const MAX_SAMPLES = 150;
/** The oldest point drawn, seconds: the track history rarely reaches further. */
const MAX_AGE_S = 600;
/** Seconds between re-deciding an aircraft's trail. */
const VERDICT_REFRESH_S = 3;
const VERTS = MAX_TRAILS * MAX_SAMPLES * 2;

const DEG = Math.PI / 180;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 shape;  // x: across (−1/+1), y: half-width m, z: plume radius m, w: opacity
attribute vec4 plumes; // x: inner offset m, y: outer offset m, z: outer weight, w: metres along
varying vec4 vShape;
varying vec4 vPlumes;
varying vec3 vWorld;
void main() {
  vShape = shape;
  vPlumes = plumes;
  vWorld = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMO_GLSL}
uniform vec3 uSun;
uniform vec3 uSky;
varying vec4 vShape;
varying vec4 vPlumes;
varying vec3 vWorld;

float hash(float n) { return fract(sin(n) * 43758.5453); }
float noise(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash(i), hash(i + 1.0), f * f * (3.0 - 2.0 * f));
}
float plume(float y, float c, float r) {
  float d = (abs(y) - c) / r;
  return exp(-0.5 * d * d);
}
vec3 finishColor(vec3 c) {
  #ifdef TONE_MAPPING
    c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
void main() {
  #include <logdepthbuf_fragment>
  float y = vShape.x * vShape.y;
  float r = max(vShape.z, 0.5);
  float inner = plume(y, vPlumes.x, r);
  float outer = plume(y, vPlumes.y, r) * vPlumes.z;
  // The line-of-sight integral through a gaussian tube is a gaussian of the
  // same width, its peak falling as the tube spreads.
  float depth = (inner + outer) / (1.0 + vPlumes.z) * 3.2 / sqrt(r / 2.0);
  // Clumping along the trail: the vortex instability, broadening with scale.
  float s = vPlumes.w / max(8.0 * r, 40.0);
  depth *= 0.7 + 0.6 * noise(s) * (0.6 + 0.4 * noise(s * 3.7 + 11.0));
  float a = (1.0 - exp(-depth)) * vShape.w;
  // A trail the camera is inside, or nearly, is not drawn as a wall of white.
  vec3 toFrag = vWorld - cameraPosition;
  a *= smoothstep(4.0, 30.0, length(toFrag));
  if (a < 0.003) discard;
  vec3 view = normalize(toFrag);
  // Ice crystals: a bright forward lobe, a flat remainder.
  float cosT = dot(view, atmo[3].xyz);
  float phase = 0.55 + 2.2 * pow(max(cosT, 0.0), 8.0) + 0.25 * cosT * cosT;
  vec3 lit = uSun * phase + uSky;
  vec3 c = atmoToLinear(finishColor(lit));
  if (atmo[2].w > 0.5) {
    vec3 tr = atmoTransmittance(vWorld);
    c = c * tr + atmoHaze(view) * (1.0 - tr);
  }
  gl_FragColor = vec4(atmoToSrgb(c) * a, a);
}
`;

/** What the trails need from the rest of the app each frame. */
export interface ContrailInputs {
  /** The recorded fixes of an aircraft, oldest first. */
  trailOf(hex: string): readonly TrailPoint[] | undefined;
  /** Its airframe. */
  shapeOf(sample: SampledAircraft): AirframeShape;
  wind: WindField;
  /** The weather model's air aloft, or null. */
  aloft: readonly AloftLevel[] | null;
  /** Epoch ms of the frame, the clock the fixes are stamped in. */
  nowMs: number;
}

interface Chosen {
  sample: SampledAircraft;
  dSq: number;
  verdict: TrailVerdict;
}

const _air: AirAt = { pressureHpa: 0, tempC: 0, rhWater: 0 };
const _wind = { east: 0, north: 0 };
const _p = new Vector3();
const _t = new Vector3();
const _side = new Vector3();
const _toCam = new Vector3();

export class Contrails {
  readonly mesh: Mesh;
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;
  private readonly positions = new Float32Array(VERTS * 3);
  private readonly shapes = new Float32Array(VERTS * 4);
  private readonly plumeData = new Float32Array(VERTS * 4);
  private readonly verdicts = new Map<string, { at: number; verdict: TrailVerdict }>();
  private readonly chosen: Chosen[] = [];
  /** The control polyline of one trail: render-space xyz and age, per point. */
  private readonly ctrl = new Float64Array(260 * 4);
  private readonly cum = new Float64Array(260);

  constructor(private readonly origin: FloatingOrigin) {
    const index = new Uint32Array(MAX_TRAILS * (MAX_SAMPLES - 1) * 6);
    let k = 0;
    for (let t = 0; t < MAX_TRAILS; t++) {
      for (let i = 0; i < MAX_SAMPLES - 1; i++) {
        const a = (t * MAX_SAMPLES + i) * 2;
        index[k++] = a;
        index[k++] = a + 1;
        index[k++] = a + 2;
        index[k++] = a + 1;
        index[k++] = a + 3;
        index[k++] = a + 2;
      }
    }
    this.geometry.setIndex(new BufferAttribute(index, 1));
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('shape', new BufferAttribute(this.shapes, 4).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('plumes', new BufferAttribute(this.plumeData, 4).setUsage(DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...ATMO_UNIFORMS, uSun: { value: new Vector3(1, 1, 1) }, uSky: { value: new Vector3(0.3, 0.35, 0.45) } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'contrails';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 2;
  }

  /** The sunlight and skylight the ice scatters. */
  setLight(light: SceneLight): void {
    const s = light.sunStrength * 1.15;
    (this.material.uniforms['uSun']!.value as Vector3).set(light.sunColor[0] * s, light.sunColor[1] * s, light.sunColor[2] * s);
    const k = light.skyStrength * 0.55;
    (this.material.uniforms['uSky']!.value as Vector3).set(light.skyColor[0] * k, light.skyColor[1] * k, light.skyColor[2] * k);
  }

  update(samples: readonly SampledAircraft[], cameraRender: Vector3, input: ContrailInputs): void {
    const o = this.origin.current;
    const nowS = input.nowMs / 1000;
    const chosen = this.chosen;
    chosen.length = 0;
    const rangeSq = RANGE_M * RANGE_M;

    for (const sample of samples) {
      if (sample.latest.onGround || sample.stale) continue;
      const altM = sample.altFt * FEET_TO_METRES;
      if (altM < 7000) continue;
      const e = geodeticToEcef(sample.lat, sample.lon, altM);
      const dx = e[0] - o[0] - cameraRender.x;
      const dy = e[1] - o[1] - cameraRender.y;
      const dz = e[2] - o[2] - cameraRender.z;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq > rangeSq) continue;
      if (chosen.length === MAX_TRAILS && dSq >= chosen[MAX_TRAILS - 1]!.dSq) continue;
      const verdict = this.verdictFor(sample, altM, input, nowS);
      if (verdict.density <= 0) continue;
      // Kept sorted, nearest first; the list is short.
      let i = Math.min(chosen.length, MAX_TRAILS - 1);
      if (chosen.length < MAX_TRAILS) chosen.push({ sample, dSq, verdict });
      else chosen[i] = { sample, dSq, verdict };
      while (i > 0 && chosen[i - 1]!.dSq > chosen[i]!.dSq) {
        const tmp = chosen[i - 1]!;
        chosen[i - 1] = chosen[i]!;
        chosen[i] = tmp;
        i--;
      }
    }

    let trails = 0;
    for (const c of chosen) {
      if (this.buildTrail(trails, c, cameraRender, input)) trails++;
    }

    // Forget verdicts of aircraft long gone.
    if (this.verdicts.size > 4000) this.verdicts.clear();

    this.geometry.setDrawRange(0, trails * (MAX_SAMPLES - 1) * 6);
    for (const name of ['position', 'shape', 'plumes']) {
      const a = this.geometry.getAttribute(name) as BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, trails * MAX_SAMPLES * 2 * a.itemSize);
      a.needsUpdate = true;
    }
    this.mesh.visible = trails > 0;
  }

  private verdictFor(sample: SampledAircraft, altM: number, input: ContrailInputs, nowS: number): TrailVerdict {
    const memo = this.verdicts.get(sample.hex);
    if (memo && nowS - memo.at < VERDICT_REFRESH_S) return memo.verdict;
    const verdict = memo?.verdict ?? { density: 0, lifeS: 0, persistent: false };
    trailFor(altM, airAt(altM, sample.latest.oatC, input.aloft, _air), verdict);
    // Piston and turboprop exhaust at these heights is rare and thin; rotorcraft never get here.
    const shape = input.shapeOf(sample);
    if (shape.kind !== 'jet') verdict.density *= 0.5;
    this.verdicts.set(sample.hex, { at: nowS, verdict });
    return verdict;
  }

  /** Write trail number `slot`; false when there is nothing to draw. */
  private buildTrail(slot: number, c: Chosen, cam: Vector3, input: ContrailInputs): boolean {
    const { sample, verdict } = c;
    const fixes = input.trailOf(sample.hex);
    if (!fixes || fixes.length === 0) return false;
    const o = this.origin.current;
    const shape = input.shapeOf(sample);
    const length = shape.length;
    const span = shape.length * shape.spanRatio;
    const altM = sample.altFt * FEET_TO_METRES;
    const life = Math.min(verdict.lifeS, MAX_AGE_S);

    // Local east, north and up at the aircraft, for the drift.
    const lat = sample.lat * DEG;
    const lon = sample.lon * DEG;
    const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
    input.wind.at(altM, Number.POSITIVE_INFINITY, _wind);
    const wx = -so * _wind.east - sl * co * _wind.north;
    const wy = co * _wind.east - sl * so * _wind.north;
    const wz = cl * _wind.north;
    const ux = cl * co, uy = cl * so, uz = sl;
    // Wake vortices carry the trail down, then stop: a hundred-odd metres for a heavy.
    const sinkMax = Math.min(250, 2.2 * span);

    // Control points: the aircraft now, then its fixes back in time.
    const ctrl = this.ctrl;
    let n = 0;
    const push = (latDeg: number, lonDeg: number, alt: number, age: number) => {
      const e = geodeticToEcef(latDeg, lonDeg, alt);
      const sink = sinkMax * (1 - Math.exp(-age / 40));
      ctrl[n * 4] = e[0] - o[0] + wx * age - ux * sink;
      ctrl[n * 4 + 1] = e[1] - o[1] + wy * age - uy * sink;
      ctrl[n * 4 + 2] = e[2] - o[2] + wz * age - uz * sink;
      ctrl[n * 4 + 3] = age;
      n++;
    };
    push(sample.lat, sample.lon, altM, 0);
    for (let i = fixes.length - 1; i >= 0 && n < 256; i--) {
      const f = fixes[i]!;
      const age = (input.nowMs - f.t) / 1000;
      if (age <= 0.5) continue; // at or ahead of the drawn aircraft
      push(f.lat, f.lon, f.altFt * FEET_TO_METRES, age);
      if (age > life) break;
    }
    if (n < 2) return false;

    const cum = this.cum;
    cum[0] = 0;
    for (let i = 1; i < n; i++) {
      const dx = ctrl[i * 4]! - ctrl[i * 4 - 4]!;
      const dy = ctrl[i * 4 + 1]! - ctrl[i * 4 - 3]!;
      const dz = ctrl[i * 4 + 2]! - ctrl[i * 4 - 2]!;
      cum[i] = cum[i - 1]! + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const total = cum[n - 1]!;

    // Engines: where the plumes start, as offsets from the centreline.
    const semi = span / 2;
    let inner0: number, outer0: number, outerW: number;
    if (shape.engines === 4) {
      inner0 = semi * 0.36;
      outer0 = semi * 0.62;
      outerW = 1;
    } else if (shape.engineMount === 'wing') {
      inner0 = semi * 0.3;
      outer0 = 0;
      outerW = 0;
    } else {
      inner0 = Math.max(1.5, length * 0.05);
      outer0 = 0;
      outerW = 0;
    }
    const vortex = semi * (Math.PI / 4);
    const spread = verdict.persistent ? 0.12 : 0;

    // Resample: finely where it forms, coarser with distance. The trail
    // leaves the engines — just aft of the wing for engines under it, by the
    // tail for engines on the rear fuselage — and thickens over the first few
    // tens of metres as the exhaust cools and freezes.
    const start = length * (shape.engineMount === 'wing' ? 0.06 : 0.36);
    const formation = Math.max(length * 0.6, 12);
    let s = start;
    let seg = 0;
    const base = slot * MAX_SAMPLES * 2;
    let k = 0;
    for (; k < MAX_SAMPLES; k++) {
      const last = k === MAX_SAMPLES - 1 || s >= total;
      if (s > total) s = total;
      while (seg < n - 2 && cum[seg + 1]! < s) seg++;
      const segLen = cum[seg + 1]! - cum[seg]!;
      const t = segLen > 0 ? (s - cum[seg]!) / segLen : 0;
      this.curve(seg, n, t, _p, _t);
      const age = ctrl[seg * 4 + 3]! + (ctrl[seg * 4 + 7]! - ctrl[seg * 4 + 3]!) * t;

      // Across: facing the eye.
      _toCam.subVectors(cam, _p);
      _side.crossVectors(_t, _toCam);
      const sl2 = _side.lengthSq();
      if (sl2 > 1e-9) _side.multiplyScalar(1 / Math.sqrt(sl2));
      else _side.set(ux, uy, uz);

      // Plumes drawn into the vortices within seconds, merged within a couple of minutes.
      const roll = 1 - Math.exp(-age / 6);
      const merge = Math.exp(-age / 70);
      const inner = (inner0 + (vortex - inner0) * roll) * merge;
      const outer = (outer0 + (vortex - outer0) * roll) * merge;
      // A plume a couple of metres across at the nozzle, some four by ten
      // seconds, tens of metres after a minute (jet, then vortex phase);
      // persistent trails go on spreading with the shear.
      const radius = 0.6 + 0.04 * length * Math.min(1, age / 2) + 0.9 * Math.sqrt(age) + spread * age;
      const half = Math.max(inner, outerW > 0 ? outer : 0) + radius * 2.2;

      // Forms a fuselage length behind the tail; fades at the end of its life.
      const born = Math.min(1, Math.max(0, (s - start) / formation));
      const fade = 1 - Math.min(1, Math.max(0, (age - life * 0.6) / (life * 0.4)));
      const alpha = verdict.density * born * fade;

      for (let side = 0; side < 2; side++) {
        const sign = side === 0 ? -1 : 1;
        const v = base + k * 2 + side;
        this.positions[v * 3] = _p.x + _side.x * half * sign;
        this.positions[v * 3 + 1] = _p.y + _side.y * half * sign;
        this.positions[v * 3 + 2] = _p.z + _side.z * half * sign;
        this.shapes[v * 4] = sign;
        this.shapes[v * 4 + 1] = half;
        this.shapes[v * 4 + 2] = radius;
        this.shapes[v * 4 + 3] = alpha;
        this.plumeData[v * 4] = inner;
        this.plumeData[v * 4 + 1] = outer;
        this.plumeData[v * 4 + 2] = outerW;
        this.plumeData[v * 4 + 3] = s;
      }
      if (last) break;
      s += Math.max(6, (s - start) * 0.07);
    }
    // Collapse the unused tail of the slot onto the last point: zero-area triangles.
    for (let j = k + 1; j < MAX_SAMPLES; j++) {
      for (let side = 0; side < 2; side++) {
        const from = base + k * 2 + side;
        const to = base + j * 2 + side;
        this.positions.copyWithin(to * 3, from * 3, from * 3 + 3);
        this.shapes[to * 4 + 3] = 0;
      }
    }
    return true;
  }

  /** Catmull–Rom through the control points, segment `i` at `t`: point and unit tangent. */
  private curve(i: number, n: number, t: number, out: Vector3, tangent: Vector3): void {
    const c = this.ctrl;
    const i0 = Math.max(0, i - 1) * 4;
    const i1 = i * 4;
    const i2 = Math.min(n - 1, i + 1) * 4;
    const i3 = Math.min(n - 1, i + 2) * 4;
    const t2 = t * t;
    const t3 = t2 * t;
    for (let a = 0; a < 3; a++) {
      const p0 = c[i0 + a]!, p1 = c[i1 + a]!, p2 = c[i2 + a]!, p3 = c[i3 + a]!;
      const v = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
      const d = 0.5 * (-p0 + p2 + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t2);
      out.setComponent(a, v);
      tangent.setComponent(a, d);
    }
    const l = tangent.length();
    if (l > 1e-9) tangent.multiplyScalar(1 / l);
    else tangent.set(c[i2]! - c[i1]!, c[i2 + 1]! - c[i1 + 1]!, c[i2 + 2]! - c[i1 + 2]!).normalize();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.verdicts.clear();
  }
}
