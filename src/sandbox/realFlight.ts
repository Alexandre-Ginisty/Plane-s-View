/**
 * The flight model, flown over the real globe.
 *
 * `@/flight` is a 6-DOF model on a flat local world: x east, z south, y the
 * height above sea level. This wraps it for the sandbox:
 *
 *  - **Where.** The local world is an equirectangular patch anchored near the
 *    aircraft — x/z are metres east/south of the anchor — and re-anchored
 *    whenever the aircraft has flown a couple of kilometres from it, so the
 *    numbers the integrator sees stay small and the patch's scale error (the
 *    parallels are not all the same length) stays far below anything visible.
 *    Grid north is true north everywhere on such a patch, so re-anchoring
 *    moves the origin and touches nothing else.
 *  - **The ground.** Once a frame the terrain is sampled from the globe at the
 *    aircraft and a span to the east and north of it, and the physics sees
 *    that plane: every wheel, wingtip and tail skid tested against the same
 *    surface the terrain mesh draws, at three lookups a frame instead of forty
 *    a step. Where the tiles have not loaded there is no ground at all, rather
 *    than a sea-level floor to crash into.
 *  - **The wind.** From `WindField`: measured at the surface and aloft.
 *  - **Out.** A `SampledAircraft`, like any aircraft on the feed, so the
 *    camera, the HUD, the model and the sound take it unchanged — with the
 *    model's origin lifted from the centre of gravity to where the renderer
 *    expects it, so the wheels it draws touch the ground where the physics'
 *    wheels do.
 */

import { FEET_TO_METRES } from '@/core/math/geo';
import type { AircraftState as FeedState } from '@/data/types';
import { createTrimmedState, machNumber, step } from '@/flight/aircraft';
import { MS_TO_FPM, MS_TO_KT, stallWarningAlpha, type FlightConfig } from '@/flight/config';
import { createControlState, updateControls, type ControlState } from '@/flight/controls';
import { bodyToWorld } from '@/flight/frames';
import type { TrimRequest } from '@/flight/trim';
import type { AircraftState, Environment, TouchdownRecord, Vec3 } from '@/flight/types';
import type { SampledAircraft } from '@/state/traffic';
import type { WindField } from './wind';

const M_PER_DEG = 111_320;
/** Re-anchor the local world once the aircraft is this far from its origin, metres. */
const REANCHOR_M = 2_000;
/** Height the physics sees where no terrain is known. */
const NO_GROUND_M = -100_000;
const BODY_UP: Vec3 = { x: 0, y: 1, z: 0 };

export type GroundAt = (lat: number, lon: number) => number;

export interface FlightStart {
  lat: number;
  lon: number;
  altM: number;
  headingDeg: number;
}

/** What the sandbox HUD shows about the aircraft's systems. */
export interface FlightReadout {
  iasKt: number;
  mach: number;
  aoaDeg: number;
  /** Sideslip, degrees, + wind from the right. */
  betaDeg: number;
  g: number;
  verticalFpm: number;
  /** Stick and pedals as the pilot holds them, −1..1 (stickY + = back). */
  stickX: number;
  stickY: number;
  /** 0..1 lever. */
  throttle: number;
  /** 0..1 (jets). */
  afterburner: number;
  hasAfterburner: boolean;
  /** Propeller rpm, or core speed % for a jet. */
  rpm: number;
  jet: boolean;
  flapsDeg: number;
  flapsTargetDeg: number;
  gear: 'up' | 'down' | 'transit';
  speedBrake: boolean;
  brake: boolean;
  /** -1..1, + nose up. */
  trim: number;
  stallWarning: boolean;
  stalled: boolean;
  overspeed: boolean;
  onGround: boolean;
}

export interface AdvanceResult {
  touchdown: TouchdownRecord | null;
}

export class GlobeFlight {
  state: AircraftState;
  private control: ControlState;
  private lat0: number;
  private lon0: number;
  private kx: number;

