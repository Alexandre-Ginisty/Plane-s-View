/**
 * The sandbox's effects, as verbs: a missile connecting, a wreck burning on
 * its way down, the fireball where it hits, a motor's trail.
 *
 * Everything is drawn by `@/fx` — one sorted premultiplied particle pass,
 * tumbling debris and the fire's light — and this is only the translation
 * from the sandbox's world (absolute ECEF, aircraft of every size, the real
 * terrain) into that simulation's local frame and its recipes.
 *
 * ## Size
 *
 * The recipes are tuned for a ten-metre airframe, and the sandbox shoots down
 * everything from a Cessna to an A380, so each verb takes the length of what
 * is burning and hands the simulation a scale of length / 10: a jumbo's fuel
 * load makes a fireball a jumbo's size, not a Cessna's.
 */

import { Vector3, type PerspectiveCamera } from 'three';

import { ecefToGeodetic } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import { FxRenderer } from '@/fx/render';
import { newParticleInit } from '@/fx/pool';
import { FLAME_TILES } from '@/fx/sprites';

/** Height of the ground under a point, metres above the ellipsoid, or NaN. */
export type GroundAt = (lat: number, lon: number) => number;

/** A fire that follows a burning part: see `startFire`. */
export type FireHandle = number;

const scaleOf = (lengthM: number) => Math.min(8, Math.max(0.6, lengthM / 10));

export class Effects {
  private readonly fx: FxRenderer;
  private readonly tpl = newParticleInit();
  private readonly local = { x: 0, y: 0, z: 0 };
  private readonly vel = { x: 0, y: 0, z: 0 };
  private groundAt: GroundAt = () => Number.NaN;

  constructor(origin: FloatingOrigin) {
    this.fx = new FxRenderer(origin);
  }

  /** What goes in the scene. */
  get object(): FxRenderer['group'] {
    return this.fx.group;
  }

  get particleCount(): number {
    const s = this.fx.stats;
    return s.smoke + s.fire;
  }

  /** The terrain, for the ground under an effect (what smoke stays above and debris lands on). */
  setGround(groundAt: GroundAt): void {
    this.groundAt = groundAt;
  }

  /** After the camera is placed. `windEast` / `windNorth`: the air's velocity, m/s. */
  update(camera: PerspectiveCamera, dt: number, windEast = 0, windNorth = 0): void {
    this.vel.x = windEast;
    this.vel.y = 0;
    this.vel.z = -windNorth;
    this.fx.update(camera, dt, this.vel);
  }

  /** Local y of the ground under an ECEF point; far below it where the terrain is unknown. */
  private groundY(x: number, y: number, z: number, localY: number): number {
    const g = ecefToGeodetic(x, y, z);
    const ground = this.groundAt(g.lat, g.lon);
    if (!Number.isFinite(ground)) return localY - 5000;
    return this.fx.heightToLocalY(x, y, z, g.height - ground);
  }

  private toLocal(p: Vector3) {
    return this.fx.toLocal(p.x, p.y, p.z, this.local);
  }

  private velLocal(v: Vector3 | null) {
    return v ? this.fx.vectorToLocal(v.x, v.y, v.z, this.vel) : { x: 0, y: 0, z: 0 };
  }

