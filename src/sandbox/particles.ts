/**
 * Smoke, fire and sparks: every particle in the sandbox, in two draw calls.
 *
 * ## Why billboards and not points
 *
 * `gl.POINTS` would be one line less, and it has a size limit set by the
 * driver — 64 px on some — which is a fireball seen from a hundred metres.
 * These are instanced quads turned to face the camera in the vertex shader,
 * with no limit.
 *
 * ## Why a shader at all
 *
 * The renderer uses a logarithmic depth buffer, which the built-in materials
 * handle and a hand-written shader has to opt into; the `logdepthbuf` chunks
 * below are that opt-in. Without them the particles would sort against the
 * terrain with ordinary depth and vanish into it or float over it.
 *
 * ## Floating origin
 *
 * Positions are kept in absolute ECEF in double precision and turned into
 * render space every frame, so a rebase under a smoke column does not move
 * the column.
 */

import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  type Blending,
} from 'three';

import type { FloatingOrigin } from '@/core/frame';

const VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aOffset;
attribute vec2 aSizeSpin;
attribute vec4 aColor;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vUv = uv;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
  float c = cos(aSizeSpin.y);
  float s = sin(aSizeSpin.y);
  vec2 corner = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
  mv.xy += corner * aSizeSpin.x;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
  if (gl_FragColor.a < 0.004) discard;
}
`;

/** A soft, lumpy puff, so smoke reads as smoke rather than as discs. */
function puffTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const blob = (x: number, y: number, r: number, a: number): void => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(0.55, `rgba(255,255,255,${a * 0.45})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    };
    blob(64, 64, 60, 0.75);
    // A fixed scatter rather than Math.random: the texture is the same every
    // session, which makes the look reviewable.
    const lumps = [
      [44, 50, 30], [82, 46, 28], [70, 82, 32], [42, 80, 26], [60, 36, 24], [90, 72, 22],
    ] as const;
    for (const [x, y, r] of lumps) blob(x, y, r, 0.35);
  }
  return new CanvasTexture(canvas);
}

interface ParticleSpec {
  /** Absolute ECEF, metres. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size0: number;
  size1: number;
  /** Colour at birth and at death. */
  color0: Color;
  color1: Color;
  alpha: number;
  /** Metres per second squared along `up` — positive rises, negative falls. */
  lift: number;
  /** Fraction of velocity kept per second. */
  drag: number;
}

/** One pool of particles sharing a blend mode. */
class Pool {
  readonly mesh: Mesh;
  private readonly capacity: number;
  private count = 0;
  // Structure of arrays: no object per particle, nothing to collect.
  private readonly pos: Float64Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly c0: Float32Array;
  private readonly c1: Float32Array;
  private readonly lift: Float32Array;
  private readonly drag: Float32Array;
  private readonly spin: Float32Array;
  private readonly offsets: InstancedBufferAttribute;
  private readonly sizeSpin: InstancedBufferAttribute;
  private readonly colors: InstancedBufferAttribute;
  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;

