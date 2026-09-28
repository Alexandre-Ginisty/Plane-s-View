/**
 * One sandbox game: your aircraft, your missiles, their wrecks.
 *
 * Everything that is not the sandbox's stays as it was. The real traffic
 * keeps flying on the live feed and is drawn by `Traffic3D` as usual; the
 * sandbox only *reads* it — to lock on, and to know where a target is — until
 * a missile connects. Then that one aircraft is taken off the feed (`downed`,
 * which the traffic layer skips) and handed to a `Wreck` that the sandbox
 * flies into the ground.
 *
 * The orchestrator calls, per frame and in this order: `stepPlayer` (before
 * the camera), `placeKillCam` (instead of the normal camera while a kill cam
 * runs), then `stepWorld` (after the traffic layer has placed everything).
 */

import { Matrix4, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';

import { FEET_TO_METRES, ecefToGeodetic, enuBasis, geodeticToEcef, type Vec3 } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import { registry } from '@/data/meta/registry';
import { operatorOf, registerBuiltInModel } from '@/render/aircraft/library';
import { shapeFor } from '@/render/aircraft';
import { clearanceFor } from '@/render/ground';
import { aircraftFrame } from '@/render/pov';
import type { Traffic3D } from '@/render/traffic3d';
import type { SampledAircraft } from '@/state/traffic';
import type { SandboxAircraft } from './catalog';
import { ArcadeFlight, NO_INPUT, type FlightInput } from './flight';
import { SANDBOX_TYPES, sandboxModel } from './models';
import { Effects } from './particles';
import { Score, type KillAward } from './score';
import { SALVO, Weapons } from './weapons';
import { Wreck } from './wreck';

for (const type of Object.values(SANDBOX_TYPES)) registerBuiltInModel(type, () => sandboxModel(type));

/** The player's hex: not a real ICAO address, so it can never collide with one. */
const PLAYER_HEX = 'sandbox';

/** Wrecks kept at once; the oldest one on the ground goes first. */
const MAX_WRECKS = 8;
/** How far off the nose a target can be for an automatic lock, radians. */
const AUTO_LOCK_CONE = (45 * Math.PI) / 180;
/** Seconds a lock survives its target being out of sight. */
const LOCK_GRACE_S = 2;
/** Seconds after a crash before the aircraft is back. */
const RESPAWN_S = 3.2;

export interface SandboxEvents {
  kill(award: KillAward, victim: { callsign: string; type: string | null }): void;
  impact(points: number, victim: { callsign: string }): void;
  crashed(): void;
  respawned(): void;
  /** A wreck is falling somewhere the terrain may not be loaded yet. */
  prefetch(lat: number, lon: number, trackDeg: number, speedMps: number): void;
}

interface KillCam {
  wreck: Wreck;
  t: number;
  angle: number;
  position: Vector3;
  started: boolean;
}

const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _pos = new Vector3();
const _m = new Matrix4();
const _look = new Vector3();

export class SandboxSession {
  readonly scene = new Scene();
  readonly effects: Effects;
  readonly weapons: Weapons;
  readonly score = new Score();
  readonly downed = new Set<string>();
  readonly aircraft: SandboxAircraft;

  private flight: ArcadeFlight;
  private readonly wrecks: Wreck[] = [];
  private readonly keys = new Set<string>();
  private killCam: KillCam | null = null;
  private readonly clearance: number;
  private readonly lengthM: number;

  lockHex: string | null = null;
  private lockLostFor = 0;
  private cooldown = 0;
  private salvoLeft = 0;
  private salvoTimer = 0;
  private salvoTarget: string | null = null;
  private side = 1;
  /** Seconds left before a crashed aircraft comes back; 0 when flying. */
  private respawnIn = 0;
  /** Seconds since start: early on, unknown ground is waited for, not hit. */
  private clock = 0;
  private settled = false;

  constructor(
    private readonly origin: FloatingOrigin,
    aircraft: SandboxAircraft,
    private readonly spawn: { lat: number; lon: number; headingDeg: number },
    private readonly events: SandboxEvents,
  ) {
    this.aircraft = aircraft;
    this.scene.matrixAutoUpdate = false;
    this.effects = new Effects(origin);
    this.weapons = new Weapons(origin, this.effects);
    for (const mesh of this.effects.meshes) this.scene.add(mesh);
    this.scene.add(this.weapons.group);
    const shape = shapeFor(aircraft.type, aircraft.flight.heli ? 'A7' : 'A3');
    this.clearance = clearanceFor(shape) + 1;
    this.lengthM = shape.length;
    registry.ingestHints([{ hex: PLAYER_HEX, registration: null, typeCode: aircraft.type }]);
    this.flight = this.newFlight();
  }

  private newFlight(): ArcadeFlight {
    const a = this.aircraft;
    this.settled = false;
    this.clock = 0;
    return new ArcadeFlight(
      a.flight,
      { lat: this.spawn.lat, lon: this.spawn.lon, altM: a.flight.heli ? 450 : 1600, headingDeg: this.spawn.headingDeg },
      PLAYER_HEX,
      a.type,
      a.name.toUpperCase().slice(0, 8),
    );
  }

  get type(): string {
    return this.aircraft.type;
  }

  get killCamActive(): boolean {
    return this.killCam !== null;
  }

  get crashed(): boolean {
    return this.respawnIn > 0;
  }

  /** 0 while reloading, 1 when ready. */
  get readiness(): number {
    const c = SALVO[this.aircraft.weapon].cooldown;
    return 1 - Math.min(1, this.cooldown / c);
  }

  get wreckCount(): number {
    return this.wrecks.length;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /** Key codes (`KeyboardEvent.code`) held or released. Returns true if used. */
  key(code: string, down: boolean): boolean {
    const used = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Tab'];
    if (!used.includes(code)) return false;
    if (down) {
      if (code === 'Space' && !this.keys.has('Space')) this.trigger();
      if (code === 'Tab' && !this.keys.has('Tab')) this.cycle = true;
      this.keys.add(code);
    } else {
      this.keys.delete(code);
    }
    return true;
  }

  /** Every key up: the window lost focus, and a held arrow must not stick. */
  releaseAll(): void {
    this.keys.clear();
  }

  private cycle = false;
  private triggerPulled = false;

  private trigger(): void {
    this.triggerPulled = true;
  }

  /** Lock on to an aircraft the player clicked. */
  lock(hex: string | null): void {
    this.lockHex = hex;
    this.lockLostFor = 0;
  }

  private input(): FlightInput {
    const k = this.keys;
    return {
      pitch: (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0),
      turn: (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0),
      boost: k.has('ShiftLeft') || k.has('ShiftRight'),
      brake: k.has('ControlLeft') || k.has('ControlRight'),
    };
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /** Fly the player. Returns the aircraft for the camera, the HUD and the model. */
  stepPlayer(dt: number, groundAt: (lat: number, lon: number) => number): SampledAircraft {
    this.clock += dt;
    const f = this.flight;
    const ground = groundAt(f.lat, f.lon);

    if (this.respawnIn > 0) {
      this.respawnIn -= dt;
      if (this.respawnIn <= 0) {
        this.respawnIn = 0;
        this.flight = this.newFlight();
        this.events.respawned();
      }
      return this.flight.toSample();
    }

    // The terrain under a fresh spawn streams in over the first seconds.
    // Until it has, the aircraft is held rather than flown into a mountain
    // nobody could see; once it has, it is lifted clear of it.
    if (!this.settled && Number.isFinite(ground)) {
      const floor = ground + (this.aircraft.flight.heli ? 250 : 900);
      if (f.altM < floor) f.altM = floor;
      this.settled = true;
    }

    // Hands off during a kill cam: level the wings and hold the height.
    const input = this.killCam
      ? { ...NO_INPUT, pitch: Math.max(-1, Math.min(1, -f.pitchDeg / 15)) }
      : this.input();
    const safe = this.killCam !== null || !this.settled || this.clock < 4;
    const alive = f.step(dt, input, ground, this.clearance);
    if (!alive) {
      if (safe) f.altM = ground + this.clearance + 30;
      else this.crash();
    }
    return f.toSample();
  }

  private crash(): void {
    const s = this.flight.toSample();
    const e = geodeticToEcef(s.lat, s.lon, s.altFt * FEET_TO_METRES);
    this.effects.explode(e[0], e[1], e[2], Math.max(1, this.lengthM / 16));
    this.effects.explode(e[0], e[1], e[2], 0.7);
    this.respawnIn = RESPAWN_S;
    this.score.crash();
    this.keys.clear();
    this.events.crashed();
  }

  /**
   * Missiles, wrecks and effects, after the traffic layer has placed this
   * frame's aircraft. Returns the time scale the frame ran at, for anything
   * else that wants to share the slow motion.
   */
  stepWorld(dt: number, traffic: Traffic3D, groundAt: (lat: number, lon: number) => number): void {
    // A beat of slow motion as the missile connects, and again on impact.
    const slow = this.killCam && (this.killCam.t < 1.1 || (this.killCam.wreck.state === 'down' && this.killCam.wreck.sinceImpact < 0.7));
    const wdt = slow ? dt * 0.35 : dt;

    this.updateLock(dt, traffic);
    this.updateTrigger(dt, traffic);

    const o = this.origin.current;
    const hits = this.weapons.update(
      wdt,
      (hex) => {
        if (this.downed.has(hex)) return null;
        const p = traffic.positionOf(hex);
        if (!p) return null;
        return { position: new Vector3(p.x + o[0], p.y + o[1], p.z + o[2]), radius: Math.max(28, traffic.sizeOf(hex) * 0.9) };
      },
      (p) => {
        const g = ecefToGeodetic(p.x, p.y, p.z);
        const ground = groundAt(g.lat, g.lon);
        return Number.isFinite(ground) ? ground - g.height : Number.NaN;
      },
    );

    for (const hit of hits) this.shootDown(hit.hex, hit.position, traffic);

    for (const w of this.wrecks) w.step(wdt, groundAt);
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i]!;
      if (w.done && this.killCam?.wreck !== w) {
        w.dispose();
        this.wrecks.splice(i, 1);
      }
    }

    this.effects.update(wdt);
    if (this.killCam) this.killCam.t += dt;
  }

  private updateLock(dt: number, traffic: Traffic3D): void {
    const targets = traffic.targets;
    if (this.cycle) {
      this.cycle = false;
      if (targets.length > 0) {
        const i = targets.findIndex((t) => t.hex === this.lockHex);
        this.lock(targets[(i + 1) % targets.length]!.hex);
      }
    }
    if (!this.lockHex) return;
    if (this.downed.has(this.lockHex)) {
      this.lockHex = null;
      return;
    }
    const seen = targets.some((t) => t.hex === this.lockHex);
    this.lockLostFor = seen ? 0 : this.lockLostFor + dt;
    if (this.lockLostFor > LOCK_GRACE_S) this.lockHex = null;
  }

  /** The best target off the nose, for a trigger pulled with nothing locked. */
  private autoLock(traffic: Traffic3D): string | null {
    const s = this.flight.toSample();
    const frame = aircraftFrame(s, s.altFt * FEET_TO_METRES);
    const o = this.origin.current;
    const me = new Vector3(frame.position[0] - o[0], frame.position[1] - o[1], frame.position[2] - o[2]);
    let best: string | null = null;
    let bestScore = Infinity;
    for (const t of traffic.targets) {
      const dir = t.position.clone().sub(me);
      const angle = dir.angleTo(frame.forward);
      if (angle > AUTO_LOCK_CONE) continue;
      const score = angle * 4 + t.distanceM / 20_000;
      if (score < bestScore) {
        bestScore = score;
        best = t.hex;
      }
    }
    return best;
  }

  private updateTrigger(dt: number, traffic: Traffic3D): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.triggerPulled) {
      this.triggerPulled = false;
      if (this.cooldown <= 0 && this.respawnIn <= 0 && !this.killCam) {
        if (!this.lockHex) this.lock(this.autoLock(traffic));
        const salvo = SALVO[this.aircraft.weapon];
        this.salvoLeft = salvo.rounds;
        this.salvoTimer = 0;
        this.salvoTarget = this.lockHex;
        this.cooldown = salvo.cooldown;
      }
    }
    if (this.salvoLeft <= 0) return;
    this.salvoTimer -= dt;
    while (this.salvoLeft > 0 && this.salvoTimer <= 0) {
      this.launch(this.salvoTarget);
      this.salvoLeft--;
      this.salvoTimer += SALVO[this.aircraft.weapon].spacing;
    }
  }

  private launch(target: string | null): void {
    const s = this.flight.toSample();
    const frame = aircraftFrame(s, s.altFt * FEET_TO_METRES);
    const L = this.lengthM;
    this.side = -this.side;
    const from = new Vector3(frame.position[0], frame.position[1], frame.position[2])
      .addScaledVector(frame.right, this.side * L * 0.28)
      .addScaledVector(frame.up, -L * 0.06)
      .addScaledVector(frame.forward, L * 0.05);
    const velocity = frame.forward.clone().multiplyScalar(this.flight.speedMps);
    this.weapons.fire(this.aircraft.weapon, from, velocity, frame.forward, target);
  }

  private shootDown(hex: string, at: Vector3, traffic: Traffic3D): void {
    const victim = traffic.inRange.find((c) => c.hex === hex)?.sample;
    if (!victim || this.downed.has(hex)) return;
    this.downed.add(hex);
    if (this.lockHex === hex) this.lockHex = null;

    const type = registry.knownTypeCode(hex);
    const wreck = new Wreck(victim, type, operatorOf(victim.latest.callsign), this.origin, this.effects, (w) => {
      const points = this.score.impact(w.lengthM);
      this.events.impact(points, { callsign: w.callsign });
    });
    this.effects.explode(at.x, at.y, at.z, Math.max(0.8, wreck.lengthM / 25), wreck.velocity.x, wreck.velocity.y, wreck.velocity.z);
    this.scene.add(wreck.group);
    this.wrecks.push(wreck);
    this.trimWrecks();
    this.events.prefetch(victim.lat, victim.lon, victim.trackDeg, victim.groundSpeedKt * 0.514);

    const award = this.score.kill(wreck.lengthM, this.clock);
    this.events.kill(award, { callsign: wreck.callsign, type });

    if (!this.killCam) {
      this.killCam = { wreck, t: 0, angle: 0, position: new Vector3(), started: false };
    }
  }

  private trimWrecks(): void {
    while (this.wrecks.length > MAX_WRECKS) {
      const i = this.wrecks.findIndex((w) => w.state === 'down' && this.killCam?.wreck !== w);
      if (i < 0) break;
      this.wrecks[i]!.dispose();
      this.wrecks.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------
  // Kill cam
  // -------------------------------------------------------------------------

  /**
   * Put the camera on the falling aircraft. Returns false once the kill cam
   * is over, and the caller hands the camera back to the player — with a
   * transition, from the pose this leaves behind.
   */
  placeKillCam(camera: PerspectiveCamera, dt: number): boolean {
    const kc = this.killCam;
    if (!kc) return false;
    const w = kc.wreck;
    const over = (w.state === 'down' && w.sinceImpact > 4) || kc.t > 28;
    if (over) {
      this.killCam = null;
      return false;
    }

    const o = this.origin.current;
    if (!kc.started) {
      kc.position.set(camera.position.x + o[0], camera.position.y + o[1], camera.position.z + o[2]);
      kc.started = true;
    }

    const target = w.position;
    const b = enuBasis(w.lat, w.lon);
    _up.set(b.up[0], b.up[1], b.up[2]);
    // Behind and to one side of the fall, circling slowly, a little above;
    // once it is down, higher and further, to take in the fire.
    _fwd.copy(w.velocity).addScaledVector(_up, -w.velocity.dot(_up));
    if (_fwd.lengthSq() < 1) _fwd.set(b.north[0], b.north[1], b.north[2]);
    _fwd.normalize();
    _right.crossVectors(_fwd, _up).normalize();
    kc.angle += dt * 0.22;
    const down = w.state === 'down';
    const dist = Math.max(55, w.lengthM * (down ? 5 : 3.2));
    const a = 0.7 + kc.angle;
    _pos
      .copy(target)
      .addScaledVector(_fwd, -Math.cos(a) * dist)
      .addScaledVector(_right, Math.sin(a) * dist)
      .addScaledVector(_up, dist * (down ? 0.55 : 0.28));

    // Swoop in from wherever the camera was, then hold on.
    const k = 1 - Math.exp(-dt / (kc.t < 1.5 ? 0.35 : 0.12));
    kc.position.lerp(_pos, k);

    const camEcef: Vec3 = [kc.position.x, kc.position.y, kc.position.z];
    this.origin.maybeRebase(camEcef);
    const o2 = this.origin.current;
    camera.position.set(camEcef[0] - o2[0], camEcef[1] - o2[1], camEcef[2] - o2[2]);
    _look.set(target.x - o2[0], target.y - o2[1], target.z - o2[2]);
    _m.lookAt(camera.position, _look, _up);
    camera.quaternion.setFromRotationMatrix(_m);
    camera.updateMatrixWorld();
    return true;
  }

  /** The camera's pose as the kill cam leaves it, for the flight back. */
  cameraPose(camera: PerspectiveCamera): { position: Vector3; quaternion: Quaternion } {
    const o = this.origin.current;
    return {
      position: new Vector3(camera.position.x + o[0], camera.position.y + o[1], camera.position.z + o[2]),
      quaternion: camera.quaternion.clone(),
    };
  }

  dispose(): void {
    this.scene.removeFromParent();
    for (const w of this.wrecks) w.dispose();
    this.wrecks.length = 0;
    this.weapons.dispose();
    this.effects.dispose();
    this.downed.clear();
  }
}
