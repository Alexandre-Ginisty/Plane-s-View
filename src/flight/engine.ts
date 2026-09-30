/**
 * Engines: a piston with a constant-speed propeller, and a turbofan with an
 * optional afterburner. Pure.
 *
 * Piston: power target = idle + (1 − idle)·throttle, × density ratio, followed
 * with a first-order lag; thrust T = P·η/√(V² + V₀²) with V₀ chosen so the
 * static thrust matches, minus a windmilling prop's drag.
 *
 * Jet: the throttle runs idle → military up to the afterburner detent, and
 * selects afterburner past it. The core follows its target with a time
 * constant long at idle and short near military (idle → mil takes seconds),
 * and the afterburner lights only with the core near military.
 * Thrust = [idle + (mil − idle)·core]·σ^k·(1 − l·M + ramDry·M²)
 *        + ab·(max − mil)·σ^k·(1 − l·M + ramAb·M²).
 *
 * Adapted from Tater's Flight Sim (MIT, Copyright (c) 2026 Jared Tate — see
 * ./LICENSE).
 */

import type { FlightConfig, JetEngineConfig } from './config';
import type { Controls, EngineState } from './types';
import { clamp, expApproach, moveToward } from './math';

type EngineControls = Pick<Controls, 'throttle' | 'engineOn'>;

// ─── Piston ─────────────────────────────────────────────────────────────────

function powerTarget(throttle: number, density: number, cfg: FlightConfig): number {
  const e = cfg.aircraft.engine;
  const sigma = Math.min(density / cfg.sim.seaLevelDensity, 1.1);
  return (e.idlePower + (1 - e.idlePower) * clamp(throttle, 0, 1)) * sigma;
}

function throttleForPower(power: number, density: number, cfg: FlightConfig): number {
  const e = cfg.aircraft.engine;
  const sigma = Math.min(density / cfg.sim.seaLevelDensity, 1.1);
  return (power / sigma - e.idlePower) / (1 - e.idlePower);
}

function propThrust(powerFraction: number, airspeedMs: number, density: number, cfg: FlightConfig): number {
  const e = cfg.aircraft.engine;
  const eta = e.propEfficiency;
  const v0 = (e.maxPowerW * eta) / e.staticThrustN;
  const V = airspeedMs > 0 ? airspeedMs : 0;
  const p = powerFraction > 0 ? powerFraction : 0;
  const thrust = (p * e.maxPowerW * eta) / Math.sqrt(V * V + v0 * v0);
  const r = cfg.aircraft.geometry.propRadius;
  const unload = 1 - clamp(powerFraction, 0, 1);
  const windmill = e.windmillDragCoeff * unload * unload * 0.5 * density * V * V * Math.PI * r * r;
  return thrust - windmill;
}

function runningRpm(power: number, density: number, iasKt: number, cfg: FlightConfig): number {
  const e = cfg.aircraft.engine;
  const lever = clamp(throttleForPower(power, density, cfg), 0, 1);
  const rpm = e.idleRpm + (e.maxRpm - e.idleRpm) * Math.pow(lever, 0.75);
  return Math.min(Math.max(rpm, e.windmillRpmPerKt * Math.max(0, iasKt)), e.maxRpm * 1.04);
}

/** Starter, crank and shutdown logic shared by both engine types. */
function ignition(engine: EngineState, controls: EngineControls, dt: number, startTime: number) {
  let running = engine.running;
  let starting = engine.starting;
  let startTimer = engine.startTimer;
  if (engine.failed || !controls.engineOn) {
    running = false;
    starting = false;
    startTimer = 0;
  } else if (!running) {
    if (!starting) {
      starting = true;
      startTimer = 0;
    }
    startTimer += dt;
    if (startTimer >= startTime) {
      running = true;
      starting = false;
      startTimer = 0;
    }
  }
  return { running, starting, startTimer };
}

/** Advance the piston engine. `axialSpeed` = forward airspeed through the prop. */
export function stepEngine(
  engine: EngineState,
  controls: EngineControls,
  dt: number,
  density: number,
  axialSpeed: number,
  iasKt: number,
  cfg: FlightConfig,
): EngineState {
  const e = cfg.aircraft.engine;
  const { running, starting, startTimer } = ignition(engine, controls, dt, e.startTime);

  const target = running ? powerTarget(controls.throttle, density, cfg) : 0;
  const tau = target > engine.power ? e.spoolUpTau : e.spoolDownTau;
  let power = running ? expApproach(engine.power, target, tau, dt) : expApproach(engine.power, 0, e.spoolDownTau, dt);
  if (!running && power < 1e-4) power = 0;

  const windmill = e.windmillRpmPerKt * Math.max(0, iasKt);
  let rpmTarget: number;
  let rpmTau: number;
  if (running) {
    rpmTarget = runningRpm(power, density, iasKt, cfg);
    rpmTau = e.rpmTau;
  } else if (starting) {
    rpmTarget = Math.max(windmill, e.crankRpm);
    rpmTau = e.rpmTau;
  } else {
    rpmTarget = windmill;
    rpmTau = e.spinDownTau;
  }
  let rpm = expApproach(engine.rpm, rpmTarget, rpmTau, dt);
  if (rpm < 0.5 && rpmTarget === 0) rpm = 0;

  return { running, starting, startTimer, failed: engine.failed, power, rpm, thrust: propThrust(power, axialSpeed, density, cfg) };
}

// ─── Jet ────────────────────────────────────────────────────────────────────

function jetOf(cfg: FlightConfig): JetEngineConfig {
  const j = cfg.aircraft.engine.jet;
  if (!j) throw new Error(`${cfg.aircraft.name} has no jet engine`);
  return j;
}

