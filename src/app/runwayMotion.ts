/**
 * The last minute of a landing and the first of a takeoff, when the feed goes
 * quiet.
 *
 * ADS-B is received from the air: the lower an aircraft is, the fewer
 * receivers hear it, and on the runway most of them hear nothing at all. So
 * the moment the cockpit view exists for — the flare, the touchdown, the roll
 * — is exactly the moment the reports stop. Left to the tracker, the aircraft
 * coasted on at its last descent rate, froze twenty seconds later somewhere
 * short of the runway, and the view gave up on it: "lost contact". A takeoff
 * did the same in reverse — frozen on the runway, then a jump into the air.
 *
 * When that happens here the aircraft is flown the rest of the way by the
 * book, from exactly where and how it was last drawn: down the glide path at
 * its approach speed, a flare at fifty feet, the mains on, the nose lowered,
 * braking to taxi speed. A takeoff accelerates down the runway, rotates and
 * climbs away. It is a reconstruction of what certainly happened, not a
 * recording, and as soon as a real report arrives the view blends back onto
 * it over a few seconds.
 *
 * A landing that runs to taxi speed with nothing heard is finished: the
 * caller ends the flight there, on the ground, rather than calling it a loss.
 */

import {
  DEG2RAD,
  FPM_TO_MPS,
  KNOTS_TO_MPS,
  METRES_TO_FEET,
  MPS_TO_KNOTS,
  RAD2DEG,
  angleDeltaDeg,
  metresPerDegree,
  wrapHeading,
  wrapLongitude,
} from '@/core/math/geo';
import type { FlightPhase } from '@/state/phase';
import type { SampledAircraft } from '@/state/traffic';

export type RunwayAct = 'landing' | 'takeoff';

type Stage = 'glide' | 'flare' | 'roll' | 'taxi' | 'takeoffRoll' | 'rotate' | 'climb';

export interface RunwayStep {
  /** What to fly this frame: the tracker's sample, the reconstruction, or a blend. */
  flying: SampledAircraft;
  /** The act being reconstructed, or null while the feed is followed. */
  act: RunwayAct | null;
  /** True once a reconstructed landing has slowed to taxi and settled: the flight is over. */
  landed: boolean;
}

/** Quiet longer than the feed's normal cadence, seconds: high up and down low. */
const QUIET_S = 5;
const QUIET_LOW_S = 2.5;
/** Below this height the reconstruction takes over a landing sooner, feet. */
const LOW_FT = 400;
/** A landing is reconstructed from below this height on an approach, feet above ground. */
const LANDING_FROM_FT = 3_000;

const GLIDE_DEG = 3;
const FLARE_M = 15;
/** Sink rate the flare settles to, m/s (about 120 ft/min: a firm, ordinary arrival). */
const FLARE_SINK = 0.6;
const TAXI_MPS = 8;
/** How long the aircraft taxis on before the flight is called over, seconds. */
const TAXI_HOLD_S = 7;
/** How long a reconstructed climb is trusted with nothing heard, seconds. */
const CLIMB_MAX_S = 90;
/** Blend back onto a returning feed over this, seconds. */
const BLEND_S = 3;

/** A first-order step towards `target`, exact for any `dt`. */
const approach = (value: number, target: number, tau: number, dt: number): number =>
  value + (target - value) * (1 - Math.exp(-dt / tau));
const smoothstep = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Rotation speed by emitter category, m/s. */
function rotationSpeed(category: string | null | undefined): number {
  if (category === 'A1') return 33; // light single: 65 kt
  if (category === 'A2') return 55; // regional, turboprop: 105 kt
  return 77; // jets: 150 kt
}

interface Synth {
  act: RunwayAct;
  stage: Stage;
  /** Seconds in the current stage. */
  t: number;
  lat: number;
  lon: number;
  altM: number;
  gs: number;
  vs: number;
  track: number;
  heading: number;
  pitch: number;
  roll: number;
  onGround: boolean;
  vr: number;
  /** Where the ground was last known, metres; NaN until it is. */
  ground: number;
}

export class RunwayMotion {
  private synth: Synth | null = null;
  /** Seconds into blending back onto the feed, or null while not blending. */
  private blend: number | null = null;
  /** The newest fix time seen when the reconstruction began: anything newer is the feed back. */
  private silentSince = 0;
  private lastDrawn: SampledAircraft | null = null;
  private hex: string | null = null;

  get active(): RunwayAct | null {
    return this.synth?.act ?? null;
  }

  reset(): void {
    this.synth = null;
    this.blend = null;
    this.lastDrawn = null;
    this.hex = null;
  }

