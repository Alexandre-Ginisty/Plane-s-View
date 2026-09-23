/**
 * The measurement itself.
 *
 * Passive, from tile requests that were going to happen anyway — a monitor
 * that costs bandwidth on a weak link is self-defeating. `probe` exists for an
 * *active* round-trip measurement and is used only where the passive window
 * cannot work: at startup, when there is no data yet, and while the link is
 * already degraded, where too few transfers complete for the window to notice
 * a recovery.
 *
 * The two judgement calls worth knowing about are in `throughput` (wall-clock
 * span, not summed durations) and `reclassify` (degrade immediately, upgrade
 * slowly). Both are explained where they are implemented.
 */

import {
  gradeRank,
  profileFor,
  type NetworkGrade,
  type NetworkReadout,
  type StreamingProfile,
  type TransferSample,
} from './profile';
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
 * served it stops requesting, and the few stragglers that trickle through are
 * small objects dominated by round-trip time rather than bandwidth: an 8 kB
 * tile answered in 200 ms reads as 40 kB/s on a link that would happily carry
 * fifty times that. Graded literally, that is `poor`.
 *
 * Observed live, and this is the failure that matters: the cockpit finished
 * streaming, the queue drained to zero, and the monitor then walked itself
 * good -> slow -> poor on an idle link with 204 ms latency and no failures.
 * `poor` clamps the ceiling to z14 and concurrency to 10, so the app degraded
 * its own ground quality *because* it had succeeded — and then could not climb
 * back, since recovering needs measurements that only arrive when it asks for
 * more, which the clamped profile prevents. A self-locking loop.
 *
 * Demand is reported by the loader rather than inferred from the samples,
 * because the two look identical from here: a serial trickle on a fast idle
 * link and a saturated slow link both produce one small slow request at a
 * time. Only the queue knows which it is. A monitor nobody reports to assumes
 * it is busy, which keeps this invisible to anything that just records
 * samples.
 */
const IDLE_GRACE_MS = 4000;

/**
 * Requests that must have been outstanding before capacity counts as a
 * measurement of the *link* rather than of how little was asked of it.
 *
 * Idleness is not the only way to under-ask. Measured on a 5G tether against
 * the real imagery host, one request at a time returned 183 kB/s; six returned
 * 659; sixteen returned 763 and forty returned 762. The link never changed —
 * only how much of it was being used. So a window filled by a handful of
 * stragglers reports a quarter of the truth, and `IDLE_GRACE_MS` does not
 * catch it because the loader was not idle, merely nearly so.
 *
 * Observed live on that tether: capacity readings of 386 and 731 kB/s either
 * side of the 450 kB/s slow/good boundary, from a connection measuring 763.
 * The grade flapped slow -> good -> slow, and with it the detail target,
 * which is visible as the ground re-refining for no reason.
 *
 * Six is the point where the measurements above reach ~85% of the plateau —
 * enough of the bandwidth-delay product in flight for the number to mean
 * something. Below it the reading is a lower bound and is treated as no
 * evidence, exactly as an idle window is. Failures are unaffected: a request
 * that errored was one we asked for, however few of them there were.
 *
 * Judged per sample, not from a high-water mark. A burst followed by a long
 * trickle never returns the loader to zero, so a peak would go on vouching
 * for samples taken minutes later under no load at all. Each transfer
 * remembers what else was outstanding when it landed, and the window's median
 * is what decides.
 */
const MEASURABLE_DEMAND = 6;

/**
 * Below this, a "transfer" did not touch the network, ms.
 *
 * The browser's own HTTP cache answers in a millisecond or two, and those
 * responses arrive through exactly the same code path as a real fetch. Counted
 * as measurements they report tens of megabytes a second, which is a true
 * statement about the cache and a false one about the link — and the link is
 * what the profile is steering by. Observed live: capacity readings swinging
 * between 236 kB/s and 7 MB/s between consecutive samples of one connection.
 *
 * They stay in the window, because a cache hit is still a successful outcome
 * and dropping it would inflate the failure ratio; they are simply not
 * evidence about bandwidth.
 */
