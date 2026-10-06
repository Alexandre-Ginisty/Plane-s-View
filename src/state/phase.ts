/**
 * Phase of flight: parked, taxiing, taking off, climbing … on final, rolling
 * out.
 *
 * `regime.ts` answers "how hard are the engines working"; this answers "what
 * is the aircraft about to do", which is what the cockpit view needs to make
 * a takeoff or a landing an event rather than one more minute of flight. The
 * HUD names the phase, the camera director picks a view for it, and the map
 * can go looking for aircraft in one.
 *
 * ## What it is built from
 *
 * ADS-B gives the on-ground flag, ground speed, vertical rate and barometric
 * altitude. Height above the *ground* — the number that separates a final
 * approach from a descent — comes from the terrain under the aircraft when the
 * caller has it, and falls back to altitude when it does not, which is right
 * at most airports and a few thousand feet wrong at Denver or La Paz.
 *
 * ## Why a tracker and not just a function
 *
 * The raw classification flickers: a jet on an ILS levels off for a few
 * seconds, a vertical-rate report jumps, an on-ground flag stutters on the
 * runway. A label that changes every second is noise, and a camera that cuts
 * on every flicker is unwatchable. `PhaseTracker` only commits a new phase
 * once it has held for a moment, and reports liftoff and touchdown — the two
 * instants that matter — exactly once each.
 */

export type FlightPhase =
  | 'parked'
  | 'taxi'
  | 'takeoff'
  | 'departure'
  | 'climb'
  | 'cruise'
  | 'level'
  | 'descent'
  | 'approach'
  | 'final'
  | 'rollout';

/** What each phase is called on screen is in `i18n/en.ts`, under `phase.<name>`. */

/** The phases worth making a moment of. */
export function isTakeoffPhase(p: FlightPhase | null): boolean {
  return p === 'takeoff' || p === 'departure';
}
export function isLandingPhase(p: FlightPhase | null): boolean {
  return p === 'final' || p === 'rollout';
}

export interface PhaseInput {
  onGround: boolean;
  groundSpeedKt: number;
  verticalRateFpm: number;
  /** Height above the terrain, feet. NaN when unknown. */
  aglFt: number;
  /** Altitude, feet — the stand-in when `aglFt` is unknown. */
  altFt: number;
}

/** Below this the aircraft is parked, not taxiing. */
const PARKED_KT = 3;
/** Faster than any taxi: a takeoff or a landing is under way. */
const RUNWAY_KT = 40;
/** Vertical rate that counts as climbing or descending, ft/min. */
const VS_DEADBAND = 300;
/** Heights above ground for the phase boundaries, feet. */
const DEPARTURE_AGL = 1_500;
const FINAL_AGL = 2_500;
const APPROACH_AGL = 10_000;
/** Above this, level flight is cruise rather than a low-level segment. */
const CRUISE_AGL = 10_000;

const AIRBORNE_ARRIVING = new Set<FlightPhase>(['descent', 'approach', 'final', 'rollout']);
const HOLDS_WHEN_LEVEL = new Set<FlightPhase>(['final', 'approach', 'departure', 'climb']);
const ON_GROUND = new Set<FlightPhase>(['parked', 'taxi', 'takeoff', 'rollout']);

/**
 * One sample's phase. `previous` breaks the ties a single sample cannot: a jet
 * at 120 knots on the runway is taking off or landing depending on where it
 * came from.
 */
export function classifyPhase(input: PhaseInput, previous: FlightPhase | null = null): FlightPhase {
  const gs = Math.max(0, input.groundSpeedKt);

  if (input.onGround) {
    if (gs < PARKED_KT) return 'parked';
    if (gs < RUNWAY_KT) return 'taxi';
    return previous && AIRBORNE_ARRIVING.has(previous) ? 'rollout' : 'takeoff';
  }

  const agl = Number.isFinite(input.aglFt) ? input.aglFt : input.altFt;
  const vs = input.verticalRateFpm;

  if (vs >= VS_DEADBAND) return agl < DEPARTURE_AGL ? 'departure' : 'climb';
  if (vs <= -VS_DEADBAND) {
    if (agl < FINAL_AGL) return 'final';
    if (agl < APPROACH_AGL) return 'approach';
    return 'descent';
  }

  // Level. Low down that is usually a step in an approach or a departure, and
  // calling it anything else would flip the label for a few seconds mid-way.
  // The flare is the same case: the sink rate drops to nothing in the last
  // few feet, and that is when "final" matters most.
  if (agl < CRUISE_AGL && previous !== null && HOLDS_WHEN_LEVEL.has(previous)) return previous;
  return agl >= CRUISE_AGL ? 'cruise' : 'level';
}

