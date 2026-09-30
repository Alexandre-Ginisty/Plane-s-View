/**
 * The flight model: state creation, the 6-DOF integrator and the flight-phase
 * machine (ground → airborne → landed / crashed), for every airframe — the
 * config selects the airframe, the engine type and fly-by-wire. Pure and
 * deterministic: `step` never mutates its inputs.
 *
 * Adapted from Tater's Flight Sim (https://github.com/JaredTate/tatertotsflightsim),
 * MIT licence, Copyright (c) 2026 Jared Tate — see ./LICENSE. The runway
 * spawns, the gun recoil and the centreline scoring of the original are left
 * out; everything else is its calibrated model. Its calibration, checked by
 * that project's tests (ISA, no wind, 1/120 s step), in short:
 *
 *   C172RG, 1100 kg   stall 49.5 KIAS clean / 42.4 full flaps; Vy 679 fpm;
 *                     127 KTAS cruise at 8000 ft; glide 9.6:1; 55 °/s roll;
 *                     coordinated stall breaks straight; developed spin
 *                     177 °/s, nose −44°, recovers in ~0.4 turn (PARE).
 *   F-16C, 12 t       76 / 129 kN mil / max AB; idle → 95 % in 4.2 s; M 2.0 at
 *                     40,000 ft; 9 g / −3 g FBW, 25° AoA limit, 300 °/s roll.
 *   A-10C, 16 t       80.6 kN, slow spool (7.2 s); stall 116 KIAS clean; roll
 *                     92–114 °/s; 369 KTAS at 1,000 ft; spin-resistant.
 *   747-400, 220 t    1,008 kN; CLmax 1.30 / 2.35; L/D 17.1; M 0.85 at FL350;
 *                     roll 13–21 °/s; auto ground spoilers; > 3.75 g breaks it.
 */

import { MS_TO_FPM, MS_TO_KT, type FlightConfig } from './config';
import type { AircraftState, Controls, CrashRecord, DerivedData, Environment, Quat, TouchdownRecord, Vec3 } from './types';
import { clamp, moveToward, qIntegrateBody } from './math';
import { airDataFromBodyVelocity, bodyToWorld, eulerFromQuat, pqrFromOmega, quatFromEuler, worldToBody } from './frames';
import { airDensity, speedOfSound } from './atmosphere';
import { computeAero, stallAlphaRad } from './aero';
import { steadyEngine, stepEngine, stepJetEngine } from './engine';
import { applyFbw } from './fbw';
import { groundContacts } from './ground';
import { solveTrim, type TrimRequest } from './trim';

const DEG = Math.PI / 180;
const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });

export function defaultControls(): Controls {
  return {
    throttle: 0,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    elevatorTrim: 0,
    flapsNotch: 0,
    gearDown: true,
    brake: 0,
    parkingBrake: false,
    engineOn: true,
    speedBrake: false,
  };
}

const num = (v: number, lo: number, hi: number, fallback = 0): number => (Number.isFinite(v) ? clamp(v, lo, hi) : fallback);

/** Every control into range; NaN → neutral. */
function sanitize(c: Controls, cfg: FlightConfig): Controls {
  const n = cfg.aircraft.flaps.notchesDeg.length;
  return {
    throttle: num(c.throttle, 0, 1),
    elevator: num(c.elevator, -1, 1),
    aileron: num(c.aileron, -1, 1),
    rudder: num(c.rudder, -1, 1),
    elevatorTrim: num(c.elevatorTrim, -1, 1),
    flapsNotch: Math.round(num(c.flapsNotch, 0, n - 1)),
    gearDown: c.gearDown !== false,
    brake: num(c.brake, 0, 1),
    parkingBrake: !!c.parkingBrake,
    engineOn: c.engineOn !== false,
    speedBrake: c.speedBrake === true,
  };
}

/** Flight Mach number. */
export function machNumber(state: AircraftState): number {
  const m = state.derived.tas / speedOfSound(state.position.y);
  return Number.isFinite(m) ? m : 0;
}

/** Touchdown rating by sink rate (fpm); beyond hardFpm the gear collapses. */
function classifyTouchdown(verticalSpeedFpm: number, cfg: FlightConfig): TouchdownRecord['rating'] | 'crash' {
  const l = cfg.aircraft.landing;
  const v = Math.abs(verticalSpeedFpm);
  if (!(v <= l.hardFpm)) return 'crash';
  if (v <= l.butterFpm) return 'butter';
  if (v <= l.smoothFpm) return 'smooth';
  if (v <= l.firmFpm) return 'firm';
  return 'hard';
}

