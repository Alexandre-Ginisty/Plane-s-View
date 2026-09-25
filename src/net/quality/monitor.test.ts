/**
 * The classifier is the piece of this project most likely to be wrong in a way
 * nobody notices: it only misbehaves on connections the developer does not
 * have, and when it does misbehave the symptom is "the app feels slow", which
 * gets blamed on the renderer.
 *
 * So the tests here are mostly about the *decisions*, not the arithmetic: does
 * a failing link degrade immediately, does a recovering one wait before being
 * trusted, does a 404-free but slow link end up somewhere sensible.
 */

import { describe, expect, it } from 'vitest';

import { NetworkMonitor, gradeRank, profileFor, type NetworkGrade } from './index';
import type { NetworkEnvironment } from './environment';

/** A clock and a connectivity flag the test drives directly. */
interface FakeEnv extends NetworkEnvironment {
  time: number;
  online: boolean;
  save: boolean;
}

function fakeEnv(overrides: Partial<NetworkEnvironment> = {}): FakeEnv {
  const env: FakeEnv = {
    time: 0,
    online: true,
    save: false,
    now: (): number => env.time,
    onLine: (): boolean => env.online,
    effectiveType: (): string | null => null,
    saveData: (): boolean => env.save,
    ...overrides,
  };
  return env;
}

/** `n` successful transfers of `bytes` each, `ms` apart and `ms` long. */
function feed(monitor: NetworkMonitor, env: { time: number }, n: number, bytes: number, ms: number): void {
  for (let i = 0; i < n; i++) {
    env.time += ms;
    monitor.record({ ms, bytes, ok: true });
  }
}

const UPGRADE_HOLD_TEST_MS = 7000;