  constructor(capacity: number, blending: Blending, map: CanvasTexture) {
    this.capacity = capacity;
    this.pos = new Float64Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size = new Float32Array(capacity * 2);
    this.c0 = new Float32Array(capacity * 4);
    this.c1 = new Float32Array(capacity * 4);
    this.lift = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.spin = new Float32Array(capacity * 2);

    const quad = new PlaneGeometry(1, 1);
    this.geometry = new InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setAttribute('uv', quad.getAttribute('uv'));
    this.offsets = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage);
    this.sizeSpin = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(DynamicDrawUsage);
    this.colors = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aOffset', this.offsets);
    this.geometry.setAttribute('aSizeSpin', this.sizeSpin);
    this.geometry.setAttribute('aColor', this.colors);
    this.geometry.instanceCount = 0;

    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { map: { value: map } },
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = blending === AdditiveBlending ? 6 : 5;
  }

  get size_(): number {
    return this.count;
  }

  add(p: ParticleSpec): void {
    // Full: overwrite the oldest-born slot rather than drop the newest, so a
    // big explosion still reads even in the middle of a smoke column.
    let i = this.count;
    if (i >= this.capacity) i = Math.floor(Math.random() * this.capacity);
    else this.count++;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = p.vx;
    this.vel[i * 3 + 1] = p.vy;
    this.vel[i * 3 + 2] = p.vz;
    this.age[i] = 0;
    this.life[i] = p.life;
    this.size[i * 2] = p.size0;
    this.size[i * 2 + 1] = p.size1;
    this.c0[i * 4] = p.color0.r;
    this.c0[i * 4 + 1] = p.color0.g;
    this.c0[i * 4 + 2] = p.color0.b;
    this.c0[i * 4 + 3] = p.alpha;
    this.c1[i * 4] = p.color1.r;
    this.c1[i * 4 + 1] = p.color1.g;
    this.c1[i * 4 + 2] = p.color1.b;
    this.c1[i * 4 + 3] = 0;
    this.lift[i] = p.lift;
    this.drag[i] = p.drag;
    this.spin[i * 2] = Math.random() * Math.PI * 2;
    this.spin[i * 2 + 1] = (Math.random() - 0.5) * 1.2;
  }

  update(dt: number, origin: FloatingOrigin): void {
    const o = origin.current;
    let i = 0;
    while (i < this.count) {
      this.age[i]! += dt;
      if (this.age[i]! >= this.life[i]!) {
        this.moveLast(i);
        continue;
      }
      const px = this.pos[i * 3]!;
      const py = this.pos[i * 3 + 1]!;
      const pz = this.pos[i * 3 + 2]!;
      // Local up is the direction away from the Earth's centre.
      const r = Math.hypot(px, py, pz) || 1;
      const keep = Math.pow(this.drag[i]!, dt);
      const lift = this.lift[i]! * dt;
      const vx = (this.vel[i * 3]! + (px / r) * lift) * keep;
      const vy = (this.vel[i * 3 + 1]! + (py / r) * lift) * keep;
      const vz = (this.vel[i * 3 + 2]! + (pz / r) * lift) * keep;
      this.vel[i * 3] = vx;
      this.vel[i * 3 + 1] = vy;
      this.vel[i * 3 + 2] = vz;
      this.pos[i * 3] = px + vx * dt;
      this.pos[i * 3 + 1] = py + vy * dt;
      this.pos[i * 3 + 2] = pz + vz * dt;
      i++;
    }

    const off = this.offsets.array as Float32Array;
    const ss = this.sizeSpin.array as Float32Array;
    const col = this.colors.array as Float32Array;
    for (let j = 0; j < this.count; j++) {
      const t = this.age[j]! / this.life[j]!;
      // Ease out: puffs grow fast and then drift.
      const grow = 1 - (1 - t) * (1 - t);
      off[j * 3] = this.pos[j * 3]! - o[0];
      off[j * 3 + 1] = this.pos[j * 3 + 1]! - o[1];
      off[j * 3 + 2] = this.pos[j * 3 + 2]! - o[2];
      ss[j * 2] = this.size[j * 2]! + (this.size[j * 2 + 1]! - this.size[j * 2]!) * grow;
      ss[j * 2 + 1] = this.spin[j * 2]! + this.spin[j * 2 + 1]! * this.age[j]!;
      for (let k = 0; k < 3; k++) {
        col[j * 4 + k] = this.c0[j * 4 + k]! + (this.c1[j * 4 + k]! - this.c0[j * 4 + k]!) * Math.min(1, t * 1.4);
      }
      // Fade in over the first tenth, out over the rest.
      const fade = t < 0.08 ? t / 0.08 : 1 - (t - 0.08) / 0.92;
      col[j * 4 + 3] = this.c0[j * 4 + 3]! * fade * fade;
    }
    this.geometry.instanceCount = this.count;
    if (this.count > 0) {
      this.offsets.addUpdateRange(0, this.count * 3);
      this.sizeSpin.addUpdateRange(0, this.count * 2);
      this.colors.addUpdateRange(0, this.count * 4);
      this.offsets.needsUpdate = true;
      this.sizeSpin.needsUpdate = true;
      this.colors.needsUpdate = true;
    }
  }

  /** Remove particle `i` by moving the last one into its slot. */
  private moveLast(i: number): void {
    const last = --this.count;
    if (i === last) return;
    for (let k = 0; k < 3; k++) {
      this.pos[i * 3 + k] = this.pos[last * 3 + k]!;
      this.vel[i * 3 + k] = this.vel[last * 3 + k]!;
    }
    for (let k = 0; k < 4; k++) {
      this.c0[i * 4 + k] = this.c0[last * 4 + k]!;
      this.c1[i * 4 + k] = this.c1[last * 4 + k]!;
    }
    for (let k = 0; k < 2; k++) {
      this.size[i * 2 + k] = this.size[last * 2 + k]!;
      this.spin[i * 2 + k] = this.spin[last * 2 + k]!;
    }
    this.age[i] = this.age[last]!;
    this.life[i] = this.life[last]!;
    this.lift[i] = this.lift[last]!;
    this.drag[i] = this.drag[last]!;
  }

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