function computeDerived(
  pos: Vec3,
  vel: Vec3,
  q: Quat,
  omega: Vec3,
  wind: Vec3,
  loadFactor: number,
  env: Environment,
  cfg: FlightConfig,
): DerivedData {
  const rho = airDensity(pos.y);
  const vb = worldToBody(q, { x: vel.x - wind.x, y: vel.y - wind.y, z: vel.z - wind.z });
  const ad = airDataFromBodyVelocity(vb);
  const e = eulerFromQuat(q);
  const { p, q: qr, r } = pqrFromOmega(omega);
  const ground = env.groundHeight(pos.x, pos.z);
  const water = env.waterLevel(pos.x, pos.z);
  const surface = water !== null && water > ground ? water : ground;
  return {
    tas: ad.V,
    ias: ad.V * Math.sqrt(rho / cfg.sim.seaLevelDensity),
    groundSpeed: Math.hypot(vel.x, vel.z),
    alpha: ad.alpha,
    beta: ad.beta,
    verticalSpeed: vel.y,
    altitudeAGL: pos.y - surface,
    headingDeg: e.headingDeg,
    pitchDeg: e.pitchDeg,
    rollDeg: e.rollDeg,
    loadFactor,
    density: rho,
    p,
    q: qr,
    r,
  };
}

const windAt = (env: Environment, p: Vec3, t: number): Vec3 => (env.wind ? env.wind(p.x, p.y, p.z, t) : ZERO);

/**
 * An airborne aircraft in steady, trimmed, wings-level flight, and the
 * controls that hold it there hands-off.
 */
export function createTrimmedState(req: TrimRequest, env: Environment, cfg: FlightConfig): { state: AircraftState; controls: Controls } {
  const tr = solveTrim(req, cfg);
  const heading = req.headingDeg ?? 0;
  const gamma = (req.flightPathDeg ?? 0) * DEG;
  const h = heading * DEG;
  const position = { x: req.x ?? 0, y: req.altitudeM, z: req.z ?? 0 };
  const wind = windAt(env, position, 0);
  const vh = tr.tas * Math.cos(gamma);
  const velocity = { x: Math.sin(h) * vh + wind.x, y: tr.tas * Math.sin(gamma) + wind.y, z: -Math.cos(h) * vh + wind.z };
  const orientation = quatFromEuler(heading, tr.pitchDeg, 0);
  const ias = tr.tas * Math.sqrt(tr.density / cfg.sim.seaLevelDensity) * MS_TO_KT;
  const engine = steadyEngine(tr.power, tr.density, tr.tas * Math.cos(tr.alpha), ias, tr.tas / speedOfSound(req.altitudeM), cfg);
  const state: AircraftState = {
    time: 0,
    position,
    velocity,
    orientation,
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine,
    flapsDeg: tr.flapsDeg,
    gearPos: req.gearDown === false ? 0 : 1,
    phase: 'airborne',
    stalled: false,
    onGround: false,
    wheelContact: [false, false, false],
    wheelCompression: [0, 0, 0],
    airborneTime: 60,
    touchdown: null,
    crash: null,
    derived: computeDerived(position, velocity, orientation, ZERO, wind, 1, env, cfg),
  };
  const controls: Controls = {
    ...defaultControls(),
    throttle: tr.throttle,
    elevatorTrim: tr.elevatorTrim,
    flapsNotch: Math.round(req.flapsNotch ?? 0),
    gearDown: req.gearDown !== false,
  };
  return { state, controls };
}

function crashedState(
  s: AircraftState,
  reason: string,
  time: number,
  env: Environment,
  cfg: FlightConfig,
  extra: Partial<AircraftState> = {},
): AircraftState {
  const v = s.velocity;
  const crash: CrashRecord = {
    time,
    reason,
    speedKt: Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * MS_TO_KT,
    verticalSpeedFpm: v.y * MS_TO_FPM,
    position: { ...s.position },
  };
  const position = { ...s.position };
  return {
    ...s,
    ...extra,
    time,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    orientation: { ...s.orientation },
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine: { running: false, starting: false, startTimer: 0, failed: true, power: 0, rpm: 0, thrust: 0, afterburner: 0 },
    phase: 'crashed',
    stalled: false,
    crash,
    derived: computeDerived(position, ZERO, s.orientation, ZERO, ZERO, 1, env, cfg),
  };
}

/**
 * Ground spoilers: every panel up while the mains are on the ground above
 * wheel spin-up speed with the lever raised or the thrust levers at idle.
 */