  /**
   * A missile connecting with an aircraft of `lengthM` moving at `velocity`:
   * the white-hot flash, the fuel going up in a rolling ball that is carried
   * along the flight path and cools into black smoke, sparks, burning
   * fragments falling to the real ground.
   */
  airburst(p: Vector3, velocity: Vector3, lengthM: number): void {
    const s = scaleOf(lengthM);
    const l = this.toLocal(p);
    const x = l.x, y = l.y, z = l.z;
    const g = this.groundY(p.x, p.y, p.z, y);
    const v = this.velLocal(velocity);
    const vx = v.x, vy = v.y, vz = v.z;
    const sim = this.fx.sim;
    const rs = Math.sqrt(s);
    sim.flash(x, y, z, 1.2, s);
    /*
     * The fuel going up in the air, not on the ground: a ball of burning
     * vapour carried on along the flight path, hotter and longer-lived than
     * the ground recipe's (nothing smothers it), turning into a spreading
     * cloud of oily smoke only once it has burnt — the mushroom comes in late
     * and big, and greys as it thins.
     */
    const n = Math.round(46 * Math.min(2.2, rs));
    const t = this.tpl;
    for (let k = 0; k < n; k++) {
      reset(t, sim.rnd());
      const th = sim.rnd() * 6.2832;
      const up = sim.rnd() * 2 - 1;
      const ca = Math.sqrt(1 - up * up);
      const sp = (6 + 20 * sim.rnd()) * rs;
      t.x = x + (sim.rnd() - 0.5) * 3 * s;
      t.y = y + (sim.rnd() - 0.5) * 3 * s;
      t.z = z + (sim.rnd() - 0.5) * 3 * s;
      t.vx = vx * 0.55 + Math.cos(th) * ca * sp;
      t.vy = vy * 0.55 + up * sp + 3;
      t.vz = vz * 0.55 + Math.sin(th) * ca * sp;
      t.life = (1.6 + 1.4 * sim.rnd()) * Math.min(2, rs);
      t.size0 = (1.5 + 2 * sim.rnd()) * s;
      t.size1 = (8 + 9 * sim.rnd()) * s;
      t.growTau = 0.35 * rs;
      t.drag = 1.1;
      t.buoyancy = 4;
      t.buoyTau = 1.5;
      t.alpha = 0.95;
      t.fadeIn = 0.02;
      t.fadeOut = 0.5;
      // The core of the ball near white, most of it orange, cooling to soot.
      t.heat = k < n * 0.2 ? 0.95 + 0.1 * sim.rnd() : 0.7 + 0.18 * sim.rnd();
      t.heatTau = t.life * (0.55 + 0.2 * sim.rnd());
      t.r = t.g = t.b = 0.03;
      t.rotRate = (sim.rnd() - 0.5) * 2.4;
      t.turbulence = 3 * rs;
      t.groundY = g;
      sim.fire.emit(t);
      const px = t.x, py = t.y, pz = t.z, pvx = t.vx, pvy = t.vy, pvz = t.vz, life = t.life, s1 = t.size1;
      reset(t, sim.rnd());
      t.x = px; t.y = py; t.z = pz;
      t.vx = pvx * 0.8; t.vy = pvy * 0.8; t.vz = pvz * 0.8;
      t.visibleAt = life * (0.45 + 0.2 * sim.rnd());
      t.life = (14 + 10 * sim.rnd()) * Math.min(1.8, rs);
      t.size0 = s1 * 0.8;
      t.size1 = s1 * (2.2 + 1.2 * sim.rnd());
      t.growTau = 4 * rs;
      t.drag = 0.8;
      t.buoyancy = 1.5;
      t.buoyTau = 6;
      t.alpha = 0.85;
      t.fadeIn = 0.8;
      t.fadeOut = 0.6;
      t.heat = 0.2;
      t.heatTau = 0.5;
      t.r = 0.05; t.g = 0.047; t.b = 0.043;
      t.lighten = 3;
      t.rotRate = (sim.rnd() - 0.5) * 0.4;
      t.turbulence = 2 * rs;
      t.groundY = g;
      sim.smoke.emit(t);
    }
    sim.sparks(x, y, z, vx * 0.5, vy * 0.5, vz * 0.5, 80, s);
    sim.fragments(x, y, z, g, vx * 0.6, vy * 0.6, vz * 0.6, 1, true, s);
  }

  /**
   * Something of `lengthM` flying into the ground at `velocity`: shockwave
   * dust, a fireball thrown along the path, debris, embers, a ground fire and
   * the smoke column that stands over it for minutes, bent by the wind.
   */
  impact(p: Vector3, velocity: Vector3, lengthM: number): void {
    const s = scaleOf(lengthM);
    const l = this.toLocal(p);
    const x = l.x, y = l.y, z = l.z;
    const g = this.groundY(p.x, p.y, p.z, y);
    const v = this.velLocal(velocity);
    const speedKt = velocity.length() * 1.943_84;
    this.fx.sim.crash(x, y, z, Math.max(120, speedKt), v.x, v.y, v.z, Math.min(g, y), false, s);
  }

  /** A secondary explosion: a fuel tank letting go a moment after the impact. */
  secondary(p: Vector3, lengthM: number, strength: number): void {
    const s = scaleOf(lengthM);
    const l = this.toLocal(p);
    const x = l.x, y = l.y, z = l.z;
    const g = this.groundY(p.x, p.y, p.z, y);
    this.fx.sim.explosion(x, y, z, Math.min(g, y), strength, s * 0.7);
  }

  /** A small burst: a missile that ran out of time, a rocket into a field. */
  pop(p: Vector3): void {
    const l = this.toLocal(p);
    const x = l.x, y = l.y, z = l.z;
    const g = this.groundY(p.x, p.y, p.z, y);
    this.fx.sim.explosion(x, y, z, Math.min(g, y), 0.6, 0.6);
  }

  /** A fire on a burning part that will move (a wreck on its way down). */
  startFire(p: Vector3, lengthM: number, seconds: number): FireHandle {
    const s = scaleOf(lengthM);
    const l = this.toLocal(p);
    const x = l.x, y = l.y, z = l.z;
    const g = this.groundY(p.x, p.y, p.z, y);
    return this.fx.sim.addFire(x, y, z, g, 1, seconds, 1.2 * s, true, s);
  }

