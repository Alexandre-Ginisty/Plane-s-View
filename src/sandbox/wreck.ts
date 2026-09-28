/**
 * An aircraft that has been shot down.
 *
 * The moment a missile hits, the aircraft stops being the feed's: its last
 * reported state becomes the starting point of a fall the sandbox computes —
 * same model, same livery, same speed and heading — and the live track is
 * hidden from the traffic layer so there are never two of it. It rolls, drops
 * its nose, trails fire and smoke, and when it reaches the terrain under it
 * (the real, streamed terrain) it blows up and stays there, charred, burning,
 * with a column of smoke over it.
 *
 * None of it is to scale and none of it pretends to be. Gravity is stronger
 * than gravity, so the fall is watchable from start to finish.
 */

import { Color, Group, Matrix4, Mesh, MeshLambertMaterial, Vector3 } from 'three';

import { FEET_TO_METRES, enuBasis, geodeticToEcef } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import { buildAircraftModel, disposeAircraftModel, shapeFor } from '@/render/aircraft';
import { loadModelFor } from '@/render/aircraft/library';
import type { LoadedModel } from '@/render/aircraft/pvm';
import type { SampledAircraft } from '@/state/traffic';
import type { Effects } from './particles';

/** Gravity, exaggerated so a fall from cruise does not take two minutes. */
const GRAVITY = 26;
/** Seconds a crash site keeps smoking, and burning. */
const SMOKE_S = 75;
const FLAMES_S = 25;
const CHAR = new Color(0x2b2724);

export type WreckState = 'falling' | 'down';

export class Wreck {
  readonly group = new Group();
  private readonly model = new Group();
  readonly lengthM: number;
  readonly callsign: string;
  readonly type: string | null;
  state: WreckState = 'falling';
  /** Seconds since hit, and since impact. */
  age = 0;
  sinceImpact = 0;

  lat: number;
  lon: number;
  altM: number;
  private heading: number;
  private pitch: number;
  private roll: number;
  private readonly rollRate: number;
  private readonly yawRate: number;
  private speedH: number;
  private vertical: number;
  private ground = Number.NaN;
  private emit = 0;
  /** Materials this wreck owns, so it can char them without charring every A320. */
  private readonly owned: MeshLambertMaterial[] = [];
  private procedural: ReturnType<typeof buildAircraftModel> | null = null;
  private disposed = false;

  /** Absolute ECEF position and velocity, refreshed every step. */
  readonly position = new Vector3();
  readonly velocity = new Vector3();

  constructor(
    sample: SampledAircraft,
    type: string | null,
    operator: string | null,
    private readonly origin: FloatingOrigin,
    private readonly effects: Effects,
    /** Called once, on impact. */
    private readonly onImpact: (wreck: Wreck) => void,
  ) {
    const shape = shapeFor(type, sample.latest.category ?? null);
    this.lengthM = shape.length;
    this.type = type;
    this.callsign = sample.latest.callsign?.trim() || sample.hex.toUpperCase();
    this.lat = sample.lat;
    this.lon = sample.lon;
    this.altM = sample.altFt * FEET_TO_METRES;
    this.heading = sample.headingDeg;
    this.pitch = sample.pitchDeg;
    this.roll = sample.rollDeg;
    this.speedH = Math.max(60, sample.groundSpeedKt * 0.514);
    this.vertical = (sample.verticalRateFpm * FEET_TO_METRES) / 60;
    this.rollRate = (Math.random() < 0.5 ? -1 : 1) * (70 + Math.random() * 110);
    this.yawRate = (Math.random() - 0.5) * 14;

    this.group.matrixAutoUpdate = false;
    this.group.add(this.model);
    this.model.scale.setScalar(this.lengthM);
    this.model.updateMatrix();

    // The generator at once, the real airframe when it arrives — the same
    // order `OwnAircraft` uses, for the same reason: no hole in the sky.
    this.procedural = buildAircraftModel(type, sample.latest.category ?? null, 'low');
    const hull = this.own(new MeshLambertMaterial({ color: 0xdfe6ee }));
    const trim = this.own(new MeshLambertMaterial({ color: 0x1a2028 }));
    this.model.add(new Mesh(this.procedural.hull, hull));
    if (this.procedural.trim) this.model.add(new Mesh(this.procedural.trim, trim));
    void loadModelFor(type, operator, sample.latest.category).then((loaded) => {
      if (loaded && !this.disposed) this.adopt(loaded);
    });
    this.place();
  }

  private own(m: MeshLambertMaterial): MeshLambertMaterial {
    this.owned.push(m);
    return m;
  }

  private adopt(loaded: LoadedModel): void {
    this.model.clear();
    if (this.procedural) disposeAircraftModel(this.procedural);
    this.procedural = null;
    for (const part of loaded.parts) {
      if (part.role === 'gear' || part.role === 'disc') continue;
      // Cloned, not shared: charring must not reach every other aircraft of
      // the type, including the one being flown.
      const mesh = new Mesh(part.geometry, this.own(part.material.clone()));
      mesh.frustumCulled = false;
      if (part.role !== 'hull') mesh.position.set(part.origin[0], part.origin[1], part.origin[2]);
      this.model.add(mesh);
    }
    if (this.state === 'down') this.char(1);
  }

