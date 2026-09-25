/**
 * The measurement itself.
 *
 * Passive, from tile requests that were going to happen anyway — a monitor
 * that costs bandwidth on a weak link is self-defeating. `probe` exists for an
 * *active* round-trip measurement and is used only where the passive window
 * cannot work: at startup, when there is no data yet, and while the link is
 * already degraded, where too few transfers complete for the window to notice
 * a recovery.
 */

import {
  gradeRank,
  profileFor,
  type NetworkGrade,
  type NetworkReadout,
  type StreamingProfile,
  type TransferSample,
} from './profile';
import { capGrade, type QualityPreference } from './preference';
import { browserEnvironment, type NetworkEnvironment } from './environment';

/** Samples kept. Enough to be stable, few enough to react within seconds. */
const WINDOW = 48;

/**
 * Minimum samples before the measurement is trusted.
 *
 * Below this the monitor reports `good` rather than its best guess. Starting
 * optimistic would commit a phone on a train to 128 parallel requests for the
 * first few seconds — precisely the mistake this module exists to prevent —
 * and starting pessimistic would make a fibre connection crawl until it proved
 * itself. The neutral middle is the only defensible default.
 */
const MIN_SAMPLES = 8;

/**
 * How long a better reading must hold before the profile is upgraded, ms.
 *
 * Asymmetric on purpose. Degrading immediately is right: the user is already
 * suffering and every second spent proving it wastes their bandwidth.
 * Upgrading slowly is also right: a single fast tile out of a cache does not
 * mean the link recovered, and thrashing the profile re-sorts the loader queue
 * and changes the target zoom, which is visible as terrain popping.
 */
const UPGRADE_HOLD_MS = 6000;

/**
 * How long the loader must have had nothing to do before its measurements
 * stop counting as evidence about the link, ms.
 *
 * You cannot measure a capacity you never asked for. Once the quadtree is
 * served it stops requesting, and the stragglers are small objects dominated
 * by round-trip time: an 8 kB tile answered in 200 ms reads as 40 kB/s on a
 * link that would carry fifty times that. Observed live, the monitor walked
 * itself good -> slow -> poor on an idle link with 204 ms latency and no
 * failures — and `poor` then clamps concurrency, so recovering needs
 * measurements the clamp itself prevents. A self-locking loop.
 *
 * Demand is reported by the loader rather than inferred from the samples,
 * because the two look identical from here: a serial trickle on a fast idle
 * link and a saturated slow link both produce one small slow request at a
 * time. Only the queue knows which it is.
 */
const IDLE_GRACE_MS = 4000;

/**
 * Requests that must have been outstanding before capacity counts as a
 * measurement of the *link* rather than of how little was asked of it.
 *
 * Idleness is not the only way to under-ask. Measured on a 5G tether against
 * the real imagery host, one request at a time returned 183 kB/s; six returned
 * 659; sixteen 763 and forty 762. The link never changed — only how much of it
 * was being used, and `IDLE_GRACE_MS` misses that because the loader was not
 * idle, merely nearly so. The grade flapped slow -> good -> slow across the
 * 450 kB/s boundary on a connection measuring 763.
 *
 * Six is where those measurements reach ~85% of the plateau. Below it the
 * reading is a lower bound and counts as no evidence, exactly as an idle
 * window does; failures still count, since a request that errored was one we
 * asked for.
 *
 * Judged per sample, not from a high-water mark: a burst followed by a long
 * trickle never returns the loader to zero, so a peak would go on vouching for
 * samples taken minutes later under no load at all.
 */
const MEASURABLE_DEMAND = 6;

/**
 * Below this, a "transfer" did not touch the network, ms.
 *
 * The browser's own HTTP cache answers in a millisecond or two, through the
 * same code path as a real fetch. Counted as measurements they report tens of
 * megabytes a second — true about the cache, false about the link, which is
 * what the profile steers by. Observed live: readings swinging between
 * 236 kB/s and 7 MB/s between consecutive samples of one connection.
 *
 * They stay in the window, because a cache hit is still a successful outcome
 * and dropping it would inflate the failure ratio; they are simply not
 * evidence about bandwidth.
 */
