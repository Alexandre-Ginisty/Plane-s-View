/**
 * Missiles and rockets, both of them homing.
 *
 * Guidance is pure pursuit with a turn-rate limit: every step the velocity
 * turns towards the target by at most so many degrees. Missiles turn hard and
 * almost never miss; rockets turn gently and come in salvoes, so a salvo
 * spreads and some of it goes wide. Neither is realistic, both are fun, and
 * that was the brief.
 *
 * A hit is decided on the segment travelled this step rather than on the end
 * point, so a missile doing a kilometre a second cannot step straight through
 * an aircraft between two frames.
 */

import {
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three';

import type { FloatingOrigin } from '@/core/frame';
import type { Effects } from './particles';
import type { Weapon } from './catalog';

interface Round {
  kind: Weapon;
  position: Vector3;
  velocity: Vector3;
  target: string | null;
  age: number;
  trail: number;
  mesh: Group;
}

/** Where a round is aimed: an aircraft's absolute ECEF position, or null when it is gone. */
export type TargetLookup = (hex: string) => { position: Vector3; radius: number } | null;

export interface HitEvent {
  hex: string;
  /** Absolute ECEF. */
  position: Vector3;
}

const SPEC: Record<Weapon, { speed: number; accel: number; turnDegS: number; life: number; length: number }> = {
  missile: { speed: 1150, accel: 420, turnDegS: 110, life: 24, length: 3.2 },
  rockets: { speed: 780, accel: 600, turnDegS: 38, life: 16, length: 1.8 },
};

/** How many rounds a trigger pull fires, and how far apart, seconds. */
export const SALVO: Record<Weapon, { rounds: number; spacing: number; cooldown: number }> = {
  missile: { rounds: 1, spacing: 0, cooldown: 0.75 },
  rockets: { rounds: 4, spacing: 0.09, cooldown: 1.5 },
};

/** Most rounds in flight at once. */
const MAX_ROUNDS = 24;
/** Metres of flight between two puffs of exhaust. */
const TRAIL_SPACING_M: Record<Weapon, number> = { missile: 9, rockets: 7 };
const _puff = new Vector3();

const _dir = new Vector3();
const _want = new Vector3();
const _axis = new Vector3();
const _q = new Quaternion();
const _seg = new Vector3();
const _rel = new Vector3();
const Y = new Vector3(0, 1, 0);

export class Weapons {
  readonly group = new Group();
  private readonly rounds: Round[] = [];
  private readonly bodyGeometry = new CylinderGeometry(0.5, 0.5, 1, 8);
  private readonly noseGeometry = new ConeGeometry(0.5, 1, 8);
  private readonly bodyMaterial = new MeshLambertMaterial({ color: 0xe9e7df });
  private readonly glowMaterial = new MeshBasicMaterial({ color: 0xffd27a });

  constructor(
    private readonly origin: FloatingOrigin,
    private readonly effects: Effects,
  ) {
    this.group.matrixAutoUpdate = false;
  }

  get inFlight(): number {
    return this.rounds.length;
  }

  private build(kind: Weapon): Group {
    const s = SPEC[kind];
    const g = new Group();
    const radius = kind === 'missile' ? 0.14 : 0.08;
    const body = new Mesh(this.bodyGeometry, this.bodyMaterial);
    body.scale.set(radius * 2, s.length * 0.8, radius * 2);
    const nose = new Mesh(this.noseGeometry, this.bodyMaterial);
    nose.scale.set(radius * 2, s.length * 0.2, radius * 2);
    nose.position.y = s.length * 0.5;
    const flame = new Mesh(this.noseGeometry, this.glowMaterial);
    flame.scale.set(radius * 2.4, s.length * 0.35, radius * 2.4);
    flame.position.y = -s.length * 0.55;
    flame.rotation.x = Math.PI;
    g.add(body, nose, flame);
    for (const m of g.children) m.frustumCulled = false;
    this.group.add(g);
    return g;
  }

  /** Launch one round from `from` (absolute ECEF) with the launcher's velocity. */
  fire(kind: Weapon, from: Vector3, launcherVelocity: Vector3, forward: Vector3, target: string | null): void {
    if (this.rounds.length >= MAX_ROUNDS) this.remove(0);
    const spread = kind === 'rockets' ? 0.04 : 0.0;
    const dir = _dir
      .copy(forward)
      .add(new Vector3((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread))
      .normalize();
    this.rounds.push({
      kind,
      position: from.clone(),
      velocity: launcherVelocity.clone().addScaledVector(dir, 60),
      target,
      age: 0,
      trail: 0,
      mesh: this.build(kind),
    });
  }

  /**
   * Fly every round. Returns the hits, and calls `groundAt` to detonate a
   * round that meets the terrain (height in metres above the ellipsoid of the
   * ground under an absolute ECEF point, or NaN).
   */
  update(dt: number, lookup: TargetLookup, groundBelow: (p: Vector3) => number): HitEvent[] {
    const hits: HitEvent[] = [];
    const o = this.origin.current;
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i]!;
      const s = SPEC[r.kind];
      r.age += dt;

      const target = r.target ? lookup(r.target) : null;
      const speed = r.velocity.length();
      _dir.copy(r.velocity).normalize();
      if (target && r.age > 0.15) {
        _want.copy(target.position).sub(r.position).normalize();
        const angle = _dir.angleTo(_want);
        const max = ((s.turnDegS * Math.PI) / 180) * dt;
        if (angle > 1e-5) {
          _axis.crossVectors(_dir, _want);
          if (_axis.lengthSq() > 1e-12) {
            _axis.normalize();
            _dir.applyQuaternion(_q.setFromAxisAngle(_axis, Math.min(angle, max)));
          }
        }
      }
      const newSpeed = Math.min(s.speed, speed + s.accel * dt);
      r.velocity.copy(_dir).multiplyScalar(newSpeed);

      _seg.copy(r.velocity).multiplyScalar(dt);
      if (target) {
        // Closest approach along this step's segment.
        _rel.copy(target.position).sub(r.position);
        const len2 = _seg.lengthSq();
        const t = len2 > 0 ? Math.min(1, Math.max(0, _rel.dot(_seg) / len2)) : 0;
        const miss = _rel.clone().addScaledVector(_seg, -t).length();
        if (miss < target.radius) {
          hits.push({ hex: r.target!, position: target.position.clone() });
          this.remove(i);
          continue;
        }
      }
      r.position.add(_seg);

      const ground = groundBelow(r.position);
      if (r.age > s.life || (Number.isFinite(ground) && ground > 0.5)) {
        this.effects.pop(r.position);
        this.remove(i);
        continue;
      }

      // The trail is laid by distance, not time: a puff every few metres
      // whatever the speed, walked back along this step so it is continuous.
      r.trail += newSpeed * dt;
      const step = TRAIL_SPACING_M[r.kind];
      while (r.trail > step) {
        r.trail -= step;
        _puff.copy(r.position).addScaledVector(_dir, -r.trail);
        this.effects.exhaust(_puff, r.velocity, r.kind === 'missile');
      }

      r.mesh.position.set(r.position.x - o[0], r.position.y - o[1], r.position.z - o[2]);
      r.mesh.quaternion.setFromUnitVectors(Y, _dir);
      r.mesh.updateMatrix();
      r.mesh.updateMatrixWorld(true);
    }
    return hits;
  }

  private remove(i: number): void {
    const r = this.rounds[i];
    if (!r) return;
    this.group.remove(r.mesh);
    this.rounds.splice(i, 1);
  }

  clear(): void {
    while (this.rounds.length) this.remove(0);
  }

  dispose(): void {
    this.clear();
    this.bodyGeometry.dispose();
    this.noseGeometry.dispose();
    this.bodyMaterial.dispose();
    this.glowMaterial.dispose();
  }
}
