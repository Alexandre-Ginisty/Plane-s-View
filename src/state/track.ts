/**
 * One aircraft, filtered and extrapolated.
 *
 * ADS-B arrives once or twice a second, with jitter, occasional gaps and the
 * odd position that is simply wrong. Drawing those reports directly produces
 * aircraft that stutter, and inside the cockpit view it produces a camera that
 * stutters, which is unwatchable. A constant-velocity Kalman filter in a local
 * east/north/up frame smooths the reports and — more importantly — gives a
 * principled answer for *between* them.
 *
 * ## The three rules that matter
 *
 * 1. **Extrapolation is capped.** Past `MAX_EXTRAPOLATION_SEC` the position
 *    freezes rather than continuing to fly. An aircraft that has genuinely
 *    stopped reporting has usually landed or left coverage, and a confident
 *    extrapolation a minute later is fiction drawn as fact.
 * 2. **Outliers are gated, not averaged.** A single bad fix hundreds of
 *    kilometres away would drag the filter across the map for the next several
 *    updates. Two consecutive agreeing outliers re-seed the filter instead,
 *    so a genuine jump (a re-registered hex, a feed switch) is still followed.
 * 3. **Attitude is inferred, not invented.** Roll comes from the turn rate and
 *    the coordinated-turn relation when the aircraft does not broadcast it;
 *    pitch from the vertical rate and ground speed. Both are the physically
 *    correct answer for an aircraft in balanced flight, which is where an
 *    airliner spends essentially all of its time.
 */

import {
  DEG2RAD,
  FEET_TO_METRES,
  FPM_TO_MPS,
  KNOTS_TO_MPS,
  METRES_TO_FEET,
  MPS_TO_KNOTS,
  RAD2DEG,
  angleDeltaDeg,
  clamp,
  haversineMetres,
  metresPerDegree,
  wrapHeading,
  wrapLongitude,
} from '@/core/math/geo';
import { CvKalman1D } from './kalman';
import type { AircraftState } from '@/data/types';

/** Standard gravity, for the bank-angle estimate. */
const G = 9.80665;

/**
 * How long an aircraft may go unheard before it is dimmed, then removed.
 * Receiver coverage is patchy: an aircraft crossing a gap should not vanish
 * and reappear, but one that has genuinely landed or left must not linger.
 */
const STALE_AFTER_SEC = 25;
export const DROP_AFTER_SEC = 120;

/** Extrapolating far past the last fix invents motion. Cap it. */
const MAX_EXTRAPOLATION_SEC = 20;

/** Chi-squared gate (1 dof, p ≈ 0.001) for rejecting impossible jumps. */
const OUTLIER_GATE = 10.8;

/** Re-anchor the local tangent plane past this distance, metres. */
const REANCHOR_DISTANCE_M = 150_000;

const TRAIL_CAPACITY = 240;

/**
 * How quickly a filter correction is absorbed into the drawn position, seconds.
 *
 * ## The teleport this removes
 *
 * Between fixes the drawn position is `peek(dt)` — a smooth constant-velocity
 * extrapolation, and it looks it. Then a report lands and `updatePosition`
 * applies the whole Kalman correction to `x` in one statement, so the very next
 * frame draws the aircraft somewhere else. The motion is smooth, smooth, jump,
 * smooth, smooth, jump, once per report. From orbit, on an aircraft filling a
 * third of the screen, that is the most visible thing in the view.
 *
 * The correction is not wrong — it is the filter doing its job. What is wrong
 * is applying it to the *picture* instantaneously. So the filter keeps its
 * exact answer and the renderer carries a decaying offset: at the instant of
 * the update the drawn position is unchanged, and over the next half second it
 * slides onto the corrected track. Nothing is invented and nothing is delayed;
 * the discontinuity is spread over frames the eye reads as motion.
 *
 * Half a second is long enough that a typical few-metre correction is
 * imperceptible and short enough that the drawn position is never meaningfully
 * behind the filter — at 250 m/s the worst case is a fraction of a fuselage.
 */
const CORRECTION_TAU = 0.5;

/**
 * Largest correction worth absorbing, metres. Past this, snap.
 *
 * A re-seeded filter (rule 2 above: a re-registered hex, a feed switch) is not
 * a correction, it is a different aircraft position. Sliding a kilometre would
 * draw a trajectory nothing flew, and it would take visibly longer than the
 * time constant because the eye tracks the residual, not the exponential.
 */
const MAX_ABSORBED_M = 400;

export interface TrailPoint {
  lat: number;
  lon: number;
  altFt: number;
  t: number;
}