  /**
   * Advance the fall. `groundAt` is the streamed terrain; unknown ground is
   * remembered from the last good answer, and falls back to sea level only
   * when there has never been one.
   */
  step(dt: number, groundAt: (lat: number, lon: number) => number): void {
    this.age += dt;
    if (this.state === 'down') {
      // Still placed every frame: the floating origin can move under it.
      this.place();
      this.sinceImpact += dt;
      this.emit += dt;
      const flames = this.sinceImpact < FLAMES_S;
      const interval = this.sinceImpact < 6 ? 0.05 : 0.18;
      if (this.sinceImpact < SMOKE_S) {
        while (this.emit > interval) {
          this.emit -= interval;
          this.effects.groundFire(this.position.x, this.position.y, this.position.z, flames, Math.max(0.6, this.lengthM / 40));
        }
      }
      this.char(Math.min(1, this.sinceImpact / 3));
      return;
    }

    const g = groundAt(this.lat, this.lon);
    if (Number.isFinite(g)) this.ground = g;

    this.vertical -= GRAVITY * dt;
    this.speedH *= Math.pow(0.9, dt);
    this.roll += this.rollRate * dt;
    this.heading += this.yawRate * dt;
    // The nose follows the flight path down, with a wobble.
    const pathPitch = (Math.atan2(this.vertical, this.speedH) * 180) / Math.PI;
    this.pitch += (pathPitch + Math.sin(this.age * 3) * 4 - this.pitch) * (1 - Math.exp(-dt / 0.6));

    const h = (this.heading * Math.PI) / 180;
    const d = this.speedH * dt;
    this.lat += (Math.cos(h) * d) / 111_320;
    this.lon += (Math.sin(h) * d) / (111_320 * Math.cos((this.lat * Math.PI) / 180));
    this.altM += this.vertical * dt;

    const ground = Number.isFinite(this.ground) ? this.ground : 0;
    if (this.altM <= ground + this.lengthM * 0.05) {
      this.impact(ground);
      return;
    }

    this.place();
    this.emit += dt;
    while (this.emit > 0.03) {
      this.emit -= 0.03;
      this.effects.burn(
        this.position.x, this.position.y, this.position.z,
        this.velocity.x, this.velocity.y, this.velocity.z,
        Math.max(0.7, this.lengthM / 35),
      );
    }
  }

  private impact(ground: number): void {
    this.state = 'down';
    // Half buried, nose in, at whatever angle it arrived — but not upside
    // down: a wreck on its back reads as a model that failed to load.
    this.altM = ground + this.lengthM * 0.03;
    this.pitch = -8 - Math.random() * 14;
    this.roll = (Math.random() - 0.5) * 50;
    this.speedH = 0;
    this.vertical = 0;
    this.place();
    const s = Math.max(1.2, this.lengthM / 18);
    this.effects.explode(this.position.x, this.position.y, this.position.z, s);
    this.effects.explode(this.position.x, this.position.y, this.position.z, s * 0.6);
    this.onImpact(this);
  }

  /** Blend the paint towards soot. */
  private char(amount: number): void {
    for (const m of this.owned) {
      const base = (m.userData['base'] as Color | undefined) ?? m.color.clone();
      m.userData['base'] = base;
      m.color.copy(base).lerp(CHAR, amount * 0.85);
    }
  }

  /** Rebuild the transform from the geodetic state. Also refreshes `position`. */
  place(): void {
    const e = geodeticToEcef(this.lat, this.lon, this.altM);
    this.position.set(e[0], e[1], e[2]);
    const b = enuBasis(this.lat, this.lon);
    const h = (this.heading * Math.PI) / 180;
    const p = (this.pitch * Math.PI) / 180;
    const r = (this.roll * Math.PI) / 180;
    const fE = Math.sin(h) * Math.cos(p);
    const fN = Math.cos(h) * Math.cos(p);
    const fU = Math.sin(p);
    const fwd = new Vector3(
      b.east[0] * fE + b.north[0] * fN + b.up[0] * fU,
      b.east[1] * fE + b.north[1] * fN + b.up[1] * fU,
      b.east[2] * fE + b.north[2] * fN + b.up[2] * fU,
    ).normalize();
    const localUp = new Vector3(b.up[0], b.up[1], b.up[2]);
    this.velocity.copy(fwd).multiplyScalar(this.speedH).addScaledVector(localUp, this.vertical);
    const right = new Vector3().crossVectors(fwd, localUp).normalize();
    const up = new Vector3().crossVectors(right, fwd).normalize();
    // Roll about the nose.
    const cr = Math.cos(r);
    const sr = Math.sin(r);
    const rolledRight = right.clone().multiplyScalar(cr).addScaledVector(up, -sr);
    const rolledUp = up.clone().multiplyScalar(cr).addScaledVector(right, sr);

    const o = this.origin.current;
    this.group.matrix.copy(new Matrix4().makeBasis(rolledRight, fwd, rolledUp));
    this.group.matrix.setPosition(e[0] - o[0], e[1] - o[1], e[2] - o[2]);
    this.group.matrixWorldNeedsUpdate = true;
  }

  get done(): boolean {
    return this.state === 'down' && this.sinceImpact > SMOKE_S + 60;
  }

  dispose(): void {
    this.disposed = true;
    this.group.removeFromParent();
    this.model.clear();
    if (this.procedural) disposeAircraftModel(this.procedural);
    for (const m of this.owned) m.dispose();
  }
}