/** The glide path almost every approach flies, degrees. */
const GLIDE_DEG = 3;
/** Below this the aircraft is in the flare: the touchdown is a second or two away, not a number. */
const FLARE_FT = 50;

/**
 * Seconds until touchdown down a standard 3° glide path from here, or null
 * when that is not a meaningful question (not on an approach, no idea where
 * the ground is).
 *
 * Height and ground speed, not the descent rate. The reported vertical rate
 * is the noisiest number in ADS-B — it swings by a few hundred feet a minute
 * from one report to the next — and dividing the height by it made the
 * countdown jump by twenty seconds at a time. An approach is flown down a
 * fixed path at a near-constant speed, so where the aircraft is on that path
 * says when it arrives far better than how fast it happens to be sinking.
 */
export function secondsToTouchdown(input: PhaseInput): number | null {
  if (input.onGround || input.verticalRateFpm > 200) return null;
  const agl = Number.isFinite(input.aglFt) ? input.aglFt : input.altFt;
  if (!(agl > 0) || agl > FINAL_AGL * 2) return null;
  const speedFtS = input.groundSpeedKt * 1.68781;
  if (speedFtS < 60) return null;
  return agl / (speedFtS * Math.tan((GLIDE_DEG * Math.PI) / 180));
}

/**
 * The touchdown countdown as shown: a clock, not a measurement.
 *
 * Once it has an answer it runs down at one second a second, like a real
 * countdown, and new estimates only steer it — never more than a third of a
 * second per second — so the number on screen always goes down, one tick at a
 * time. A wildly different estimate (a go-around, a level segment, a new
 * aircraft) resets it instead of being chased.
 */
export class TouchdownClock {
  private shown: number | null = null;

  /** The countdown as last updated, seconds, or null when there is none to give. */
  get seconds(): number | null {
    return this.shown;
  }

  update(input: PhaseInput | null, phase: FlightPhase | null, dt: number): number | null {
    const estimate = input && (phase === 'final' || phase === 'approach') ? secondsToTouchdown(input) : null;
    const agl = input ? (Number.isFinite(input.aglFt) ? input.aglFt : input.altFt) : Infinity;
    if (estimate === null || agl < FLARE_FT) {
      // Hold through a brief gap in the estimate, but not past zero.
      if (this.shown !== null && estimate === null && agl >= FLARE_FT && this.shown > dt) {
        this.shown -= dt;
        return this.shown;
      }
      this.shown = null;
      return null;
    }
    if (this.shown === null || Math.abs(estimate - this.shown) > Math.max(25, this.shown * 0.4)) {
      this.shown = estimate;
      return this.shown;
    }
    const steer = (estimate - this.shown) * (1 - Math.exp(-dt / 8));
    const limit = dt / 3;
    this.shown = Math.max(0, this.shown - dt + Math.min(limit, Math.max(-limit, steer)));
    return this.shown;
  }

  reset(): void {
    this.shown = null;
  }
}

export type PhaseEvent = 'liftoff' | 'touchdown';

export interface PhaseUpdate {
  phase: FlightPhase;
  /** Set on the one update where the transition happened. */
  event: PhaseEvent | null;
}

/** How long a new airborne phase must hold before it is believed, seconds. */
const HOLD_S = 2.5;

export class PhaseTracker {
  private committed: FlightPhase | null = null;
  private candidate: FlightPhase | null = null;
  private candidateFor = 0;

  get phase(): FlightPhase | null {
    return this.committed;
  }

  update(input: PhaseInput, dt: number): PhaseUpdate {
    const raw = classifyPhase(input, this.committed);
    const previous = this.committed;

    if (previous === null) {
      this.committed = raw;
      this.candidate = null;
      return { phase: raw, event: null };
    }

    if (raw === previous) {
      this.candidate = null;
      this.candidateFor = 0;
      return { phase: previous, event: null };
    }

    // Leaving or reaching the ground is believed at once: the on-ground flag
    // is the one signal here that is a measurement rather than an inference,
    // and liftoff and touchdown are the moments this exists to catch on time.
    const groundChange = ON_GROUND.has(previous) !== input.onGround;

    if (!groundChange) {
      if (raw !== this.candidate) {
        this.candidate = raw;
        this.candidateFor = 0;
      }
      this.candidateFor += dt;
      if (this.candidateFor < HOLD_S) return { phase: previous, event: null };
    }

    this.committed = raw;
    this.candidate = null;
    this.candidateFor = 0;

    let event: PhaseEvent | null = null;
    if (groundChange && !input.onGround && previous === 'takeoff') event = 'liftoff';
    else if (groundChange && input.onGround && (previous === 'final' || previous === 'approach')) {
      event = 'touchdown';
    }
    return { phase: raw, event };
  }

  reset(): void {
    this.committed = null;
    this.candidate = null;
    this.candidateFor = 0;
  }
}