describe('NetworkMonitor', () => {
  it('stays neutral until it has enough samples to judge', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    // Three very fast transfers are not evidence of a fast link — they are
    // three transfers. Committing to 128 parallel requests on this much data
    // is exactly the mistake the module exists to prevent.
    feed(monitor, env, 3, 500_000, 10);
    expect(monitor.profile.grade).toBe('good');
  });

  it('ignores a single slow probe when transfers are landing fine', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    // What actually happened in the browser: the startup probe raced the
    // app's own first burst of tile requests, opened a cold connection, and
    // came back at 5.7 s on a fibre link. Acting on it throttled a healthy
    // connection on the strength of congestion the app had caused itself.
    monitor.setPing(5712);
    expect(monitor.profile.grade).toBe('good');

    feed(monitor, env, 10, 500_000, 20);
    expect(gradeRank(monitor.profile.grade)).toBeGreaterThanOrEqual(gradeRank('good'));
  });

  it('falls back to the probe when nothing has completed at all', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);
    monitor.setPing(80);
    // No transfers yet, so no verdict beyond neutral — but the number is
    // still published, because the diagnostics panel has nothing else.
    expect(monitor.readout().pingMs).toBe(80);
    expect(monitor.profile.grade).toBe('good');
  });

  it('grades a thin link as poor', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    // 10 kB per second: an EDGE connection or a congested train wifi.
    feed(monitor, env, 10, 10_000, 1000);

    expect(monitor.profile.grade).toBe('poor');
    expect(monitor.profile.concurrency).toBeLessThan(16);
    expect(monitor.profile.maxZoom).toBeLessThan(16);
  });

  it('grades a merely slow link as slow, not poor', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    // ~250 kB/s, with every tile still arriving in well under a second:
    // usable, but not enough to finish z16 under a moving aircraft.
    feed(monitor, env, 10, 100_000, 400);
    expect(monitor.profile.grade).toBe('slow');
  });

  it('does not throttle a healthy link just because the app went quiet', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    // What the browser actually showed: once the quadtree had what it needed
    // it stopped asking, so one small request trickled along at a time and
    // aggregate throughput collapsed to 82 kB/s — while every tile was still
    // landing in 134 ms and nothing was failing. Throttling on that reading
    // is throttling on the app's own idleness.
    for (let i = 0; i < 12; i++) {
      env.time += 3000; // long gaps: nothing else is in flight
      monitor.record({ ms: 134, bytes: 30_000, ok: true });
    }

    // A single stream that pulled 30 kB in 134 ms proves at least ~220 kB/s
    // was available to it, so the link is judged on that rather than on the
    // near-zero aggregate its own idleness produced. It must not land on the
    // floor grade, which is what caused the app to drop to its lowest detail.
    expect(monitor.profile.grade).not.toBe('poor');
    expect(monitor.profile.maxZoom).toBeGreaterThanOrEqual(16);
  });

  it('measures the same capacity however many requests are in flight', () => {
    // The property that makes the grade stable. The same 3 MB/s link, seen
    // twice: once with sixty requests sharing it (each one slow) and once
    // throttled to a handful (each one fast). Per-request latency differs by
    // two orders of magnitude between these; capacity must not, because
    // capacity is what the profile steers by and the profile is what sets the
    // concurrency. Measured live at 12 268 ms and 180 ms on one connection.
    const saturated = new NetworkMonitor(fakeEnv());
    const throttled = new NetworkMonitor(fakeEnv());

    // 60 in flight: each request carries 600 kB and takes 12 s, and they
    // complete 200 ms apart once the pipeline is full.
    for (let i = 0; i < 40; i++) {
      saturated.record({ ms: 12_000, bytes: 600_000, ok: true, at: 12_000 + i * 200 });
    }
    // The same pipe, one request at a time: 600 kB in 200 ms.
    for (let i = 0; i < 40; i++) {
      throttled.record({ ms: 200, bytes: 600_000, ok: true, at: 200 + i * 200 });
    }

    const a = saturated.readout();
    const b = throttled.readout();

    // Latency says these are two wildly different connections.
    expect(a.latencyMs! / b.latencyMs!).toBeGreaterThan(10);

    // Capacity says they are the same one. Not identical: the busy-interval
    // union counts the pipeline's 12 s ramp-up at full weight while only half
    // the requests were yet running, so the saturated reading is a touch low.
    // It stays a lower bound, which is all capacity ever claims to be, and the
    // spread is a small factor rather than the sixty-fold one above.
    expect(Math.max(a.throughputBps, b.throughputBps) / Math.min(a.throughputBps, b.throughputBps))
      .toBeLessThan(3);

    // Which is what matters: the two land on the same profile, so throttling
    // the link cannot talk the app into throttling it further.
    expect(Math.abs(gradeRank(saturated.profile.grade) - gradeRank(throttled.profile.grade)))
      .toBeLessThanOrEqual(1);
  });

  it('reports offline when the browser says so, whatever the samples say', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);
    feed(monitor, env, 10, 500_000, 20);

    env.online = false;
    monitor.refresh();

    expect(monitor.profile.grade).toBe('offline');
    // Prefetching into a dead link is pure waste.
    expect(monitor.profile.prefetchSeconds).toBe(0);
  });

  it('calls a link offline when everything is failing, before the browser does', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    // A captive portal, or a tunnel: `navigator.onLine` is still true and
    // every single request is timing out.
    for (let i = 0; i < 10; i++) {
      env.time += 5000;
      monitor.record({ ms: 5000, bytes: 0, ok: false, timedOut: true });
    }

    expect(monitor.profile.grade).toBe('offline');
    expect(monitor.readout().timeouts).toBe(10);
  });

  it('honours Save-Data even on a fast link', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);
    feed(monitor, env, 10, 500_000, 20);
    expect(monitor.profile.grade).not.toBe('poor');

    env.save = true;
    monitor.refresh();
    // The user asked for less data. Measuring that they *could* have more is
    // not a reason to ignore them.
    expect(monitor.profile.grade).toBe('poor');
  });

  it('measures throughput across wall-clock time, not summed durations', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    // Ten requests that each took a second but all overlapped, finishing one
    // millisecond apart. Summing durations would report a tenth of the truth
    // and throttle a link that is working perfectly.
    for (let i = 0; i < 10; i++) {
      env.time += 1;
      monitor.record({ ms: 1000, bytes: 100_000, ok: true });
    }

    const { throughputBps } = monitor.readout();
    // 900 kB delivered over roughly the 1009 ms the window spans.
    expect(throughputBps).toBeGreaterThan(500_000);
  });

  it('reports the median latency of successful transfers only', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    for (const ms of [10, 20, 30, 40, 50]) {
      env.time += ms;
      monitor.record({ ms, bytes: 1000, ok: true });
    }
    // A failure that took 30 s must not drag the median: it is not a
    // measurement of how long a transfer takes, it is a measurement of a
    // timeout we chose.
    env.time += 30_000;
    monitor.record({ ms: 30_000, bytes: 0, ok: false, timedOut: true });

    expect(monitor.readout().latencyMs).toBe(30);
  });

  it('never lets a worse grade permit more work than a better one', () => {
    const grades = ['offline', 'poor', 'slow', 'good', 'fast'] as const;
    for (let i = 1; i < grades.length; i++) {
      const worse = profileFor(grades[i - 1]!);
      const better = profileFor(grades[i]!);
      expect(worse.concurrency).toBeLessThanOrEqual(better.concurrency);
      expect(worse.maxZoom).toBeLessThanOrEqual(better.maxZoom);
      // Screen-space error runs the other way: higher is blurrier.
      expect(worse.screenSpaceError).toBeGreaterThanOrEqual(better.screenSpaceError);
    }
  });

  it('notifies subscribers only when the grade actually changes', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);
    const seen: string[] = [];
    monitor.subscribe((profile) => seen.push(profile.grade));

    feed(monitor, env, 10, 10_000, 1000);
    feed(monitor, env, 10, 10_000, 1000);

    // Twenty samples, one transition. A listener that fired per sample would
    // put a toast on screen twenty times.
    expect(seen).toEqual(['poor']);
  });
});

