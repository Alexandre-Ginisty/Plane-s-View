/**
 * The connection notices, which had become noise.
 *
 * Reported from an ordinary stable home connection: "perte et regain de
 * connexion s'affichent souvent". Two separate causes, and only the second is
 * in this file — the grade itself was flapping across a knife-edge boundary
 * (pinned in `net/quality/monitor.test.ts`), and on top of that *every* change
 * fired a toast, so even a genuine two-second dip produced a pair of them.
 *
 * What is tested here is the policy: which changes deserve to interrupt
 * someone. The supervisor around it is wiring to `window`, a singleton monitor
 * and a Svelte store, and none of that is what was wrong.
 */

import { describe, expect, it } from 'vitest';

import { AnnouncementPolicy } from './connection';

/** Longer than the hold, so a pending change resolves. */
const PAST_HOLD_SEC = 13;

/** Settle the policy on a healthy link, the way a real session starts. */
function healthy(): AnnouncementPolicy {
  const policy = new AnnouncementPolicy();
  policy.observe('good');
  expect(policy.tick(PAST_HOLD_SEC)).toBeNull();
  return policy;
}

describe('AnnouncementPolicy', () => {
  it('says nothing at all about a link that starts and stays good', () => {
    const policy = new AnnouncementPolicy();
    expect(policy.observe('good')).toBeNull();
    expect(policy.tick(PAST_HOLD_SEC)).toBeNull();
    expect(policy.observe('good')).toBeNull();
    expect(policy.tick(PAST_HOLD_SEC)).toBeNull();
  });

  it('never mentions a dip that recovers before the hold expires', () => {
    // The reported symptom, reduced to its smallest form. The link drops for
    // four seconds and comes back; the user should not learn about it.
    const policy = healthy();

    expect(policy.observe('slow')).toBeNull();
    expect(policy.tick(4)).toBeNull();
    expect(policy.observe('good')).toBeNull();
    expect(policy.tick(PAST_HOLD_SEC)).toBeNull();

    expect(policy.lastAnnounced).toBe('good');
  });

  it('announces a degradation that actually persists', () => {
    const policy = healthy();

    expect(policy.observe('slow')).toBeNull();
    expect(policy.tick(6)).toBeNull();
    expect(policy.tick(PAST_HOLD_SEC)).toBe('slow');
  });

  it('does not restart the clock on every emission of the same grade', () => {
    // The monitor emits on each sample, so a naive implementation resets the
    // hold sixty times a second and never announces anything.
    const policy = healthy();

    policy.observe('slow');
    let fired: string | null = null;
    for (let second = 1; second <= 30 && fired === null; second++) {
      policy.observe('slow');
      fired = policy.tick(1);
      if (fired !== null) expect(second).toBeGreaterThanOrEqual(12);
    }
    expect(fired).toBe('slow');
  });

  it('only says "recovered" when it said something was wrong', () => {
    const policy = healthy();

    policy.observe('slow');
    expect(policy.tick(PAST_HOLD_SEC)).toBe('slow');

    policy.observe('good');
    expect(policy.tick(PAST_HOLD_SEC)).toBe('good');
  });

  it('stays quiet climbing from good to fast', () => {
    // Nobody needs to be told their connection is fine, and this fired every
    // time a train left a tunnel.
    const policy = healthy();

    policy.observe('fast');
    expect(policy.tick(PAST_HOLD_SEC)).toBeNull();
  });

  it('reports going offline at once, without waiting out the hold', () => {
    // The browser has already told us, and the user is about to notice. A
    // twelve-second delay here would be the app pretending not to know.
    const policy = healthy();
    expect(policy.observe('offline')).toBe('offline');
  });

  it('drops a pending announcement when the link returns to what was announced', () => {
    const policy = healthy();

    policy.observe('poor');
    policy.tick(5);
    expect(policy.observe('good')).toBeNull();
    // The pending `poor` must be gone, not merely outranked.
    expect(policy.tick(PAST_HOLD_SEC)).toBeNull();
  });

  it('announces the grade the link settled on, not the one it passed through', () => {
    // A link collapsing good -> slow -> poor inside the hold should produce
    // one notice describing where it ended up, not a running commentary.
    const policy = healthy();

    policy.observe('slow');
    policy.tick(3);
    policy.observe('poor');
    expect(policy.tick(PAST_HOLD_SEC)).toBe('poor');
    expect(policy.lastAnnounced).toBe('poor');
  });
});