const CACHE_HIT_MS = 5;

/**
 * Dead band around every grade boundary, as a fraction of the boundary.
 *
 * Without one the boundaries are knife edges, and a link sitting near one does
 * not sit on one side of it — it crosses back and forth. Observed on an
 * ordinary home connection measuring around the 450 kB/s slow/good boundary:
 * readings of 386 and 731 kB/s in consecutive windows, so the grade walked
 * good -> slow -> good indefinitely while nothing about the link changed.
 *
 * Every consumer pays for that. The zoom ceiling moves, so the ground
 * re-refines; the feed radius moves, so aircraft appear and vanish; and the
 * user is told their connection dropped and recovered, repeatedly, on a link
 * that was fine throughout. The `UPGRADE_HOLD_MS` timer cannot help, because
 * each reading genuinely is a new grade — it delays the flapping rather than
 * stopping it.
 *
 * 0.3 means a grade is left only once the measurement is 30% clear of the
 * boundary on the far side, which is wider than the spread above. The cost is
 * that a link settling just past a boundary keeps the more conservative grade;
 * that is the right way to be wrong, since the conservative grade is the one
 * that still works.
 */
const HYSTERESIS = 0.3;

/** A sample plus what else the loader had outstanding when it landed. */
interface WindowSample extends TransferSample {
  load: number;
}

export type NetworkListener = (profile: StreamingProfile, readout: NetworkReadout) => void;

export class NetworkMonitor {
  private readonly samples: WindowSample[] = [];
  private grade: NetworkGrade = 'good';
  /** When the loader last went quiet, or null while it has work. */
  private idleSince: number | null = null;
  /**
   * What the loader is holding right now, stamped onto each sample.
   *
   * Starts at the measurable threshold so a monitor nobody reports to assumes
   * it is busy: silence must not be read as "there was no demand", or an app
   * with no loader wired up would never grade anything.
   */
  private currentDemand = MEASURABLE_DEMAND;
  /** A better grade seen but not yet committed, and since when. */
  private pendingUpgrade: { grade: NetworkGrade; since: number } | null = null;
  private pingMs: number | null = null;
  private readonly listeners = new Set<NetworkListener>();

  constructor(private readonly env: NetworkEnvironment = browserEnvironment) {}

  /** Cheap enough to call on every tile. */
  record(sample: TransferSample): void {
    this.samples.push({
      ...sample,
      at: sample.at ?? this.env.now(),
      load: this.currentDemand,
    });
    if (this.samples.length > WINDOW) this.samples.splice(0, this.samples.length - WINDOW);
    this.reclassify();
  }

  /**
   * Re-evaluate without adding a sample.
   *
   * For signals that change the verdict without being a transfer — chiefly the
   * browser's own `online`/`offline` events. Injecting a synthetic failed
   * sample to force a re-read would be the obvious shortcut and it would
   * poison the failure ratio for the next forty-eight real requests.
   */
  refresh(): void {
    this.reclassify();
  }

  setPing(ms: number | null): void {
    this.pingMs = ms;
    this.reclassify();
  }

  /**
   * Used when there is no passive data to work from — at startup, and while
   * the link is already known to be bad, where a fast probe is the only way to
   * notice that it recovered. `cache: 'no-store'` because a cached answer
   * measures the disk, not the network.
   */
  async probe(url: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
    const started = this.env.now();
    try {
      const res = await fetchImpl(url, {
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        signal: AbortSignal.timeout(6000),
      });
      // Draining matters: without it the timer stops at the response headers
      // and reports a first-byte time as if it were a completed transfer.
      await res.arrayBuffer();
      if (!res.ok) {
        this.setPing(null);
        return null;
      }
      const ms = this.env.now() - started;
      this.setPing(ms);
      return ms;
    } catch {
      this.setPing(null);
      return null;
    }
  }