describe('NetworkMonitor demand', () => {
  /**
   * Regression: the app degraded itself for having succeeded.
   *
   * Once the quadtree is served the loader stops asking, and the trickle that
   * remains is small requests dominated by round-trip time. Measured that way
   * a healthy link reads as `poor` — which clamps the zoom ceiling and the
   * concurrency, so the ground gets worse, and the app cannot climb back out
   * because recovering needs the very requests the clamp prevents. Observed
   * live at 204 ms latency with zero failures.
   */
  it('does not downgrade a healthy link that nobody is using', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    // Busy and fine: establishes a good grade on real contention.
    feed(monitor, env, 12, 400_000, 200);
    const busyGrade = monitor.readout().grade;

    // The queue drains. Everything after this is a demand-limited trickle:
    // small objects, latency-bound, exactly what used to read as `poor`.
    // Enough of them to flush the busy ones out of the window entirely, which
    // is what makes this the live case rather than a mixture.
    monitor.setDemand(0, 0);
    env.time += 5000;
    feed(monitor, env, 50, 8000, 200);

    expect(monitor.readout().grade).toBe(busyGrade);
    expect(monitor.profile.maxZoom).toBeGreaterThanOrEqual(17);
  });

  /** Real contention must still be graded, however bad the news. */
  it('still downgrades while the loader has work outstanding', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    monitor.setDemand(8, 40);
    feed(monitor, env, 20, 4000, 900);

    expect(monitor.readout().grade).toBe('poor');
  });

  /** Failures are evidence whether or not anything was queued. */
  it('degrades on failures even when idle', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    monitor.setDemand(0, 0);
    env.time += 5000;
    for (let i = 0; i < 16; i++) {
      env.time += 100;
      monitor.record({ ms: 8000, bytes: 0, ok: false, timedOut: true });
    }

    expect(['poor', 'offline']).toContain(monitor.readout().grade);
  });

  /**
   * Regression: a trickle is not idle, and is not a measurement either.
   *
   * `IDLE_GRACE_MS` catches a loader with nothing outstanding. It does not
   * catch one with two things outstanding, which reads almost as badly:
   * measured on a 5G tether against the real imagery host, one request at a
   * time returned 183 kB/s where sixteen returned 763. The link was the same
   * link. Graded on the first number it lands in `slow`, and the detail
   * target drops for no reason the user can see.
   */
  it('does not grade capacity from a window nothing filled', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    // Busy and fine first, so there is a grade worth protecting.
    monitor.setDemand(10, 30);
    feed(monitor, env, 12, 400_000, 200);
    const busyGrade = monitor.readout().grade;
    expect(gradeRank(busyGrade)).toBeGreaterThanOrEqual(gradeRank('good'));

    // Now a two-at-a-time trickle — never idle, never enough to fill the
    // pipe. Every sample is latency-bound and reads as a quarter of the
    // link's real capacity.
    for (let i = 0; i < 50; i++) {
      monitor.setDemand(2, 0);
      env.time += 200;
      monitor.record({ ms: 200, bytes: 9000, ok: true });
    }

    expect(monitor.readout().grade).toBe(busyGrade);
  });

  /** ...but a deep queue is exactly the case where the reading is real. */
  it('grades capacity once enough was asked at once to fill the link', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    // Same per-request numbers as the trickle above. The difference is that
    // the loader genuinely had the link saturated, so this time 45 kB/s is
    // the truth about it.
    for (let i = 0; i < 20; i++) {
      monitor.setDemand(12, 60);
      env.time += 200;
      monitor.record({ ms: 200, bytes: 9000, ok: true });
    }

    expect(gradeRank(monitor.readout().grade)).toBeLessThan(gradeRank('good'));
  });

  /** An idle link that is plainly healthy lifts an earlier clamp. */
  it('climbs back out of a clamp once the link looks healthy', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    // Get genuinely clamped on real contention.
    monitor.setDemand(8, 40);
    feed(monitor, env, 20, 4000, 900);
    expect(monitor.readout().grade).toBe('poor');

    // Then go quiet, with healthy round trips. Enough of them to flush the
    // slow ones out of the window — the median is what the grade reads, and
    // history is still history until it ages out.
    monitor.setDemand(0, 0);
    env.time += 5000;
    feed(monitor, env, 50, 9000, 150);
    env.time += UPGRADE_HOLD_TEST_MS;
    monitor.refresh();

    expect(monitor.readout().grade).not.toBe('poor');
  });
});