/** An aircraft evaluated at one instant, ready to draw. */
export interface SampledAircraft {
  hex: string;
  lat: number;
  lon: number;
  /** Best available altitude, feet. Geometric preferred over barometric. */
  altFt: number;
  /** Direction of travel over the ground, degrees true. */
  trackDeg: number;
  /** Where the nose points. Differs from track in a crosswind. */
  headingDeg: number;
  /** Bank angle, degrees. Measured when broadcast, else inferred from turn rate. */
  rollDeg: number;
  /** Pitch inferred from the climb gradient, degrees. */
  pitchDeg: number;
  groundSpeedKt: number;
  verticalRateFpm: number;
  /** Seconds since the last received fix. */
  ageSec: number;
  /** True once the aircraft has gone quiet; render it dimmed. */
  stale: boolean;
  /** 1-sigma horizontal position uncertainty, metres. */
  uncertaintyM: number;
  /** The most recent raw report, for the detail panel. */
  latest: AircraftState;
}

/** Measurement variance, m², chosen from how the position was obtained. */
function positionVariance(s: AircraftState): number {
  if (s.isMlat) return 500 * 500;
  if (s.isTisb) return 300 * 300;
  if (s.source === 'opensky') return 60 * 60;
  return 25 * 25;
}

function velocityVariance(s: AircraftState): number {
  if (s.isMlat) return 25;
  if (s.source === 'opensky') return 9;
  return 1;
}

export class AircraftTrack {
  readonly hex: string;

  /** Local tangent-plane anchor. Keeps the filter working in flat metres. */
  private anchorLat: number;
  private anchorLon: number;
  private mPerDegLat: number;
  private mPerDegLon: number;

  private readonly east = new CvKalman1D(0.5);
  private readonly north = new CvKalman1D(0.5);
  /** Vertical motion is far less noisy and far less manoeuvrable. */
  private readonly up = new CvKalman1D(0.15);

  /** Epoch ms the filters are currently propagated to. */
  private filterTime: number;
  /** Epoch ms of the last accepted measurement. */
  private lastFixTime: number;

  private smoothedHeading: number;
  private smoothedRoll = 0;
  private smoothedPitch = 0;

  /**
   * Correction still being absorbed, in the local frame. See `CORRECTION_TAU`.
   *
   * Added to the filter's answer and decayed every rendered frame, so it is a
   * property of the picture rather than of the estimate. `sampleAt` with no
   * smoothing — the path tests and anything asking "where is it really" — sees
   * straight through it.
   */
  private offsetE = 0;
  private offsetN = 0;
  private offsetU = 0;

  /** The last position actually drawn, and when. Null until the first frame. */
  private rendered: { atMs: number; e: number; n: number; u: number } | null = null;

  private readonly trail: TrailPoint[] = [];

  latest: AircraftState;
  /** Fixes the outlier gate threw away — surfaced in the diagnostics panel. */
  rejectedFixes = 0;

  constructor(first: AircraftState) {
    this.hex = first.hex;
    this.latest = first;

    this.anchorLat = first.lat;
    this.anchorLon = first.lon;
    const per = metresPerDegree(first.lat);
    this.mPerDegLat = per.lat;
    this.mPerDegLon = per.lon;

    this.filterTime = first.fixTime;
    this.lastFixTime = first.fixTime;

    const vel = this.velocityOf(first);
    this.east.reset(0, vel.ve, positionVariance(first), velocityVariance(first));
    this.north.reset(0, vel.vn, positionVariance(first), velocityVariance(first));
    this.up.reset(
      this.altitudeOf(first) * FEET_TO_METRES,
      (first.geomRateFpm ?? first.baroRateFpm ?? 0) * FPM_TO_MPS,
      100,
      4,
    );

    this.smoothedHeading = first.headingDeg ?? first.trackDeg ?? 0;
    this.pushTrail(first);
  }

  private altitudeOf(s: AircraftState): number {
    // Geometric altitude is height above the ellipsoid, which is what the
    // terrain is drawn in. Barometric is pressure altitude and can differ by
    // hundreds of feet — enough to bury the camera in a hillside.
    return s.altGeomFt ?? s.altBaroFt ?? 0;
  }

  private velocityOf(s: AircraftState): { ve: number; vn: number } {
    const gs = (s.groundSpeedKt ?? 0) * KNOTS_TO_MPS;
    const trk = (s.trackDeg ?? s.headingDeg ?? 0) * DEG2RAD;
    return { ve: gs * Math.sin(trk), vn: gs * Math.cos(trk) };
  }

