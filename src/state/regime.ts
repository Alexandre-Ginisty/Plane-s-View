/**
 * What the aircraft is *doing*, inferred from where it is and where it is going.
 *
 * ADS-B carries no engine data at all — no N1, no torque, no throttle
 * position, nothing. Everything that has to react to power (the propellers,
 * the engine sound) therefore has to infer it, and the inference is the same
 * one a spotter makes from the ground: an aircraft climbing away at 2000 feet
 * a minute is at climb power, one descending with the speed brakes out is at
 * idle, and one sitting still is at idle too.
 *
 * ## Why this lives on its own
 *
 * Because two very different consumers need the same answer and must agree.
 * If the sound says climb power while the propellers say idle the whole effect
 * collapses — the mismatch is more noticeable than either being wrong, since
 * the ear and the eye are being given contradictory evidence about the same
 * aeroplane. One function, one answer.
 */

import type { SampledAircraft } from './track';

export interface FlightRegime {
  /**
   * Engine power, 0 (shut down / idle) to 1 (takeoff).
   *
   * Not a throttle position and not claimed to be: it is a plausible power
   * setting for the observed flight path, which is all that can be had.
   */
  power: number;
  /** Speed through the air, metres per second. Ground speed stands in for it. */
  speedMps: number;
  altFt: number;
  onGround: boolean;
  /** Climbing hard enough that it reads as a departure. */
  departing: boolean;
}

const KT_TO_MPS = 0.514_444;

/** Cruise power: what a jet spends almost all of its life at. */
const CRUISE_POWER = 0.62;

export function flightRegime(sample: SampledAircraft): FlightRegime {
  const speedMps = Math.max(0, sample.groundSpeedKt) * KT_TO_MPS;
  const onGround = sample.latest.onGround === true;
  const vs = sample.verticalRateFpm;

  let power: number;

  if (onGround) {
    /*
     * On the ground the speed *is* the throttle, and the two ends of the range
     * are very far apart: an aircraft at a stand is at idle, one taxiing is
     * barely above it, and one accelerating through 80 knots is at takeoff
     * power. Interpolating across the whole range would have a heavy jet at
     * half power while it is being pushed back.
     */
    const kt = sample.groundSpeedKt;
    if (kt < 3) power = 0.04;
    else if (kt < 35) power = 0.08 + (kt / 35) * 0.06;
    else power = Math.min(1, 0.14 + ((kt - 35) / 60) * 0.86);
  } else {
    /*
     * Airborne, the vertical speed is the signal. Climb is expensive and
     * descent is nearly free — a jet descends at flight idle — so the curve is
     * strongly asymmetric about level flight, and that asymmetry is exactly
     * what makes the engine note change on the way down the way it should.
     */
    if (vs > 0) {
      power = CRUISE_POWER + Math.min(1, vs / 2200) * (1 - CRUISE_POWER);
    } else {
      power = CRUISE_POWER - Math.min(1, -vs / 1600) * (CRUISE_POWER - 0.14);
    }

    // Low and slow is an approach: the engines are spooled up against the drag
    // of flaps and gear, which is why a landing aircraft is louder than one
    // cruising overhead at the same power fraction would suggest.
    if (sample.altFt < 4_000 && sample.groundSpeedKt < 200) {
      power = Math.max(power, 0.34);
    }
  }

  return {
    power: Math.min(1, Math.max(0, power)),
    speedMps,
    altFt: sample.altFt,
    onGround,
    departing: !onGround && vs > 900 && sample.altFt < 12_000,
  };
}