const FIRE_HOT = new Color(1.0, 0.86, 0.5);
const FIRE_MID = new Color(1.0, 0.45, 0.08);
const FIRE_END = new Color(0.45, 0.08, 0.0);
const SMOKE_DARK = new Color(0.09, 0.085, 0.08);
const SMOKE_GREY = new Color(0.32, 0.31, 0.3);
const SMOKE_LIGHT = new Color(0.82, 0.82, 0.8);
const TRAIL_WHITE = new Color(0.95, 0.95, 0.95);

/** Random unit vector, written into `out`. */
function randomDir(out: [number, number, number]): [number, number, number] {
  const u = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  out[0] = s * Math.cos(a);
  out[1] = s * Math.sin(a);
  out[2] = u;
  return out;
}

const _d: [number, number, number] = [0, 0, 0];

/**
 * The sandbox's effects, as verbs: an explosion here, a puff of trail there.
 *
 * Two pools: smoke blends normally (it hides what is behind it), fire and
 * sparks add light (they glow).
 */
export class Effects {
  private readonly texture = puffTexture();
  private readonly smoke = new Pool(2400, NormalBlending, this.texture);
  private readonly fire = new Pool(1600, AdditiveBlending, this.texture);

  constructor(private readonly origin: FloatingOrigin) {}

  get meshes(): Mesh[] {
    return [this.smoke.mesh, this.fire.mesh];
  }

  get particleCount(): number {
    return this.smoke.size_ + this.fire.size_;
  }

  update(dt: number): void {
    this.smoke.update(dt, this.origin);
    this.fire.update(dt, this.origin);
  }

  /**
   * A fireball: a flash, a ball of flame thrown outward, sparks and debris
   * on ballistic arcs, and a cloud of dark smoke that rises and spreads.
   * `scale` is roughly the size of the thing that blew up, in tens of metres.
   */
  explode(x: number, y: number, z: number, scale: number, vx = 0, vy = 0, vz = 0): void {
    const s = Math.max(0.3, scale);
    for (let i = 0; i < 3; i++) {
      this.fire.add({
        x, y, z, vx: vx * 0.3, vy: vy * 0.3, vz: vz * 0.3,
        life: 0.35, size0: 30 * s, size1: 90 * s, color0: FIRE_HOT, color1: FIRE_MID, alpha: 1, lift: 0, drag: 0.5,
      });
    }
    for (let i = 0; i < 34; i++) {
      randomDir(_d);
      const v = (8 + Math.random() * 28) * s;
      this.fire.add({
        x, y, z,
        vx: vx * 0.25 + _d[0] * v, vy: vy * 0.25 + _d[1] * v, vz: vz * 0.25 + _d[2] * v,
        life: 0.7 + Math.random() * 0.8, size0: 12 * s, size1: 38 * s,
        color0: FIRE_HOT, color1: FIRE_END, alpha: 0.95, lift: 6, drag: 0.25,
      });
    }
    for (let i = 0; i < 26; i++) {
      randomDir(_d);
      const v = (40 + Math.random() * 90) * Math.sqrt(s);
      this.fire.add({
        x, y, z,
        vx: vx * 0.4 + _d[0] * v, vy: vy * 0.4 + _d[1] * v, vz: vz * 0.4 + _d[2] * v,
        life: 0.9 + Math.random() * 1.2, size0: 2.5 * s, size1: 1 * s,
        color0: FIRE_HOT, color1: FIRE_MID, alpha: 1, lift: -12, drag: 0.6,
      });
    }
    for (let i = 0; i < 30; i++) {
      randomDir(_d);
      const v = (4 + Math.random() * 14) * s;
      this.smoke.add({
        x: x + _d[0] * 6 * s, y: y + _d[1] * 6 * s, z: z + _d[2] * 6 * s,
        vx: vx * 0.15 + _d[0] * v, vy: vy * 0.15 + _d[1] * v, vz: vz * 0.15 + _d[2] * v,
        life: 3.5 + Math.random() * 4, size0: 18 * s, size1: 85 * s,
        color0: SMOKE_DARK, color1: SMOKE_GREY, alpha: 0.85, lift: 3, drag: 0.35,
      });
    }
  }