  /**
   * One frame. `sample` is the tracker's (extrapolated) sample, `phase` the
   * committed phase, `aglFt` the height above the terrain under it (NaN when
   * unknown), `groundAt` the terrain height anywhere (NaN when unknown) and
   * `clearanceM` how high the airframe's reference point sits on its wheels.
   */
  step(
    sample: SampledAircraft,
    phase: FlightPhase | null,
    aglFt: number,
    groundAt: (lat: number, lon: number) => number,
    clearanceM: number,
    dt: number,
  ): RunwayStep {
    if (sample.hex !== this.hex) {
      this.reset();
      this.hex = sample.hex;
    }

    const synth = this.synth;
    if (!synth) {
      const act = this.wants(sample, phase, aglFt);
      if (!act || !this.lastDrawn) return this.pass(sample);
      this.synth = this.begin(act, this.lastDrawn, sample, groundAt, clearanceM);
      this.silentSince = sample.latest.fixTime;
      this.blend = null;
    }

    const s = this.synth!;
    this.advance(s, groundAt, clearanceM, dt);

    // The feed is back: blend onto it, then let go.
    const fresh = sample.latest.fixTime > this.silentSince && sample.ageSec < QUIET_LOW_S;
    if (fresh) this.blend = (this.blend ?? 0) + dt;
    if (this.blend !== null && this.blend >= BLEND_S) {
      this.synth = null;
      this.blend = null;
      return this.pass(sample);
    }

    const drawn = this.render(s, sample);
    const out = this.blend === null ? drawn : mixSamples(drawn, sample, smoothstep(this.blend / BLEND_S));
    this.lastDrawn = out;

    if (s.act === 'takeoff' && s.stage === 'climb' && s.t > CLIMB_MAX_S) {
      // Nothing heard for a minute and a half of climb: stop inventing it.
      this.synth = null;
      return { flying: out, act: null, landed: false };
    }
    return { flying: out, act: s.act, landed: s.stage === 'taxi' && s.t > TAXI_HOLD_S && this.blend === null };
  }

  private pass(sample: SampledAircraft): RunwayStep {
    this.lastDrawn = sample;
    return { flying: sample, act: null, landed: false };
  }

  /** Has the feed gone quiet at a moment worth reconstructing? */
  private wants(sample: SampledAircraft, phase: FlightPhase | null, aglFt: number): RunwayAct | null {
    const onGround = sample.latest.onGround === true;
    const low = onGround || (Number.isFinite(aglFt) && aglFt < LOW_FT);
    if (sample.ageSec < (low ? QUIET_LOW_S : QUIET_S)) return null;
    if (phase === 'rollout') return 'landing';
    if (phase === 'final' && !onGround) return 'landing';
    if (phase === 'approach' && !onGround && Number.isFinite(aglFt) && aglFt < LANDING_FROM_FT) return 'landing';
    if (phase === 'takeoff' && onGround && sample.groundSpeedKt >= 40) return 'takeoff';
    return null;
  }

  private begin(
    act: RunwayAct,
    from: SampledAircraft,
    sample: SampledAircraft,
    groundAt: (lat: number, lon: number) => number,
    clearanceM: number,
  ): Synth {
    const onGround = from.latest.onGround === true;
    const altM = from.altFt / METRES_TO_FEET;
    const ground = groundAt(from.lat, from.lon);
    let stage: Stage;
    if (act === 'takeoff') stage = 'takeoffRoll';
    else if (onGround) stage = from.groundSpeedKt * KNOTS_TO_MPS > TAXI_MPS * 1.2 ? 'roll' : 'taxi';
    else stage = Number.isFinite(ground) && altM - ground - clearanceM < FLARE_M ? 'flare' : 'glide';
    const gs = Math.max(from.groundSpeedKt * KNOTS_TO_MPS, act === 'landing' && !onGround ? 50 : 0);
    return {
      act,
      stage,
      t: 0,
      lat: from.lat,
      lon: from.lon,
      altM,
      gs,
      vs: from.verticalRateFpm * FPM_TO_MPS,
      track: from.trackDeg,
      heading: from.headingDeg,
      pitch: from.pitchDeg,
      roll: from.rollDeg,
      onGround,
      vr: Math.max(rotationSpeed(sample.latest.category), gs + 5),
      ground,
    };
  }

