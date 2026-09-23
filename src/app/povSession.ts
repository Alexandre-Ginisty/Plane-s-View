/**
 * Cockpit signal-loss policy.
 *
 * One question, asked every frame: the aircraft we are riding is not in this
 * snapshot — do we follow, wait, or give up?
 *
 * It lives in its own module because it is the single rule the whole feature
 * turns on, it is not reachable from a test while it is buried in a frame
 * loop, and both of its failure modes are bad in opposite directions. Ejecting
 * too eagerly throws the user out of the cockpit over one dropped poll; never
 * ejecting strands them inside a frozen view of an aircraft that landed
 * twenty minutes ago.
 */

import type { SampledAircraft } from '@/state/traffic';

/**
 * How long the followed aircraft may be missing before POV gives up, seconds.
 *
 * The old code ejected on the *first* frame the aircraft was absent from the
 * sampled set — which is one dropped poll, one provider failover, one tab
 * un-hiding before the first snapshot lands. The aircraft is being tracked by
 * a Kalman filter that extrapolates happily across a gap, and `maybeFollow`
 * is already re-requesting it by hex every few seconds, so the right answer to
 * a gap is to hold the cockpit steady and wait, not to throw the user out of
 * it. This is long enough to ride out a provider failover and short enough
 * that an aircraft which really has landed does not strand the view.
 */
const POV_SIGNAL_LOSS_GRACE_SEC = 20;

/** Warn (once) after this much silence, so the freeze is explained. */
const POV_SIGNAL_LOSS_WARN_SEC = 5;

/**
 * How old the followed aircraft's last real report may be and still count as
 * contact, seconds.
 *
 * Presence in the sampled set is not contact. The orchestrator deliberately
 * exempts the followed aircraft from pruning so the cockpit can coast across a
 * dropped poll — which means it stays in the set indefinitely, and a naive
 * "is it in the snapshot?" test can never be false. That made `exit`
 * unreachable and stranded the user in a motionless cockpit after the aircraft
 * landed. `ageSec` is what separates a fresh report from an extrapolation that
 * has been running on its own for a quarter of an hour.
 *
 * Comfortably above the poll interval, including the backed-off interval a
 * weak link settles on, so ordinary cadence never reads as silence.
 */
const POV_FIX_FRESH_SEC = 8;

/** What the POV loop does about the followed aircraft this frame. */
export type PovSignalAction = 'follow' | 'hold' | 'exit';

/**
 * Decide whether the cockpit view follows, waits, or gives up.
 *
 * Split out from the frame loop because it is the one rule the whole feature
 * turns on and the frame loop is not reachable from a test. `exit` has to stay
 * reachable: an aircraft that has genuinely landed must not strand the user
 * inside a frozen view for ever, which is the failure mode a naive "just never
 * eject" fix would introduce.
 */
export function povSignalAction(
  hasFix: boolean,
  hasHeldFix: boolean,
  silenceSec: number,
  graceSec = POV_SIGNAL_LOSS_GRACE_SEC,
): PovSignalAction {
  if (hasFix) return 'follow';
  // Nothing to show at all — there is no view to hold open.
  if (!hasHeldFix) return 'exit';
  return silenceSec > graceSec ? 'exit' : 'hold';
}

/** What one frame of the cockpit view should do. */
export interface PovStep {
  action: PovSignalAction;
  /** The fix to fly — live if there is one, otherwise the last good one. */
  flying: SampledAircraft | null;
  /** True on the single frame the hold should be announced to the user. */
  warn: boolean;
}

/**
 * The held-fix state behind `povSignalAction`.
 *
 * Small enough to have lived in the orchestrator as three loose fields, and
 * that is exactly how it got broken: `exitPov` cleared two of them and
 * `enterPov` seeded a third, so a path that missed one left the next flight
 * starting with a stale silence counter. Keeping the three together with the
 * only three operations allowed on them removes that class of bug entirely.
 */
export class PovSession {
  private held: SampledAircraft | null = null;
  private silenceSec = 0;
  private warned = false;

  /** Seconds since the last live fix. 0 while the feed is healthy. */
  get silence(): number {
    return this.silenceSec;
  }

  /** Seed the hold when stepping into an aircraft. */
  enter(sample: SampledAircraft): void {
    this.held = sample;
    this.silenceSec = 0;
    this.warned = false;
  }

  reset(): void {
    this.held = null;
    this.silenceSec = 0;
    this.warned = false;
  }

  step(selected: SampledAircraft | null, dt: number): PovStep {
    // Contact, not presence — see `POV_FIX_FRESH_SEC`.
    const live = selected && selected.ageSec <= POV_FIX_FRESH_SEC ? selected : null;

    if (live) {
      this.held = live;
      this.silenceSec = 0;
      this.warned = false;
    } else {
      this.silenceSec += dt;
    }

    // Fly the extrapolated sample even when it is no longer a live fix: the
    // filter keeps the camera moving smoothly through the gap, where the last
    // held fix would freeze it. Only the give-up timer cares about freshness.
    const flying = selected ?? this.held;
    const action = povSignalAction(live !== null, flying !== null, this.silenceSec);

    // The warning fires once per gap, not once per frame, and only after the
    // gap is long enough to be noticeable. Below that threshold the Kalman
    // filter covers it and there is nothing for the user to be told about.
    const warn = !live && !this.warned && this.silenceSec > POV_SIGNAL_LOSS_WARN_SEC;
    if (warn) this.warned = true;

    return { action, flying, warn };
  }
}