  /** A small burst: a missile that ran out of time, a rocket into a field. */
  pop(x: number, y: number, z: number): void {
    this.explode(x, y, z, 0.35);
  }

  /** One step of a burning aircraft's trail: flame at the source, smoke behind. */
  burn(x: number, y: number, z: number, vx: number, vy: number, vz: number, intensity: number): void {
    for (let i = 0; i < 2; i++) {
      randomDir(_d);
      this.fire.add({
        x: x + _d[0] * 2, y: y + _d[1] * 2, z: z + _d[2] * 2,
        vx: vx * 0.7 + _d[0] * 4, vy: vy * 0.7 + _d[1] * 4, vz: vz * 0.7 + _d[2] * 4,
        life: 0.45 + Math.random() * 0.3, size0: 7 * intensity, size1: 16 * intensity,
        color0: FIRE_HOT, color1: FIRE_END, alpha: 0.9, lift: 2, drag: 0.3,
      });
    }
    randomDir(_d);
    this.smoke.add({
      x, y, z,
      vx: vx * 0.25 + _d[0] * 3, vy: vy * 0.25 + _d[1] * 3, vz: vz * 0.25 + _d[2] * 3,
      life: 4 + Math.random() * 3, size0: 8 * intensity, size1: 42 * intensity,
      color0: SMOKE_DARK, color1: SMOKE_GREY, alpha: 0.8, lift: 1.5, drag: 0.5,
    });
  }

  /** A column of smoke from a crash site, and flames at its foot while they last. */
  groundFire(x: number, y: number, z: number, flames: boolean, scale: number): void {
    randomDir(_d);
    this.smoke.add({
      x: x + _d[0] * 8 * scale, y: y + _d[1] * 8 * scale, z: z + _d[2] * 8 * scale,
      vx: _d[0] * 2, vy: _d[1] * 2, vz: _d[2] * 2,
      life: 9 + Math.random() * 6, size0: 16 * scale, size1: 110 * scale,
      color0: SMOKE_DARK, color1: SMOKE_GREY, alpha: 0.7, lift: 4, drag: 0.7,
    });
    if (!flames) return;
    randomDir(_d);
    this.fire.add({
      x: x + _d[0] * 10 * scale, y: y + _d[1] * 10 * scale, z: z + _d[2] * 10 * scale,
      vx: 0, vy: 0, vz: 0,
      life: 0.6 + Math.random() * 0.5, size0: 10 * scale, size1: 22 * scale,
      color0: FIRE_HOT, color1: FIRE_END, alpha: 0.85, lift: 9, drag: 0.4,
    });
  }

  /** A missile's exhaust: a bright point and a white trail that lingers. */
  exhaust(x: number, y: number, z: number, heavy: boolean): void {
    this.fire.add({
      x, y, z, vx: 0, vy: 0, vz: 0,
      life: 0.12, size0: heavy ? 5 : 3.5, size1: heavy ? 3 : 2, color0: FIRE_HOT, color1: FIRE_MID, alpha: 1, lift: 0, drag: 1,
    });
    randomDir(_d);
    this.smoke.add({
      x, y, z, vx: _d[0] * 1.5, vy: _d[1] * 1.5, vz: _d[2] * 1.5,
      life: heavy ? 3.2 : 2.2, size0: heavy ? 3 : 2, size1: heavy ? 14 : 9,
      color0: TRAIL_WHITE, color1: SMOKE_LIGHT, alpha: 0.55, lift: 0.3, drag: 0.8,
    });
  }

  clear(): void {
    this.smoke.clear();
    this.fire.clear();
  }

  dispose(): void {
    this.smoke.dispose();
    this.fire.dispose();
    this.texture.dispose();
  }
}