  private pushTrail(s: AircraftState): void {
    const point: TrailPoint = {
      lat: s.lat,
      lon: s.lon,
      altFt: this.altitudeOf(s),
      t: s.fixTime,
    };
    const last = this.trail[this.trail.length - 1];
    // Drop near-duplicates: a parked aircraft would otherwise fill the buffer.
    if (last && haversineMetres(last.lat, last.lon, point.lat, point.lon) < 30) return;

    this.trail.push(point);
    if (this.trail.length > TRAIL_CAPACITY) this.trail.shift();
  }

  /** Re-centre the tangent plane, preserving the current filter estimate. */
  private reanchor(lat: number, lon: number): void {
    const e = this.east.x;
    const n = this.north.x;
    const curLat = this.anchorLat + n / this.mPerDegLat;
    const curLon = this.anchorLon + e / this.mPerDegLon;

    this.anchorLat = lat;
    this.anchorLon = lon;
    const per = metresPerDegree(lat);
    this.mPerDegLat = per.lat;
    this.mPerDegLon = per.lon;

    // Shortest way round, as in `toLocal`. A raw subtraction reads the 0.7°
    // step across the antimeridian as 360° and throws the filter estimate
    // 40 000 km east, which is the whole track teleporting mid-Pacific.
    this.east.x = angleDeltaDeg(lon, curLon) * this.mPerDegLon;
    this.north.x = (curLat - lat) * this.mPerDegLat;
  }

  private toLocal(lat: number, lon: number): { e: number; n: number } {
    return {
      e: angleDeltaDeg(this.anchorLon, lon) * this.mPerDegLon,
      n: (lat - this.anchorLat) * this.mPerDegLat,
    };
  }

  /** Fold in a new report. Out-of-order and duplicate fixes are ignored. */
  update(s: AircraftState): void {
    if (s.fixTime <= this.lastFixTime) {
      // Same fix re-served by the feed: refresh the record, skip the filter.
      this.latest = s;
      return;
    }

    const dt = (s.fixTime - this.filterTime) / 1000;
    if (dt > 0) {
      this.east.predict(dt);
      this.north.predict(dt);
      this.up.predict(dt);
      this.filterTime = s.fixTime;
    }

    const local = this.toLocal(s.lat, s.lon);
    const posVar = positionVariance(s);

    // Reject physically impossible jumps rather than chasing them.
    if (
      this.east.ready &&
      (this.east.gate(local.e, posVar) > OUTLIER_GATE ||
        this.north.gate(local.n, posVar) > OUTLIER_GATE)
    ) {
      this.rejectedFixes++;
      // Two rejections in a row means the aircraft really did move and our
      // estimate is the wrong one — re-seed instead of staying stuck.
      if (this.rejectedFixes < 2) return;
      this.east.reset(local.e, 0, posVar);
      this.north.reset(local.n, 0, posVar);
    }
    this.rejectedFixes = 0;

    this.east.updatePosition(local.e, posVar);
    this.north.updatePosition(local.n, posVar);

    if (s.groundSpeedKt !== null && (s.trackDeg !== null || s.headingDeg !== null)) {
      const vel = this.velocityOf(s);
      const velVar = velocityVariance(s);
      this.east.updateVelocity(vel.ve, velVar);
      this.north.updateVelocity(vel.vn, velVar);
    }

    const altM = this.altitudeOf(s) * FEET_TO_METRES;
    this.up.updatePosition(altM, s.altGeomFt !== null ? 25 : 400);
    const rate = s.geomRateFpm ?? s.baroRateFpm;
    if (rate !== null) this.up.updateVelocity(rate * FPM_TO_MPS, 1);

    this.latest = s;
    this.lastFixTime = s.fixTime;
    this.pushTrail(s);
    this.absorbCorrection();

    if (Math.abs(this.east.x) > REANCHOR_DISTANCE_M || Math.abs(this.north.x) > REANCHOR_DISTANCE_M) {
      this.reanchor(s.lat, s.lon);
    }
  }

  /**
   * Hold the drawn position still across a filter correction.
   *
   * Called once the measurement has been folded in. The offset is set so that
   * re-evaluating the *new* filter at the moment of the last drawn frame
   * reproduces exactly what was drawn then; `sampleAt` decays it from there.
   */
  private absorbCorrection(): void {
    const last = this.rendered;
    if (last === null) return;

    const dt = clamp((last.atMs - this.filterTime) / 1000, 0, MAX_EXTRAPOLATION_SEC);
    const e = last.e - this.east.peek(dt);
    const n = last.n - this.north.peek(dt);
    const u = last.u - this.up.peek(dt);

    if (Math.hypot(e, n, u) > MAX_ABSORBED_M) {
      this.offsetE = 0;
      this.offsetN = 0;
      this.offsetU = 0;
      return;
    }
    this.offsetE = e;
    this.offsetN = n;
    this.offsetU = u;
  }