  moveFire(h: FireHandle, p: Vector3): void {
    const l = this.toLocal(p);
    const x = l.x, y = l.y, z = l.z;
    this.fx.sim.moveFire(h, x, y, z, this.groundY(p.x, p.y, p.z, y));
  }

  /** A wreck's fire burning on the ground, and the smoke column over it. */
  groundFire(p: Vector3, lengthM: number, seconds: number): void {
    const s = scaleOf(lengthM);
    const l = this.toLocal(p);
    const x = l.x, y = l.y, z = l.z;
    const g = Math.min(y, this.groundY(p.x, p.y, p.z, y));
    this.fx.sim.addFire(x, g + 0.5 * s, z, g, 0.8, seconds, 2.5 * s, true, s);
    this.fx.sim.addColumn(x, g, z, g, 0.9, seconds * 1.5, s);
  }

  /**
   * One step of a motor's exhaust at `p`, the round moving at `velocity`: a
   * short hot flame at the nozzle and a white trail that lingers, spreads and
   * drifts off on the wind.
   */
  exhaust(p: Vector3, velocity: Vector3, heavy: boolean): void {
    const l = this.toLocal(p);
    const x = l.x, y = l.y, z = l.z;
    const v = this.velLocal(velocity);
    const sim = this.fx.sim;
    const t = this.tpl;
    reset(t, sim.rnd());
    t.x = x; t.y = y; t.z = z;
    t.vx = v.x * 0.6; t.vy = v.y * 0.6; t.vz = v.z * 0.6;
    t.life = 0.09;
    t.size0 = heavy ? 2.2 : 1.6;
    t.size1 = heavy ? 3.2 : 2.4;
    t.growTau = 0.05;
    t.alpha = 1;
    t.heat = 1.25;
    t.heatTau = 0.2;
    t.r = t.g = t.b = 0.03;
    t.tile = FLAME_TILES[Math.floor(sim.rnd() * FLAME_TILES.length)]!;
    t.aspect = 0.5;
    sim.fire.emit(t);

    reset(t, sim.rnd());
    t.x = x; t.y = y; t.z = z;
    t.vx = (sim.rnd() - 0.5) * 3; t.vy = (sim.rnd() - 0.5) * 3; t.vz = (sim.rnd() - 0.5) * 3;
    t.life = heavy ? 5 + 2 * sim.rnd() : 3.5 + 1.5 * sim.rnd();
    t.size0 = heavy ? 2.5 : 1.8;
    t.size1 = heavy ? 16 : 11;
    t.growTau = 2.2;
    t.drag = 0.6;
    t.alpha = 0.55;
    t.fadeIn = 0.05;
    t.fadeOut = 0.6;
    t.r = 0.86; t.g = 0.87; t.b = 0.88;
    t.turbulence = 0.8;
    t.groundY = y - 5000;
    t.heat = 0.35;
    t.heatTau = 0.12;
    sim.smoke.emit(t);
  }

  /**
   * Condensation off a wingtip or over the wing under load: a thin white
   * puff that is left behind almost at once.
   */
  vapour(p: Vector3, velocity: Vector3, size: number, strength: number): void {
    const l = this.toLocal(p);
    const v = this.velLocal(velocity);
    const sim = this.fx.sim;
    const t = this.tpl;
    reset(t, sim.rnd());
    t.x = l.x; t.y = l.y; t.z = l.z;
    t.vx = v.x * 0.85; t.vy = v.y * 0.85; t.vz = v.z * 0.85;
    t.life = 0.5 + 0.4 * sim.rnd();
    t.size0 = size * 0.4;
    t.size1 = size * 1.3;
    t.growTau = 0.25;
    t.drag = 3;
    t.alpha = Math.min(0.6, 0.35 * strength);
    t.fadeIn = 0.03;
    t.fadeOut = 0.8;
    t.r = t.g = t.b = 0.95;
    t.groundY = l.y - 5000;
    sim.smoke.emit(t);
  }

  clear(): void {
    this.fx.clear();
  }

  dispose(): void {
    this.fx.dispose();
  }
}

function reset(t: ReturnType<typeof newParticleInit>, seed: number): void {
  t.x = t.y = t.z = t.vx = t.vy = t.vz = 0;
  t.life = 1; t.size0 = 1; t.size1 = 1; t.growTau = 1; t.drag = 0; t.buoyancy = 0; t.buoyTau = 1e9; t.gravity = 0;
  t.alpha = 1; t.fadeIn = 0; t.fadeOut = 0; t.visibleAt = 0; t.rot = seed * 6.2832; t.rotRate = 0;
  t.heat = 0; t.heatTau = 1; t.r = t.g = t.b = 0.5; t.lighten = 0; t.tile = Math.floor(seed * 4) % 4;
  t.groundY = -1e9; t.bounce = 0; t.friction = 0; t.turbulence = 0; t.seed = (seed * 7.31) % 1; t.aspect = 1;
}