  // The terrain plane for this frame, local metres.
  private groundValid = false;
  private gx0 = 0;
  private gz0 = 0;
  private gh0 = 0;
  private gdx = 0;
  private gdz = 0;
  private normal: Vec3 = { x: 0, y: 1, z: 0 };
  private readonly patchM: number;

  private readonly windOut = { east: 0, north: 0 };
  private readonly windVec: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly env: Environment;
  private readonly sample: SampledAircraft;
  /** From the centre of gravity up to the model's origin, metres along body up. */
  private readonly modelLift: number;

  /** Hands off: level the wings and the flight path (the kill cam flies the aircraft). */
  autopilot = false;

  constructor(
    readonly cfg: FlightConfig,
    start: FlightStart,
    ids: { hex: string; type: string; callsign: string; category: string },
    modelClearanceM: number,
    private readonly wind: WindField,
  ) {
    this.lat0 = start.lat;
    this.lon0 = start.lon;
    this.kx = M_PER_DEG * Math.cos((start.lat * Math.PI) / 180);
    this.patchM = Math.max(12, cfg.aircraft.wingSpan / 2);
    this.modelLift = modelClearanceM + cfg.aircraft.geometry.leftMainWheel.y;

    const self = this;
    this.env = {
      groundHeight(x, z) {
        return self.groundValid ? self.gh0 + self.gdx * (x - self.gx0) + self.gdz * (z - self.gz0) : NO_GROUND_M;
      },
      groundNormal() {
        return self.normal;
      },
      // Airfields are paved, fields are not; without land-cover data the kinder
      // guess is pavement, which is where anyone tries to land.
      surfaceAt: () => 'asphalt',
      waterLevel: () => null,
      wind(x, y, z) {
        const ground = self.env.groundHeight(x, z);
        const w = self.wind.at(y, self.groundValid ? y - ground : Number.NaN, self.windOut);
        self.windVec.x = w.east;
        self.windVec.z = -w.north;
        return self.windVec;
      },
    };

    const trimmed = this.trimmedAt(start);
    this.state = trimmed.state;
    this.control = createControlState(trimmed.controls);

    this.sample = {
      hex: ids.hex,
      lat: start.lat,
      lon: start.lon,
      altFt: start.altM / FEET_TO_METRES,
      trackDeg: start.headingDeg,
      headingDeg: start.headingDeg,
      rollDeg: 0,
      pitchDeg: 0,
      groundSpeedKt: 0,
      verticalRateFpm: 0,
      ageSec: 0,
      stale: false,
      uncertaintyM: 0,
      latest: {
        hex: ids.hex,
        callsign: ids.callsign,
        lat: start.lat,
        lon: start.lon,
        altBaroFt: null,
        altGeomFt: null,
        groundSpeedKt: null,
        trackDeg: null,
        headingDeg: null,
        baroRateFpm: null,
        geomRateFpm: null,
        iasKt: null,
        tasKt: null,
        mach: null,
        rollDeg: null,
        trackRateDegSec: null,
        windDirectionDeg: null,
        windSpeedKt: null,
        oatC: null,
        tatC: null,
        navModes: null,
        navAltitudeFmsFt: null,
        isMlat: false,
        isTisb: false,
        squawk: null,
        category: ids.category,
        emergency: null,
        onGround: false,
        navAltitudeMcpFt: null,
        navHeadingDeg: null,
        typeCode: ids.type,
      } as unknown as FeedState,
    };
    this.toSample();
  }

  private trimmedAt(start: FlightStart, config: Partial<TrimRequest> = {}) {
    return createTrimmedState(
      {
        iasKt: this.cfg.aircraft.limits.cruiseKt,
        gearDown: false,
        flapsNotch: 0,
        ...config,
        altitudeM: start.altM,
        headingDeg: start.headingDeg,
      },
      this.env,
      this.cfg,
    );
  }