function jetThrust(core: number, ab: number, density: number, mach: number, cfg: FlightConfig): number {
  const j = jetOf(cfg);
  const sigma = Math.max(0, density) / cfg.sim.seaLevelDensity;
  const lapse = Math.pow(sigma, j.densityExponent);
  const m = Number.isFinite(mach) && mach > 0 ? mach : 0;
  const c = clamp(Number.isFinite(core) ? core : 0, 0, 1);
  const a = clamp(Number.isFinite(ab) ? ab : 0, 0, 1);
  const lo = 1 - j.lowSpeedLapse * m;
  const dry = (j.idleThrustN + (j.milThrustN - j.idleThrustN) * c) * lapse * (lo + j.ramDry * m * m);
  const wet = a * (j.maxThrustN - j.milThrustN) * lapse * (lo + j.ramAb * m * m);
  return dry + wet;
}

function jetCoreTarget(throttle: number, cfg: FlightConfig): number {
  return clamp(clamp(throttle, 0, 1) / jetOf(cfg).abDetent, 0, 1);
}

function jetAbTarget(throttle: number, cfg: FlightConfig): number {
  const j = jetOf(cfg);
  const t = clamp(throttle, 0, 1);
  if (t <= j.abDetent) return 0;
  return j.abMin + (1 - j.abMin) * clamp((t - j.abDetent) / (1 - j.abDetent), 0, 1);
}

/** Core speed % for a core fraction. */
function coreRpm(core: number, cfg: FlightConfig): number {
  const e = cfg.aircraft.engine;
  return e.idleRpm + (e.maxRpm - e.idleRpm) * Math.sqrt(clamp(core, 0, 1));
}

export function stepJetEngine(
  engine: EngineState,
  controls: EngineControls,
  dt: number,
  density: number,
  mach: number,
  iasKt: number,
  cfg: FlightConfig,
): EngineState {
  const e = cfg.aircraft.engine;
  const j = jetOf(cfg);
  const throttle = Number.isFinite(controls.throttle) ? controls.throttle : 0;
  const { running, starting, startTimer } = ignition(engine, controls, dt, e.startTime);

  const prevCore = clamp(Number.isFinite(engine.power) ? engine.power : 0, 0, 1);
  const prevAb = clamp(engine.afterburner ?? 0, 0, 1);
  let core = 0;
  let ab = 0;
  let rpm: number;
  const windmill = e.windmillRpmPerKt * Math.max(0, Number.isFinite(iasKt) ? iasKt : 0);
  if (running) {
    const target = jetCoreTarget(throttle, cfg);
    const tau = target > prevCore ? j.spoolUpTauIdle + (j.spoolUpTauMil - j.spoolUpTauIdle) * prevCore : j.spoolDownTau;
    core = clamp(expApproach(prevCore, target, tau, dt), 0, 1);
    // Close the last sliver so the core actually reaches military.
    if (Math.abs(core - target) < 2e-4) core = target;
    const abWanted = core >= j.abLightCore ? jetAbTarget(throttle, cfg) : 0;
    ab = moveToward(prevAb, abWanted, (abWanted > prevAb ? j.abRampUpPerSec : j.abRampDownPerSec) * dt);
    rpm = expApproach(Number.isFinite(engine.rpm) ? engine.rpm : 0, coreRpm(core, cfg), e.rpmTau, dt);
  } else {
    const rpmTarget = starting ? Math.max(windmill, e.crankRpm) : windmill;
    const tau = starting ? e.rpmTau * 4 : e.spinDownTau;
    rpm = expApproach(Number.isFinite(engine.rpm) ? engine.rpm : 0, rpmTarget, tau, dt);
    if (rpm < 0.05 && rpmTarget === 0) rpm = 0;
  }
  const thrust = running ? jetThrust(core, ab, density, mach, cfg) : 0;
  return { running, starting, startTimer, failed: engine.failed, power: core, rpm: clamp(rpm, 0, e.maxRpm * 1.04), thrust, afterburner: ab };
}

// ─── Either type (trim solver, state creation) ─────────────────────────────────

/** Thrust at a steady power (piston: power fraction; jet: core fraction, no afterburner). */
export function engineThrust(power: number, axialSpeed: number, density: number, mach: number, cfg: FlightConfig): number {
  return cfg.aircraft.engine.type === 'jet' ? jetThrust(power, 0, density, mach, cfg) : propThrust(power, axialSpeed, density, cfg);
}

/** Steady power a throttle position settles at. */
export function enginePowerTarget(throttle: number, density: number, cfg: FlightConfig): number {
  return cfg.aircraft.engine.type === 'jet' ? jetCoreTarget(throttle, cfg) : powerTarget(throttle, density, cfg);
}

/** Throttle that gives a steady power (unclamped for pistons). */
export function engineThrottleForPower(power: number, density: number, cfg: FlightConfig): number {
  return cfg.aircraft.engine.type === 'jet' ? power * jetOf(cfg).abDetent : throttleForPower(power, density, cfg);
}

/** A warm engine running steadily at `power`. */
export function steadyEngine(power: number, density: number, axialSpeed: number, iasKt: number, mach: number, cfg: FlightConfig): EngineState {
  if (cfg.aircraft.engine.type === 'jet') {
    const c = clamp(power, 0, 1);
    return {
      running: true,
      starting: false,
      startTimer: 0,
      failed: false,
      power: c,
      rpm: coreRpm(c, cfg),
      thrust: jetThrust(c, 0, density, mach, cfg),
      afterburner: 0,
    };
  }
  return {
    running: true,
    starting: false,
    startTimer: 0,
    failed: false,
    power,
    rpm: runningRpm(power, density, iasKt, cfg),
    thrust: propThrust(power, axialSpeed, density, cfg),
  };
}