describe('hysteresis around the grade boundaries', () => {
  /**
   * The failure this pins is not a wrong grade, it is a grade that will not
   * sit still. A link measuring near a boundary crosses it in both directions
   * from one window to the next, and every crossing re-ranks the loader queue,
   * moves the zoom ceiling, moves the feed radius and tells the user their
   * connection changed. Nothing about the link did.
   */

  /** Bytes and duration that measure out to roughly `bps` on one stream. */
  const atRate = (bps: number, ms: number): { ms: number; bytes: number; ok: true } => ({
    ms,
    bytes: Math.round((bps * ms) / 1000),
    ok: true,
  });

  // A full window, so each call replaces the previous reading rather than
  // being averaged into it. WINDOW is 48.
  function runAt(monitor: NetworkMonitor, env: FakeEnv, bps: number, n = 48): void {
    for (let i = 0; i < n; i++) {
      env.time += 200;
      monitor.record(atRate(bps, 200));
    }
  }

  it('does not change grade when the link straddles a boundary', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    // Settle clearly inside `good`.
    runAt(monitor, env, 1_000_000);
    env.time += UPGRADE_HOLD_TEST_MS;
    runAt(monitor, env, 1_000_000);
    expect(monitor.measuredGrade).toBe('good');

    // Now oscillate either side of the 450 kB/s slow/good boundary, which is
    // what an ordinary home connection actually measures like. Every one of
    // these windows would have flipped the grade before the dead band.
    for (const bps of [386_000, 731_000, 402_000, 640_000, 430_000]) {
      runAt(monitor, env, bps);
      env.time += UPGRADE_HOLD_TEST_MS;
      runAt(monitor, env, bps);
      expect(monitor.measuredGrade).toBe('good');
    }
  });

  it('still degrades once the link is genuinely past the boundary', () => {
    const env = fakeEnv();
    const monitor = new NetworkMonitor(env);

    runAt(monitor, env, 1_000_000);
    expect(monitor.measuredGrade).toBe('good');

    // Well clear of 450 kB/s * (1 - 0.3): a real slowdown, not a wobble.
    runAt(monitor, env, 200_000);
    expect(monitor.measuredGrade).toBe('slow');
  });

  it('makes the boundary sticky in whichever direction it is approached from', () => {
    // The same measurement must be read differently depending on where the
    // link already is — that is what a dead band *is*, and asserting it
    // directly is the only way to catch the band being applied one-sided.
    const settle = (from: number, then: number): NetworkGrade => {
      const env = fakeEnv();
      const monitor = new NetworkMonitor(env);
      runAt(monitor, env, from);
      env.time += UPGRADE_HOLD_TEST_MS;
      runAt(monitor, env, from);
      runAt(monitor, env, then);
      env.time += UPGRADE_HOLD_TEST_MS;
      runAt(monitor, env, then);
      return monitor.measuredGrade;
    };

    // 500 kB/s is above the nominal 450 kB/s boundary but inside the band.
    expect(settle(1_000_000, 500_000)).toBe('good');
    expect(settle(150_000, 500_000)).toBe('slow');
  });
});