  /**
   * Put the aircraft in trimmed flight somewhere, controls to match: clean and
   * level at the cruise speed unless `config` says otherwise (an approach:
   * gear, flaps, a speed and a descending path).
   */
  placeAt(start: FlightStart, config: Partial<TrimRequest> = {}): void {
    this.lat0 = start.lat;
    this.lon0 = start.lon;
    this.kx = M_PER_DEG * Math.cos((start.lat * Math.PI) / 180);
    this.groundValid = false;
    const trimmed = this.trimmedAt(start, config);
    this.state = trimmed.state;
    this.control = createControlState(trimmed.controls);
  }

  get lat(): number {
    return this.lat0 - this.state.position.z / M_PER_DEG;
  }

  get lon(): number {
    return this.lon0 + this.state.position.x / this.kx;
  }

  get altM(): number {
    return this.state.position.y;
  }

  get headingDeg(): number {
    return this.state.derived.headingDeg;
  }

  get crashed(): boolean {
    return this.state.phase === 'crashed';
  }

  get crashReason(): string | null {
    return this.state.crash?.reason ?? null;
  }

  /** Speed over the ground and through it, m/s. */
  get speedMps(): number {
    const v = this.state.velocity;
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  }

  /** Engine output 0..1, afterburner on top, for the engine sound. */
  get enginePower(): number {
    const e = this.state.engine;
    return Math.min(1, e.power * 0.85 + (e.afterburner ?? 0) * 0.15 + (e.power > 0.98 ? 0.15 : 0));
  }

  /**
   * Advance by `dt`: read the keys, sample the ground, integrate.
   *
   * @param held codes of the keys down
   * @param pressed key-down edges since the last call
   */
  advance(dt: number, held: ReadonlySet<string>, pressed: readonly string[], groundAt: GroundAt): AdvanceResult {
    const before = this.state.touchdown;
    const h = Math.min(0.1, Math.max(0, dt));
    this.control = updateControls(this.control, held, pressed, h, this.cfg.aircraft.flaps.notchesDeg.length);
    if (this.autopilot) this.levelOff();
    this.maybeReanchor();
    this.sampleGround(groundAt);
    if (h > 0) this.state = step(this.state, this.control.controls, h, this.env, this.cfg);
    const td = this.state.touchdown;
    return { touchdown: td && td !== before ? td : null };
  }

  /** Wings level, flight path level: what a pilot's hands do when they let go on purpose. */
  private levelOff(): void {
    const d = this.state.derived;
    const c = this.control.controls;
    const pDeg = (d.p * 180) / Math.PI;
    const gammaDeg = (Math.asin(Math.max(-1, Math.min(1, d.verticalSpeed / Math.max(1, d.tas)))) * 180) / Math.PI;
    const qDeg = (d.q * 180) / Math.PI;
    const bank = Math.abs(d.rollDeg) > 90 ? 0 : 1;
    c.aileron = Math.max(-1, Math.min(1, -d.rollDeg / 30 - pDeg / 60));
    c.rudder = 0;
    if (this.cfg.aircraft.fbw) {
      c.elevator = Math.max(-0.5, Math.min(0.5, -gammaDeg / 20));
    } else {
      const turn = bank * (1 / Math.max(0.5, Math.cos((d.rollDeg * Math.PI) / 180)) - 1) * 0.4;
      c.elevator = Math.max(-0.6, Math.min(0.6, -gammaDeg / 12 - qDeg / 8 + turn));
    }
    this.control.raw.aileron = c.aileron;
    this.control.raw.elevator = c.elevator;
    this.control.raw.rudder = 0;
  }

  private maybeReanchor(): void {
    const p = this.state.position;
    if (Math.abs(p.x) < REANCHOR_M && Math.abs(p.z) < REANCHOR_M) return;
    const lat = this.lat;
    const lon = this.lon;
    this.lat0 = lat;
    this.lon0 = lon;
    this.kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
    this.state = { ...this.state, position: { x: 0, y: p.y, z: 0 } };
  }