const CACHE_HIT_MS = 5;

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

  /** Record a finished transfer. Cheap enough to call on every tile. */
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

  /** Latest active round-trip measurement, if one has been taken. */
  setPing(ms: number | null): void {
    this.pingMs = ms;
    this.reclassify();
  }

  /**
   * Measure round-trip latency directly.
   *
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

  get profile(): StreamingProfile {
    return profileFor(this.grade);
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
   * Two wrong answers to avoid here, and they fail in opposite directions.
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
   * Tell the monitor how much work the loader is holding.
   *
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
   * Aggregate throughput measures demand as much as capacity: once the
   * quadtree has what it needs it stops asking, one small request trickles
   * along at a time, and the aggregate collapses. Measured live, a healthy
   * fibre link read 82 kB/s for exactly that reason and the app throttled
   * itself to its lowest detail setting in response — while every tile was
   * arriving in 134 ms and nothing was failing.
   *
   * A single request's own rate has no such problem: a 40 kB tile that lands
   * in 130 ms proves 300 kB/s was available to it, however many other
   * requests were or were not in flight.
   */
  private streamRate(): number {
    const ok = this.samples.filter((s) => s.ok && s.bytes > 0 && s.ms > CACHE_HIT_MS);
    if (ok.length === 0) return 0;
    const rates = ok.map((s) => (s.bytes * 1000) / s.ms).sort((a, b) => a - b);
    return rates[Math.floor(rates.length / 2)]!;
  }

  /**
   * Best estimate of what the link can carry.
   *
   * The larger of the two measures, because each is a *lower bound* that the
   * other's blind spot does not share: with many requests in flight the
   * aggregate is the truth and a single stream understates it; with one
   * request in flight the single stream is the truth and the aggregate
   * understates it. Neither can overstate.
   */
  private capacity(): number {
    return Math.max(this.throughput(), this.streamRate());
  }

  private failureRatio(): number {
    if (this.samples.length === 0) return 0;
    return this.samples.filter((s) => !s.ok).length / this.samples.length;
  }

  /**
   * Classify the link from the window, then apply the asymmetric hysteresis.
   *
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
     * Many measurements beat one, even a cleaner one.
     *
     * A single probe is not confounded by payload size, which is why it looks
     * like the better latency signal — but it is one sample, and the moment it
     * matters most is the moment it is least trustworthy. Measured live: the
     * startup probe fired alongside the first burst of tile requests, opened a
     * fresh connection to a host nothing was yet talking to, and came back at
     * 5.7 s on a fibre link. The app then throttled itself to `poor` on the
     * strength of congestion it had caused itself, which is a feedback loop,
     * not a measurement.
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
     * Graded on capacity, not on how long a request took. This is the one
     * decision in the module that has to be got right, and the obvious answer
     * is the wrong one.
     *
     * Per-request latency is the intuitive signal — it is literally "how long
     * does a tile take" — and it is *not independent of the thing this profile
     * controls*. With 72 requests in flight each one gets a seventy-second of
     * the pipe, so latency reads in seconds; throttle to 10 and the same link
     * reads in milliseconds. Measured live: 12 268 ms median at 63 in flight,
     * 180 ms at 10, on one unchanged connection. Grading on that closes a loop
     * between the measurement and the actuator, and the profile oscillates
     * between extremes for ever without the link having changed at all.
     *
     * Aggregate capacity is invariant under concurrency, which makes it the
     * only stable thing to steer by. Latency survives here solely as a coarse
     * check on the very top grade, where committing to maximum detail on a
     * link that is visibly struggling would be the expensive mistake.
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

    if (readout.failures > 0.35 || readout.capacity < 120_000) return 'poor';
    if (readout.failures > 0.15 || readout.capacity < 450_000) return 'slow';
    if (readout.capacity < 2_000_000 || (latency !== null && latency > 400)) return 'good';
    return 'fast';
  }

  private reclassify(): void {
    const next = this.classify();
    if (next === this.grade) {
      this.pendingUpgrade = null;
      return;
    }

    if (gradeRank(next) < gradeRank(this.grade)) {
      // Downgrade: immediate, no hold.
      this.pendingUpgrade = null;
      this.commit(next);
      return;
    }

    const now = this.env.now();

    /*
     * The hold is on "better than now", not on one specific better grade.
     *
     * Restarting the clock every time the reading improves again sounds
     * conservative and is actually a trap: a link recovering steadily reads
     * slow, then good, then fast, and a per-grade hold would reset at each
     * step and never commit to anything. What the hold is protecting against
     * is a *brief* improvement, so it starts when the improvement starts and
     * commits to whatever the reading says once it has lasted.
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
    const profile = this.profile;
    const readout = this.readout();
    for (const listener of this.listeners) listener(profile, readout);
  }

  /** Test and recovery hook: forget the window and start judging again. */
  reset(): void {
    this.samples.length = 0;
    this.pendingUpgrade = null;
    this.pingMs = null;
    this.grade = 'good';
  }
}

/** Shared instance. The loader feeds it; the globe and the UI read it. */
export const networkMonitor = new NetworkMonitor();