  /**
   * The user's ceiling on the measured grade.
   *
   * Defaults to `high`, meaning *no* ceiling: on its own this class is a
   * measuring instrument and reports what it measured. The product decision
   * — that a first visit should be economical — belongs to the app, which
   * calls `setQuality` at boot with the stored preference. Keeping the default
   * here uncapped is also what lets these tests assert what the link actually
   * graded as rather than what a preference allowed through.
   */
  private quality: QualityPreference = 'high';

  /** Emits only if the effective profile actually moved. */
  setQuality(preference: QualityPreference): void {
    if (this.quality === preference) return;
    const before = this.profile.grade;
    this.quality = preference;
    if (this.profile.grade !== before) this.emit();
  }

  get qualityPreference(): QualityPreference {
    return this.quality;
  }

  /** What the link measured, before the user's ceiling. */
  get measuredGrade(): NetworkGrade {
    return this.grade;
  }

  /**
   * The measurement held under the user's ceiling — see `preference.ts`. The
   * ceiling can only ever lower it: a preference cannot make a weak link carry
   * more, and pretending otherwise is the failure the grades exist to prevent.
   */
  get profile(): StreamingProfile {
    return profileFor(capGrade(this.grade, this.quality));
  }

  subscribe(listener: NetworkListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  readout(): NetworkReadout {
    const ok = this.samples.filter((s) => s.ok);
    const durations = ok.map((s) => s.ms).sort((a, b) => a - b);
    const latencyMs = durations.length ? durations[Math.floor(durations.length / 2)]! : null;

    return {
      grade: this.grade,
      latencyMs,
      pingMs: this.pingMs,
      throughputBps: this.capacity(),
      failureRatio: this.failureRatio(),
      timeouts: this.samples.filter((s) => s.timedOut === true).length,
      samples: this.samples.length,
      offline: !this.env.onLine(),
      effectiveType: this.env.effectiveType(),
      saveData: this.env.saveData(),
    };
  }

  /**
   * Bytes per second over the time the link was actually *busy*.
   *
   * Summing each request's duration counts the same wall-clock second once per
   * parallel request — and parallelism is the entire point of the loader — so
   * it under-reports by roughly the concurrency factor and throttles a link
   * that is working perfectly.
   *
   * Dividing by the span from the first sample to the last has the opposite
   * problem: it counts *idle* time as if the link had been delivering nothing
   * during it. A tab that sits still for seven seconds and then downloads a
   * megabyte in one would be graded as slow, and would then be given a smaller
   * zoom ceiling for having been asked to do nothing.
   *
   * The honest measure is the union of the intervals during which at least one
   * request was in flight. Gaps are excluded; overlap is counted once.
   */
  private throughput(): number {
    const ok = this.samples.filter((s) => s.ok && s.bytes > 0 && s.ms > CACHE_HIT_MS);
    if (ok.length < 2) return 0;

    const intervals = ok
      .map((s) => [(s.at ?? 0) - s.ms, s.at ?? 0] as const)
      .sort((a, b) => a[0] - b[0]);

    let busyMs = 0;
    let start = intervals[0]![0];
    let end = intervals[0]![1];
    for (let i = 1; i < intervals.length; i++) {
      const [s, e] = intervals[i]!;
      if (s > end) {
        busyMs += end - start;
        start = s;
        end = e;
      } else if (e > end) {
        end = e;
      }
    }
    busyMs += end - start;

    const bytes = ok.reduce((sum, s) => sum + s.bytes, 0);
    return (bytes * 1000) / Math.max(1, busyMs);
  }

  /**
   * Called every time the loader pumps its queue. See `IDLE_GRACE_MS` — this
   * is what separates "the link is slow" from "we stopped asking", which the
   * transfer samples alone cannot distinguish.
   */
  setDemand(inFlight: number, queued: number): void {
    this.currentDemand = inFlight + queued;
    if (this.currentDemand > 0) {
      this.idleSince = null;
      return;
    }
    this.idleSince ??= this.env.now();
  }

  /**
   * True when the window cannot speak about the link's capacity.
   *
   * Either because nothing was asked of it for a while (`IDLE_GRACE_MS`) or
   * because too little was outstanding while these samples landed to fill it
   * (`MEASURABLE_DEMAND`).
   */
  private demandLimited(): boolean {
    if (this.samples.length > 0) {
      const loads = this.samples.map((s) => s.load).sort((a, b) => a - b);
      if (loads[Math.floor(loads.length / 2)]! < MEASURABLE_DEMAND) return true;
    }
    return this.idleSince !== null && this.env.now() - this.idleSince >= IDLE_GRACE_MS;
  }

  /**
   * Bytes per second the link delivered to a *single* request, median.
   *
   * The companion to `throughput`, and the one that survives an idle app.
   * Aggregate throughput measures demand as much as capacity: measured live, a
   * healthy fibre link read 82 kB/s once the quadtree stopped asking, and the
   * app throttled itself to its lowest detail setting — while every tile was
   * arriving in 134 ms and nothing was failing. A single request's own rate has
   * no such problem: a 40 kB tile landing in 130 ms proves 300 kB/s was
   * available to it, whatever else was in flight.
   */
  private streamRate(): number {
    const ok = this.samples.filter((s) => s.ok && s.bytes > 0 && s.ms > CACHE_HIT_MS);
    if (ok.length === 0) return 0;
    const rates = ok.map((s) => (s.bytes * 1000) / s.ms).sort((a, b) => a - b);
    return rates[Math.floor(rates.length / 2)]!;
  }

  /**
   * The larger of the two measures, because each is a *lower bound* the other's
   * blind spot does not share: with many requests in flight the aggregate is
   * the truth and a single stream understates it; with one in flight it is the
   * other way round. Neither can overstate.
   */
  private capacity(): number {
    return Math.max(this.throughput(), this.streamRate());
  }

  private failureRatio(): number {
    if (this.samples.length === 0) return 0;
    return this.samples.filter((s) => !s.ok).length / this.samples.length;
  }

  /**
   * The thresholds are ordered worst-first and the first match wins, so a link
   * that is fast but failing lands in the failing bucket — which is correct:
   * throughput you cannot rely on is not throughput.
   */
  private classify(): NetworkGrade {
    if (!this.env.onLine()) return 'offline';

    const readout = {
      failures: this.failureRatio(),
      capacity: this.capacity(),
      samples: this.samples.length,
    };

    // Everything is failing and the browser has not noticed yet: captive
    // portal, an airline wifi that dropped, a tunnel.
    if (readout.samples >= MIN_SAMPLES && readout.failures > 0.75) return 'offline';

    if (this.env.saveData()) return 'poor';

    const durations = this.samples.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
    const median = durations.length ? durations[Math.floor(durations.length / 2)]! : null;

    /*
     * Many measurements beat one, even a cleaner one. A single probe is not
     * confounded by payload size, which is why it looks like the better
     * latency signal — but the moment it matters most is the moment it is
     * least trustworthy. Measured live: the startup probe fired alongside the
     * first burst of tile requests, opened a fresh connection, and came back
     * at 5.7 s on a fibre link; the app throttled itself to `poor` on the
     * strength of congestion it had caused itself.
     *
     * So the passive median leads wherever it exists, and the probe is the
     * fallback for the two cases where nothing else can speak: before any
     * transfer has completed, and on a link so dead that none ever does.
     */
    const latency = median ?? this.pingMs;

    if (readout.samples < MIN_SAMPLES) {
      // Neutral, deliberately. Committing to a grade on the strength of a
      // single cold probe is exactly the mistake described above, and the
      // window fills within a couple of seconds of real traffic anyway.
      return 'good';
    }

    /*
     * Graded on capacity, not on how long a request took, and the obvious
     * answer is the wrong one. Per-request latency is *not independent of the
     * thing this profile controls*: with 72 requests in flight each gets a
     * seventy-second of the pipe, so latency reads in seconds; throttle to 10
     * and the same link reads in milliseconds. Measured live: 12 268 ms median
     * at 63 in flight, 180 ms at 10, on one unchanged connection. Grading on
     * that closes a loop between the measurement and the actuator and the
     * profile oscillates for ever.
     *
     * Aggregate capacity is invariant under concurrency, which makes it the
     * only stable thing to steer by. Latency survives solely as a coarse check
     * on the top grade, where committing to maximum detail on a link that is
     * visibly struggling would be the expensive mistake.
     */
    // Failures are always evidence — a request that errored was one we asked
    // for. Capacity is evidence only while there was something to deliver.
    // See `IDLE_GRACE_MS`.
    if (readout.failures <= 0.15 && this.demandLimited()) {
      // Refuse to degrade on no evidence, and let a healthy round trip lift a
      // clamp that demand-limited samples imposed earlier — otherwise the app
      // can never climb out of the grade its own success put it in.
      const healthy = latency !== null && latency < 600;
      if (healthy && gradeRank(this.grade) < gradeRank('good')) return 'good';
      return this.grade;
    }

    if (
      readout.failures > this.worseThan(0.35, 'poor') ||
      readout.capacity < this.betterThan(120_000, 'poor')
    ) {
      return 'poor';
    }
    if (
      readout.failures > this.worseThan(0.15, 'slow') ||
      readout.capacity < this.betterThan(450_000, 'slow')
    ) {
      return 'slow';
    }
    if (
      readout.capacity < this.betterThan(2_000_000, 'good') ||
      (latency !== null && latency > this.worseThan(400, 'good'))
    ) {
      return 'good';
    }
    return 'fast';
  }

  /**
   * A boundary on a "higher is better" quantity, widened to hold the current
   * grade. `guards` is the grade on the low side of it. See `HYSTERESIS`.
   */
  private betterThan(nominal: number, guards: NetworkGrade): number {
    return gradeRank(this.grade) > gradeRank(guards)
      ? nominal * (1 - HYSTERESIS)
      : nominal * (1 + HYSTERESIS);
  }

  /** The same, for a quantity where higher is worse: failures and latency. */
  private worseThan(nominal: number, guards: NetworkGrade): number {
    return gradeRank(this.grade) > gradeRank(guards)
      ? nominal * (1 + HYSTERESIS)
      : nominal * (1 - HYSTERESIS);
  }

  private reclassify(): void {
    const next = this.classify();
    if (next === this.grade) {
      this.pendingUpgrade = null;
      return;
    }

    if (gradeRank(next) < gradeRank(this.grade)) {
      this.pendingUpgrade = null;
      this.commit(next);
      return;
    }

    const now = this.env.now();

    /*
     * The hold is on "better than now", not on one specific better grade.
     * Restarting the clock whenever the reading improves again sounds
     * conservative and is a trap: a link recovering steadily reads slow, then
     * good, then fast, and a per-grade hold would reset at each step and never
     * commit. What it protects against is a *brief* improvement, so it starts
     * when the improvement starts.
     */
    if (!this.pendingUpgrade) {
      this.pendingUpgrade = { grade: next, since: now };
      return;
    }
    this.pendingUpgrade.grade = next;

    if (now - this.pendingUpgrade.since >= UPGRADE_HOLD_MS) {
      this.pendingUpgrade = null;
      this.commit(next);
    }
  }

  private commit(grade: NetworkGrade): void {
    this.grade = grade;
    this.emit();
  }

  private emit(): void {
    const profile = this.profile;
    const readout = this.readout();
    for (const listener of this.listeners) listener(profile, readout);
  }

  /** Test and recovery hook. */
  reset(): void {
    this.samples.length = 0;
    this.pendingUpgrade = null;
    this.pingMs = null;
    this.grade = 'good';
  }
}

/** Shared instance. The loader feeds it; the globe and the UI read it. */
export const networkMonitor = new NetworkMonitor();