  /**
   * Bank angle. Preferred source is the transponder; otherwise it is inferred
   * from the coordinated-turn relation `tan(bank) = omega * V / g`, which is
   * what a pilot is actually doing in a steady turn.
   */
  private targetRoll(turnRateDegSec: number, groundSpeedMs: number): number {
    const measured = this.latest.rollDeg;
    if (measured !== null) return clamp(measured, -67, 67);

    const omega = turnRateDegSec * DEG2RAD;
    if (Math.abs(omega) < 1e-4 || groundSpeedMs < 20) return 0;
    return clamp(Math.atan2(omega * groundSpeedMs, G) * RAD2DEG, -35, 35);
  }

  /**
   * Evaluate the aircraft at `now`, extrapolating from the filter without
   * mutating it, so repeated calls in one frame are consistent and free.
   */
  sampleAt(now: number, smoothingDt = 0): SampledAircraft {
    const ageSec = (now - this.lastFixTime) / 1000;
    // Past the cap, freeze rather than invent a trajectory.
    const dt = clamp((now - this.filterTime) / 1000, 0, MAX_EXTRAPOLATION_SEC);

    // Decay first, so the offset the caller sees is the one for *this* frame
    // rather than the previous one's.
    if (smoothingDt > 0) {
      const remaining = Math.exp(-smoothingDt / CORRECTION_TAU);
      this.offsetE *= remaining;
      this.offsetN *= remaining;
      this.offsetU *= remaining;
    }

    const e = this.east.peek(dt) + this.offsetE;
    const n = this.north.peek(dt) + this.offsetN;
    const altM = this.up.peek(dt) + this.offsetU;

    if (smoothingDt > 0) this.rendered = { atMs: now, e, n, u: altM };

    const lat = clamp(this.anchorLat + n / this.mPerDegLat, -90, 90);
    const lon = wrapLongitude(this.anchorLon + e / this.mPerDegLon);

    const ve = this.east.v;
    const vn = this.north.v;
    const groundSpeedMs = Math.hypot(ve, vn);
    const trackDeg = groundSpeedMs > 0.5
      ? wrapHeading(Math.atan2(ve, vn) * RAD2DEG)
      : this.latest.trackDeg ?? this.smoothedHeading;

    const turnRate = this.latest.trackRateDegSec ?? 0;
    const targetHeading = this.latest.headingDeg ?? trackDeg;
    const targetRoll = this.targetRoll(turnRate, groundSpeedMs);

    // Climb gradient -> pitch. Not true pitch (which needs angle of attack),
    // but it is the right sign and magnitude and it reads correctly.
    const targetPitch =
      groundSpeedMs > 5
        ? clamp(Math.atan2(this.up.v, groundSpeedMs) * RAD2DEG, -20, 25)
        : 0;

    if (smoothingDt > 0) {
      // Exponential smoothing with a time constant, so the result does not
      // depend on frame rate. Attitude is cosmetic and must never jitter.
      const k = 1 - Math.exp(-smoothingDt / 0.35);
      this.smoothedHeading = wrapHeading(
        this.smoothedHeading + angleDeltaDeg(this.smoothedHeading, targetHeading) * k,
      );
      this.smoothedRoll += (targetRoll - this.smoothedRoll) * k;
      this.smoothedPitch += (targetPitch - this.smoothedPitch) * k;
    } else {
      this.smoothedHeading = targetHeading;
      this.smoothedRoll = targetRoll;
      this.smoothedPitch = targetPitch;
    }

    return {
      hex: this.hex,
      lat,
      lon,
      altFt: altM * METRES_TO_FEET,
      trackDeg,
      headingDeg: this.smoothedHeading,
      rollDeg: this.smoothedRoll,
      pitchDeg: this.smoothedPitch,
      groundSpeedKt: groundSpeedMs * MPS_TO_KNOTS,
      verticalRateFpm: this.up.v / FPM_TO_MPS,
      ageSec,
      stale: ageSec > STALE_AFTER_SEC,
      uncertaintyM: Math.sqrt(Math.max(this.east.variance, this.north.variance)),
      latest: this.latest,
    };
  }

  /** Past fixes, oldest first. Shared, not copied — treat as read-only. */
  get trailPoints(): readonly TrailPoint[] {
    return this.trail;
  }

  get lastSeenMs(): number {
    return this.lastFixTime;
  }
}