  private sampleGround(groundAt: GroundAt): void {
    const lat = this.lat;
    const lon = this.lon;
    const r = this.patchM;
    const h0 = groundAt(lat, lon);
    if (!Number.isFinite(h0)) {
      this.groundValid = false;
      return;
    }
    const hE = groundAt(lat, lon + r / this.kx);
    const hN = groundAt(lat + r / M_PER_DEG, lon);
    this.groundValid = true;
    this.gx0 = this.state.position.x;
    this.gz0 = this.state.position.z;
    this.gh0 = h0;
    this.gdx = Number.isFinite(hE) ? (hE - h0) / r : 0;
    // z points south: the northern sample sits at z − r.
    this.gdz = Number.isFinite(hN) ? (h0 - hN) / r : 0;
    const len = Math.sqrt(this.gdx * this.gdx + 1 + this.gdz * this.gdz);
    this.normal = { x: -this.gdx / len, y: 1 / len, z: -this.gdz / len };
  }

  /** Metres above the terrain under the aircraft, or NaN where it is not known. */
  get aglM(): number {
    return this.groundValid ? this.state.position.y - this.env.groundHeight(this.state.position.x, this.state.position.z) : Number.NaN;
  }

  readout(): FlightReadout {
    const s = this.state;
    const c = this.control.controls;
    const ac = this.cfg.aircraft;
    const iasKt = s.derived.ias * MS_TO_KT;
    const flapsTargetDeg = ac.flaps.notchesDeg[c.flapsNotch] ?? 0;
    return {
      iasKt,
      mach: machNumber(s),
      aoaDeg: (s.derived.alpha * 180) / Math.PI,
      betaDeg: (s.derived.beta * 180) / Math.PI,
      g: s.derived.loadFactor,
      verticalFpm: s.velocity.y * MS_TO_FPM,
      stickX: c.aileron,
      stickY: c.elevator,
      throttle: c.throttle,
      afterburner: s.engine.afterburner ?? 0,
      hasAfterburner: !!ac.engine.jet && ac.engine.jet.abDetent < 1,
      rpm: s.engine.rpm,
      jet: ac.engine.type === 'jet',
      flapsDeg: s.flapsDeg,
      flapsTargetDeg: Math.max(flapsTargetDeg, ac.flaps.autoWithGearDeg > 0 && c.gearDown ? ac.flaps.autoWithGearDeg : 0),
      gear: s.gearPos >= 0.999 ? 'down' : s.gearPos <= 0.001 ? 'up' : 'transit',
      speedBrake: c.speedBrake === true,
      brake: c.brake > 0.05,
      trim: c.elevatorTrim,
      stallWarning: !s.onGround && !ac.fbw && s.derived.alpha > stallWarningAlpha(this.cfg, s.flapsDeg),
      stalled: s.stalled,
      overspeed: iasKt > ac.limits.vneKt,
      onGround: s.onGround,
    };
  }

  /** The aircraft as the rest of the app sees one. The same object each call. */
  toSample(): SampledAircraft {
    const s = this.state;
    const d = s.derived;
    const o = this.sample;
    const up = bodyToWorld(s.orientation, BODY_UP);
    const lat = this.lat;
    const lon = this.lon;
    o.lat = lat;
    o.lon = lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon;
    o.altFt = (s.position.y + this.modelLift * up.y) / FEET_TO_METRES;
    o.headingDeg = d.headingDeg;
    o.pitchDeg = d.pitchDeg;
    o.rollDeg = d.rollDeg;
    const v = s.velocity;
    o.trackDeg = d.groundSpeed > 1 ? (((Math.atan2(v.x, -v.z) * 180) / Math.PI) + 360) % 360 : d.headingDeg;
    o.groundSpeedKt = d.groundSpeed * MS_TO_KT;
    o.verticalRateFpm = v.y * MS_TO_FPM;
    const l = o.latest;
    l.lat = o.lat;
    l.lon = o.lon;
    l.onGround = s.onGround;
    l.iasKt = d.ias * MS_TO_KT;
    l.tasKt = d.tas * MS_TO_KT;
    l.mach = machNumber(s);
    return o;
  }
}
