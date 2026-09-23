/**
 * POV signal-loss rule.
 *
 * The cockpit view used to leave on the first frame the followed aircraft was
 * missing from the sampled set. One dropped poll, one provider failover, one
 * tab coming back from the background was enough — which is what "sometimes it
 * throws me out of the plane" was. It now coasts on the last fix, and this is
 * the rule that decides for how long.
 */

import { describe, expect, it } from 'vitest';

import { PovSession, povSignalAction } from './povSession';
import type { SampledAircraft } from '@/state/traffic';

describe('povSignalAction', () => {
  it('follows a live fix, whatever the history', () => {
    expect(povSignalAction(true, true, 0)).toBe('follow');
    expect(povSignalAction(true, true, 999)).toBe('follow');
  });

  /** A single missing frame is a feed hiccup, not a lost aircraft. */
  it('holds through a short gap rather than ejecting', () => {
    expect(povSignalAction(false, true, 0.016)).toBe('hold');
    expect(povSignalAction(false, true, 5)).toBe('hold');
    expect(povSignalAction(false, true, 19.9)).toBe('hold');
  });

  /**
   * The hold must expire. An aircraft that has genuinely landed would
   * otherwise strand the user in a frozen cockpit indefinitely — a worse bug
   * than the premature ejection this replaced.
   */
  it('gives up once the gap outlasts the grace period', () => {
    expect(povSignalAction(false, true, 20.1)).toBe('exit');
    expect(povSignalAction(false, true, 600)).toBe('exit');
  });

  it('exits immediately when there is no fix to hold on to', () => {
    expect(povSignalAction(false, false, 0)).toBe('exit');
  });

  it('honours an explicit grace period', () => {
    expect(povSignalAction(false, true, 3, 5)).toBe('hold');
    expect(povSignalAction(false, true, 6, 5)).toBe('exit');
  });

  /** The boundary itself holds; only strictly beyond it does it leave. */
  it('treats the boundary as still within the hold', () => {
    expect(povSignalAction(false, true, 20, 20)).toBe('hold');
  });
});

describe('PovSession', () => {
  /**
   * The smallest thing the session actually reads off a sample.
   *
   * `ageSec` matters: the session distinguishes a fresh report from an
   * extrapolation the filter has been running on its own, so a sample is not
   * automatically contact.
   */
  const fix = (hex: string, ageSec = 0): SampledAircraft =>
    ({ hex, ageSec }) as SampledAircraft;

  it('follows a live fix and reports no silence', () => {
    const session = new PovSession();
    session.enter(fix('abc123'));

    const step = session.step(fix('abc123'), 0.016);
    expect(step.action).toBe('follow');
    expect(step.flying?.hex).toBe('abc123');
    expect(session.silence).toBe(0);
  });

  it('holds the last good fix through a gap', () => {
    const session = new PovSession();
    const held = fix('abc123');
    session.enter(held);

    const step = session.step(null, 3);
    expect(step.action).toBe('hold');
    // The camera keeps flying the last known position rather than freezing on
    // nothing — the terrain keeps streaming and the view stays alive.
    expect(step.flying).toBe(held);
  });

  it('warns once per gap, not once per frame', () => {
    const session = new PovSession();
    session.enter(fix('abc123'));

    const warnings = [];
    for (let i = 0; i < 600; i++) {
      const step = session.step(null, 0.016);
      if (step.warn) warnings.push(i);
      if (step.action === 'exit') break;
    }

    expect(warnings).toHaveLength(1);
  });

  it('warns only after the gap is long enough to be noticed', () => {
    const session = new PovSession();
    session.enter(fix('abc123'));
    // Under the threshold the Kalman filter covers it and there is nothing
    // for the user to be told about.
    expect(session.step(null, 1).warn).toBe(false);
  });

  it('gives up once the grace period is exhausted', () => {
    const session = new PovSession();
    session.enter(fix('abc123'));

    session.step(null, 19);
    expect(session.step(null, 2).action).toBe('exit');
  });

  it('forgets the silence as soon as the aircraft answers again', () => {
    const session = new PovSession();
    session.enter(fix('abc123'));

    session.step(null, 15);
    expect(session.silence).toBeGreaterThan(0);

    session.step(fix('abc123'), 0.016);
    expect(session.silence).toBe(0);

    // And the warning is armed again for the *next* gap, because this is a
    // new loss of signal rather than a continuation of the old one.
    expect(session.step(null, 6).warn).toBe(true);
  });

  it('exits immediately when there was never a fix to hold', () => {
    const session = new PovSession();
    expect(session.step(null, 0.016).action).toBe('exit');
  });

  /**
   * Regression: the cockpit could never be left.
   *
   * The orchestrator exempts the followed aircraft from pruning so the view
   * can coast across a dropped poll, which means the sampled set keeps
   * returning it for ever. A presence test therefore never went false, the
   * silence counter was reset on every frame, and `exit` was unreachable —
   * an aircraft that landed and stopped reporting left the user in a
   * motionless cockpit indefinitely, the exact failure this module exists to
   * prevent.
   */
  it('gives up on a sample the filter is merely extrapolating', () => {
    const session = new PovSession();
    session.enter(fix('abc123'));

    // The aircraft is still in the set every frame — but its last real
    // report keeps getting older, which is what "it landed" looks like.
    let action = session.step(fix('abc123', 2), 1).action;
    expect(action).toBe('follow');

    for (let t = 0; t < 40; t++) action = session.step(fix('abc123', 30 + t), 1).action;
    expect(action).toBe('exit');
  });

  /** A stale sample is still the best thing to fly while we wait. */
  it('keeps flying the extrapolated sample during the hold', () => {
    const session = new PovSession();
    session.enter(fix('abc123'));

    const stale = fix('abc123', 12);
    const step = session.step(stale, 1);
    expect(step.action).toBe('hold');
    expect(step.flying).toBe(stale);
  });

  /** Ordinary poll cadence must never read as silence. */
  it('treats a normal poll interval as contact', () => {
    const session = new PovSession();
    session.enter(fix('abc123'));

    for (let t = 0; t < 60; t++) {
      expect(session.step(fix('abc123', 4), 1).action).toBe('follow');
    }
    expect(session.silence).toBe(0);
  });

  it('starts clean after a reset', () => {
    // `exitPov` resets; a stale silence counter would make the next flight
    // start part-way through a grace period it never entered.
    const session = new PovSession();
    session.enter(fix('abc123'));
    session.step(null, 18);

    session.reset();
    session.enter(fix('def456'));
    expect(session.silence).toBe(0);
    expect(session.step(null, 3).action).toBe('hold');
  });
});
