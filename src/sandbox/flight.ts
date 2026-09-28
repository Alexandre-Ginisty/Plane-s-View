/**
 * Arcade flight: arrow keys in, an aircraft out.
 *
 * Not a flight model, on purpose. Up climbs, down descends, left and right
 * turn — the bank follows the turn by itself, and nothing stalls, spins or
 * runs out of fuel. What it does get right is the part the rest of the app
 * reads: a position that moves along the heading at the speed shown, a pitch
 * that matches the climb, a bank that matches the turn. The output is a
 * `SampledAircraft` like any aircraft from the feed, so the camera, the HUD,
 * the model and the engine sound all take it unchanged.
 */

import { FEET_TO_METRES, clamp, wrapHeading } from '@/core/math/geo';
import type { AircraftState } from '@/data/types';
import type { SampledAircraft } from '@/state/traffic';
import type { FlightSpec } from './catalog';

export interface FlightInput {
  /** +1 climb, -1 descend. */
  pitch: number;
  /** +1 right, -1 left. */
  turn: number;
  boost: boolean;
  brake: boolean;
}

export const NO_INPUT: FlightInput = { pitch: 0, turn: 0, boost: false, brake: false };

const KT = 0.514_444;
const M_PER_DEG = 111_320;
/** Highest the sandbox lets anything climb, metres. */
const CEILING_M = 14_000;

/** Ease `value` towards `target` with time constant `tau`. */
function ease(value: number, target: number, tau: number, dt: number): number {
  return value + (target - value) * (1 - Math.exp(-dt / tau));
}

export class ArcadeFlight {
  lat: number;
  lon: number;
  altM: number;
  headingDeg: number;
  pitchDeg = 0;
  rollDeg = 0;
  speedKt: number;
  verticalFpm = 0;

  private readonly sample: SampledAircraft;

  constructor(
    readonly spec: FlightSpec,
    start: { lat: number; lon: number; altM: number; headingDeg: number },
    hex: string,
    type: string,
    callsign: string,
  ) {
    this.lat = start.lat;
    this.lon = start.lon;
    this.altM = start.altM;
    this.headingDeg = start.headingDeg;
    this.speedKt = spec.cruiseKt;
    const latest = {
      hex,
      callsign,
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
      category: spec.heli ? 'A7' : 'A3',
      emergency: null,
      onGround: false,
      navAltitudeMcpFt: null,
      navHeadingDeg: null,
      typeCode: type,
    } as unknown as AircraftState;
    this.sample = {
      hex,
      lat: start.lat,
      lon: start.lon,
      altFt: start.altM / FEET_TO_METRES,
      trackDeg: start.headingDeg,
      headingDeg: start.headingDeg,
      rollDeg: 0,
      pitchDeg: 0,
      groundSpeedKt: this.speedKt,
      verticalRateFpm: 0,
      ageSec: 0,
      stale: false,
      uncertaintyM: 0,
      latest,
    };
  }

  /** Metres per second along the flight path. */
  get speedMps(): number {
    return this.speedKt * KT;
  }

  /**
   * Advance by `dt`. Returns false when the aircraft has flown into the
   * ground, which the caller turns into a crash.
   */
  step(dt: number, input: FlightInput, groundM: number, clearanceM: number): boolean {
    const s = this.spec;
    const turn = clamp(input.turn, -1, 1);
    const pitchIn = clamp(input.pitch, -1, 1);

    const targetSpeed = input.boost ? s.boostKt : input.brake ? s.minKt : s.cruiseKt;
    const rate = s.accelKt * dt * (input.boost ? 1.4 : 1);
    this.speedKt += clamp(targetSpeed - this.speedKt, -rate, rate);

    if (s.heli) {
      // A helicopter yaws on the spot and climbs straight up; it leans into
      // the turn and dips its nose with speed, which is all that reads.
      this.headingDeg = wrapHeading(this.headingDeg + turn * s.turnDegS * dt);
      this.rollDeg = ease(this.rollDeg, turn * s.maxBankDeg * Math.min(1, this.speedKt / 60), 0.3, dt);
      this.verticalFpm = ease(this.verticalFpm, pitchIn * 2600, 0.35, dt);
      this.pitchDeg = ease(this.pitchDeg, -(this.speedKt / s.boostKt) * 9 + pitchIn * 3, 0.5, dt);
    } else {
      this.rollDeg = ease(this.rollDeg, turn * s.maxBankDeg, 0.35, dt);
      const bank = this.rollDeg / s.maxBankDeg;
      this.headingDeg = wrapHeading(this.headingDeg + bank * s.turnDegS * dt);
      // A steep bank costs a little height unless held up, like the real
      // thing, only much more gently.
      this.pitchDeg = ease(this.pitchDeg, pitchIn * s.maxPitchDeg, 0.45, dt);
      this.verticalFpm = (Math.sin((this.pitchDeg * Math.PI) / 180) * this.speedMps * 60) / FEET_TO_METRES;
    }

    const h = (this.headingDeg * Math.PI) / 180;
    const horizontal = s.heli ? this.speedMps : this.speedMps * Math.cos((this.pitchDeg * Math.PI) / 180);
    const d = horizontal * dt;
    this.lat = clamp(this.lat + (Math.cos(h) * d) / M_PER_DEG, -85, 85);
    this.lon += (Math.sin(h) * d) / (M_PER_DEG * Math.cos((this.lat * Math.PI) / 180));
    if (this.lon > 180) this.lon -= 360;
    if (this.lon < -180) this.lon += 360;
    this.altM = Math.min(CEILING_M, this.altM + ((this.verticalFpm * FEET_TO_METRES) / 60) * dt);

    if (Number.isFinite(groundM) && this.altM < groundM + clearanceM) {
      // A helicopter settles onto the ground; anything else hits it.
      if (s.heli && this.verticalFpm > -900) {
        this.altM = groundM + clearanceM;
        this.verticalFpm = Math.max(0, this.verticalFpm);
        return true;
      }
      return false;
    }
    return true;
  }

  /** The aircraft as the rest of the app sees one. The same object each call. */
  toSample(): SampledAircraft {
    const o = this.sample;
    o.lat = this.lat;
    o.lon = this.lon;
    o.altFt = this.altM / FEET_TO_METRES;
    o.trackDeg = this.headingDeg;
    o.headingDeg = this.headingDeg;
    o.rollDeg = this.rollDeg;
    o.pitchDeg = this.pitchDeg;
    o.groundSpeedKt = this.speedKt;
    o.verticalRateFpm = this.verticalFpm;
    o.latest.lat = this.lat;
    o.latest.lon = this.lon;
    return o;
  }
}