  private advance(s: Synth, groundAt: (lat: number, lon: number) => number, clearanceM: number, dt: number): void {
    if (dt <= 0) return;
    s.t += dt;
    const sampled = groundAt(s.lat, s.lon);
    if (Number.isFinite(sampled)) s.ground = sampled;
    // Without any ground at all, the runway is taken to be where the descent would end.
    const ground = Number.isFinite(s.ground) ? s.ground : s.altM - 300;
    const floor = ground + clearanceM;
    const height = s.altM - floor;
    const next = (stage: Stage): void => {
      s.stage = stage;
      s.t = 0;
    };

    switch (s.stage) {
      case 'glide': {
        // Down the glide path at the approach speed, wings level.
        const path = -s.gs * Math.tan(GLIDE_DEG * DEG2RAD);
        s.vs = approach(s.vs, path, 2, dt);
        s.roll = approach(s.roll, 0, 1.5, dt);
        s.pitch = approach(s.pitch, Math.atan2(s.vs, s.gs) * RAD2DEG + 2, 2, dt);
        if (height < FLARE_M) next('flare');
        break;
      }
      case 'flare': {
        // The nose comes up and the sink rate bleeds away; so does a little speed.
        s.vs = approach(s.vs, -FLARE_SINK, 1.4, dt);
        s.pitch = approach(s.pitch, 4, 1.2, dt);
        s.roll = approach(s.roll, 0, 0.8, dt);
        s.gs = Math.max(30, s.gs - 0.7 * dt);
        if (height <= 0.05) {
          s.onGround = true;
          s.vs = 0;
          s.altM = floor;
          next('roll');
        }
        break;
      }
      case 'roll': {
        // Mains on; the nose is flown down; spoilers, reversers, then brakes.
        s.vs = 0;
        s.pitch = approach(s.pitch, s.t < 1.5 ? 3 : 0, 1.1, dt);
        s.roll = approach(s.roll, 0, 0.5, dt);
        // The crab comes out as the wheels take the side load.
        s.heading = wrapHeading(s.heading + angleDeltaDeg(s.heading, s.track) * (1 - Math.exp(-dt / 1.2)));
        const decel = s.t < 1.5 ? 0.8 : s.gs > 30 ? 2.2 : 1.1;
        s.gs = Math.max(TAXI_MPS, s.gs - decel * dt);
        if (s.gs <= TAXI_MPS + 0.01) next('taxi');
        break;
      }
      case 'taxi': {
        s.vs = 0;
        s.pitch = approach(s.pitch, 0, 1, dt);
        s.gs = approach(s.gs, TAXI_MPS * 0.8, 3, dt);
        break;
      }
      case 'takeoffRoll': {
        s.vs = 0;
        s.pitch = approach(s.pitch, 0, 1, dt);
        s.roll = 0;
        s.heading = wrapHeading(s.heading + angleDeltaDeg(s.heading, s.track) * (1 - Math.exp(-dt / 1.5)));
        // Full power: two metres a second squared and a little less as speed builds.
        s.gs += (2.2 - s.gs * 0.006) * dt;
        if (s.gs >= s.vr) next('rotate');
        break;
      }
      case 'rotate': {
        // Three degrees a second to the takeoff attitude; airborne at about six.
        s.pitch = Math.min(9, s.pitch + 3 * dt);
        s.gs += 1.4 * dt;
        if (s.pitch >= 6 && s.onGround) {
          s.onGround = false;
          next('climb');
        }
        break;
      }
      case 'climb': {
        s.vs = approach(s.vs, Math.min(12, s.gs * 0.12), 2.5, dt);
        s.pitch = approach(s.pitch, s.t < 4 ? 9 : 12, 3, dt);
        s.gs += Math.max(0, 1.0 - s.t * 0.01) * dt;
        break;
      }
    }

    if (!s.onGround) s.altM += s.vs * dt;
    else s.altM = floor;
    const per = metresPerDegree(s.lat);
    const along = s.gs * dt;
    s.lat += (along * Math.cos(s.track * DEG2RAD)) / per.lat;
    s.lon = wrapLongitude(s.lon + (along * Math.sin(s.track * DEG2RAD)) / per.lon);
  }

  private render(s: Synth, sample: SampledAircraft): SampledAircraft {
    return {
      ...sample,
      lat: s.lat,
      lon: s.lon,
      altFt: s.altM * METRES_TO_FEET,
      trackDeg: s.track,
      headingDeg: s.heading,
      rollDeg: s.roll,
      pitchDeg: s.pitch,
      groundSpeedKt: s.gs * MPS_TO_KNOTS,
      verticalRateFpm: s.vs / FPM_TO_MPS,
      stale: false,
      latest: { ...sample.latest, onGround: s.onGround },
    };
  }
}

/** `a` carried towards `b` by `k` (0 … 1), angles the short way round. */
function mixSamples(a: SampledAircraft, b: SampledAircraft, k: number): SampledAircraft {
  const lerp = (x: number, y: number): number => x + (y - x) * k;
  const angle = (x: number, y: number): number => wrapHeading(x + angleDeltaDeg(x, y) * k);
  return {
    ...b,
    lat: lerp(a.lat, b.lat),
    lon: wrapLongitude(a.lon + angleDeltaDeg(a.lon, b.lon) * k),
    altFt: lerp(a.altFt, b.altFt),
    trackDeg: angle(a.trackDeg, b.trackDeg),
    headingDeg: angle(a.headingDeg, b.headingDeg),
    rollDeg: lerp(a.rollDeg, b.rollDeg),
    pitchDeg: lerp(a.pitchDeg, b.pitchDeg),
    groundSpeedKt: lerp(a.groundSpeedKt, b.groundSpeedKt),
    verticalRateFpm: lerp(a.verticalRateFpm, b.verticalRateFpm),
    stale: false,
    // On the ground once either says so: the wheels do not leave the runway mid-blend.
    latest: { ...b.latest, onGround: k < 0.5 ? a.latest.onGround : b.latest.onGround },
  };
}