function groundSpoilerExtension(state: AircraftState, c: Pick<Controls, 'throttle' | 'speedBrake'>, cfg: FlightConfig): number {
  const sp = cfg.aircraft.aero.spoilers;
  if (!sp || state.gearPos < 0.999) return 0;
  if (!(state.wheelContact[1] || state.wheelContact[2])) return 0;
  if (!(state.derived.groundSpeed * MS_TO_KT >= sp.autoMinGroundKt)) return 0;
  return c.speedBrake === true || c.throttle <= sp.autoIdleThrottle ? 1 : 0;
}

function stepOnce(state: AircraftState, raw: Controls, dt: number, env: Environment, cfg: FlightConfig): AircraftState {
  const time = state.time + dt;
  if (state.phase === 'crashed') return { ...structuredClone(state), time };
  const ac = cfg.aircraft;
  const pilot = sanitize(raw, cfg);
  // Fly-by-wire: stick and pedals become surface commands.
  const c = ac.fbw ? applyFbw(state, pilot, cfg) : pilot;
  const g = cfg.sim.gravity;
  const m = ac.mass;
  const pos = state.position;
  const vel = state.velocity;
  const q = state.orientation;
  const w = state.angularVelocity;

  // ── Air data ──
  const wind = windAt(env, pos, state.time);
  const vb = worldToBody(q, { x: vel.x - wind.x, y: vel.y - wind.y, z: vel.z - wind.z });
  const rho = airDensity(pos.y);
  const ad = airDataFromBodyVelocity(vb);
  const iasKt = ad.V * Math.sqrt(rho / cfg.sim.seaLevelDensity) * MS_TO_KT;
  const mach = ad.V / speedOfSound(pos.y);

  // ── Systems: flaps, gear (squat switch), engine ──
  const notches = ac.flaps.notchesDeg;
  const autoFlaps = ac.flaps.autoWithGearDeg > 0 && c.gearDown && iasKt < ac.flaps.autoRetractKt ? ac.flaps.autoWithGearDeg : 0;
  const flapsDeg = moveToward(state.flapsDeg, Math.max(notches[c.flapsNotch]!, autoFlaps), ac.flaps.rateDegPerSec * dt);
  // The gear only starts up once continuously airborne for retractDelay.
  const weightOnWheels = state.onGround || state.airborneTime < ac.gear.retractDelay;
  const gearTarget = c.gearDown || (ac.gear.squatSwitch && weightOnWheels && state.gearPos >= 0.999) ? 1 : 0;
  const gearPos = moveToward(state.gearPos, gearTarget, dt / ac.gear.transitTime);
  const engine =
    ac.engine.type === 'jet'
      ? stepJetEngine(state.engine, c, dt, rho, mach, iasKt, cfg)
      : stepEngine(state.engine, c, dt, rho, Math.max(0, ad.u), iasKt, cfg);

  // ── Airframe forces (body) ──
  const wingHeight = state.derived.altitudeAGL + ac.geometry.wingRootLeadingEdge.y;
  const groundSpoilers = groundSpoilerExtension(state, c, cfg);
  const aero = computeAero(vb, w, rho, flapsDeg, gearPos, c, engine.thrust, cfg, wingHeight, {
    mach,
    speedBrake: c.speedBrake ? 1 : 0,
    groundSpoilers,
  });
  const fAir = bodyToWorld(q, { x: aero.fx, y: aero.fy, z: aero.fz });

  // ── Ground, structure, water, obstacles ──
  const gr = groundContacts(
    {
      position: pos,
      velocity: vel,
      orientation: q,
      omegaWorld: bodyToWorld(q, w),
      gearPos,
      brake: c.brake,
      parkingBrake: c.parkingBrake,
      rudder: pilot.rudder,
      engineRunning: engine.running,
    },
    env,
    cfg,
  );
  if (gr.crashReason) return crashedState(state, gr.crashReason, time, env, cfg, { flapsDeg, gearPos });

  // ── Flight phase: touchdowns and take-offs ──
  let phase = state.phase;
  let airborneTime = state.airborneTime;
  let touchdown = state.touchdown;
  if (gr.onGround) {
    if (state.phase === 'airborne') {
      const vsFpm = vel.y * MS_TO_FPM;
      const lim = ac.landing;
      if (-vsFpm > lim.hardFpm) {
        const reason = -vel.y > lim.terrainImpactMs ? 'Hit terrain' : 'Hard landing — gear collapsed';
        return crashedState(state, reason, time, env, cfg, { flapsDeg, gearPos });
      }
      if (state.airborneTime >= lim.minAirborneTime) {
        const e = eulerFromQuat(q);
        if (Math.abs(e.rollDeg) > lim.maxBankDeg) {
          return crashedState(state, 'Wingtip strike — too much bank at touchdown', time, env, cfg, { flapsDeg, gearPos });
        }
        if (e.pitchDeg < lim.minPitchDeg) {
          return crashedState(state, 'Landed nose-first', time, env, cfg, { flapsDeg, gearPos });
        }
        touchdown = {
          time,
          verticalSpeedFpm: vsFpm,
          airspeedKt: iasKt,
          rating: classifyTouchdown(vsFpm, cfg) as TouchdownRecord['rating'],
          bankDeg: e.rollDeg,
          pitchDeg: e.pitchDeg,
          surface: env.surfaceAt(pos.x, pos.z),
        };
        phase = 'landed';
      } else {
        // A short hop: back to the ground phase we came from, no new rating.
        phase = state.touchdown ? 'landed' : 'ground';
      }
    }
    airborneTime = 0;
  } else {
    phase = 'airborne';
    airborneTime = state.airborneTime + dt;
  }

  // ── Integrate (semi-implicit Euler) ──
  const fx = fAir.x + gr.force.x;
  const fy = fAir.y + gr.force.y - m * g;
  const fz = fAir.z + gr.force.z;
  const velocity = { x: vel.x + (fx / m) * dt, y: vel.y + (fy / m) * dt, z: vel.z + (fz / m) * dt };
  const position = { x: pos.x + velocity.x * dt, y: pos.y + velocity.y * dt, z: pos.z + velocity.z * dt };

  const tg = worldToBody(q, gr.torque);
  const tx = aero.tx + tg.x;
  const ty = aero.ty + tg.y;
  const tz = aero.tz + tg.z;
  const I = ac.inertia;
  // ω̇ = I⁻¹(τ − ω × Iω), diagonal inertia (pitch = X, yaw = Y, roll = Z).
  const hx = I.pitch * w.x;
  const hy = I.yaw * w.y;
  const hz = I.roll * w.z;
  const wMax = ac.limits.maxAngularRate;
  const angularVelocity = {
    x: clamp(w.x + ((tx - (w.y * hz - w.z * hy)) / I.pitch) * dt, -wMax, wMax),
    y: clamp(w.y + ((ty - (w.z * hx - w.x * hz)) / I.yaw) * dt, -wMax, wMax),
    z: clamp(w.z + ((tz - (w.x * hy - w.y * hx)) / I.roll) * dt, -wMax, wMax),
  };
  const orientation = qIntegrateBody(q, angularVelocity, dt);

  // ── Load factor: accelerometer along body up; the aero part decides over-G ──
  const nAero = aero.fy / (m * g);
  const gBody = worldToBody(q, gr.force);
  const loadFactor = (aero.fy + gBody.y) / (m * g);
  if (nAero > ac.limits.structuralFailureG || nAero < ac.limits.structuralFailureNegG) {
    return crashedState(state, 'Structural failure — over-G', time, env, cfg, { flapsDeg, gearPos });
  }
  if (iasKt > ac.limits.vneKt * ac.limits.overspeedFailureFactor) {
    return crashedState(state, 'Structural failure — overspeed', time, env, cfg, { flapsDeg, gearPos });
  }

  const derived = computeDerived(position, velocity, orientation, angularVelocity, wind, loadFactor, env, cfg);

  // ── Stall flag with hysteresis ──
  const aStall = stallAlphaRad(flapsDeg, cfg);
  let stalled = false;
  if (phase === 'airborne') {
    stalled = state.stalled ? derived.alpha > aStall - ac.stall.recoveryHysteresisDeg * DEG : derived.alpha > aStall;
  }

  return {
    time,
    position,
    velocity,
    orientation,
    angularVelocity,
    engine,
    flapsDeg,
    gearPos,
    phase,
    stalled,
    onGround: gr.onGround,
    wheelContact: gr.wheelContact,
    wheelCompression: gr.wheelCompression,
    airborneTime,
    touchdown,
    crash: null,
    derived,
  };
}

/**
 * Advance by dt seconds (normally `cfg.sim.fixedDt`). Pure and deterministic;
 * a dt above 1.5 × fixedDt is split into equal sub-steps.
 */
export function step(state: AircraftState, controls: Controls, dt: number, env: Environment, cfg: FlightConfig): AircraftState {
  if (!(dt > 0) || !Number.isFinite(dt)) return structuredClone(state);
  if (dt <= cfg.sim.fixedDt * 1.5) return stepOnce(state, controls, dt, env, cfg);
  const n = Math.ceil(dt / cfg.sim.fixedDt);
  const h = dt / n;
  let s = state;
  for (let i = 0; i < n; i++) s = stepOnce(s, controls, h, env, cfg);
  return s;
}
