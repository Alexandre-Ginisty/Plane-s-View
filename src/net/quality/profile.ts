/**
 * Connection quality monitor and streaming profile.
 *
 * ## Why this exists
 *
 * Every streaming constant in this app used to be a single number tuned on a
 * good connection: 128 parallel tile requests, refine to zoom 17, accept 6 px
 * of screen-space error. On a fast link those numbers are right. On a weak one
 * they are actively destructive, and in a way that is worth spelling out
 * because it is counter-intuitive:
 *
 * **Asking for more makes you get less.** 128 parallel requests over a 500
 * kB/s link give each request 4 kB/s. A 40 kB satellite tile then needs ten
 * seconds, so *every* tile misses the 12 s timeout at roughly the same moment,
 * the whole batch fails together, and the retry logic asks for 128 more. The
 * ground never finishes at any zoom level — which is exactly the "sol charge
 * pas bien" symptom. With twelve requests in flight each gets 40 kB/s, every
 * tile lands in a second, and the picture fills in ring by ring.
 *
 * The same logic applies to depth. Refining to z17 on a weak link means the
 * quadtree spends the whole pipe on tiles four levels below what it could
 * actually finish, so the viewer sits looking at z11 blur while z17 requests
 * time out behind it. Capping the depth to what the link can deliver produces
 * a complete, coarser picture — which looks far better than an incomplete
 * sharp one.
 *
 * So the profile is not a "quality setting". It is a statement about what this
 * connection can actually deliver, and every consumer derives its numbers from
 * it.
 *
 * ## How the measurement works
 *
 * Passively, from tile requests that were going to happen anyway — no
 * synthetic traffic, because a monitor that costs bandwidth on a weak link is
 * self-defeating. `probe()` exists for an *active* latency measurement, and is
 * used only at startup (when there is no passive data yet) and while the link
 * is already known to be degraded.
 */

/** Coarse classification of what the link can deliver. */
export type NetworkGrade = 'fast' | 'good' | 'slow' | 'poor' | 'offline';

/** Every streaming knob, derived from the grade in one place. */
export interface StreamingProfile {
  grade: NetworkGrade;
  /** Simultaneous tile requests. */
  concurrency: number;
  /** Deepest zoom the quadtree may refine to. */
  maxZoom: number;
  /**
   * Refinement target: screen pixels per imagery texel. 1 is native
   * resolution; higher is blurrier and cheaper, and each +41% halves the
   * tiles the quadtree has to fetch. See `REFINE_TEXELS`.
   */
  screenSpaceError: number;
  /** How far ahead of the aircraft to warm the cache, seconds. 0 disables. */
  prefetchSeconds: number;
  /** Per-request timeout, ms. A slow link needs patience, not more retries. */
  timeoutMs: number;
  /** Two or three words for the status bar. */
  label: string;
  /** One plain sentence explaining what the user will see. */
  advice: string;
}

/**
 * Profiles, worst to best.
 *
 * ## Concurrency, and why these numbers are so much smaller than they were
 *
 * They used to be 128 / 72 / 28 / 10, on the reasoning that HTTP/2 lifts the
 * six-connections-per-host limit so more streams must mean more throughput.
 * The first half is true and the conclusion does not follow. Streams to one
 * host share one connection, so what fills the pipe is the bandwidth-delay
 * product divided by the size of a tile — past that, extra streams add
 * queueing at the far end and nothing else.
 *
 * Measured against the real imagery host on a 5G tether, 24 tiles a run:
 *
 * | in flight | throughput | median tile |
 * |-----------|------------|-------------|
 * | 1         | 183 kB/s   |  93 ms      |
 * | 6         | 659 kB/s   | 133 ms      |
 * | 16        | 763 kB/s   | 244 ms      |
 * | 40        | 762 kB/s   | 377 ms      |
 *
 * The link is full somewhere around twelve. Everything past that bought zero
 * extra bytes and cost 1.5x the per-tile latency, and per-tile latency is not
 * cosmetic here: a tile that takes 377 ms instead of 244 is a tile the camera
 * may have flown past before it lands, which is then abandoned and re-fetched
 * — congestion manufacturing more demand.
 *
 * So these follow the bandwidth-delay product for a ~16 kB tile at each
 * grade's assumed capacity and round trip, rounded up for jitter and for the
 * 404-and-fall-through to a second provider. `fast` assumes fibre, where the
 * same arithmetic genuinely does allow thirty.
 *
 * The old numbers were not arbitrary — they were compensating for a quadtree
 * that demanded sixty-four times the tiles it could show (see `REFINE_TEXELS`)
 * and so always had hundreds queued. With the demand honest, the queue runs
 * at zero and the pipe is what needs filling, not the backlog.
 */
const PROFILES: Record<NetworkGrade, Omit<StreamingProfile, 'grade'>> = {
  fast: {
    concurrency: 32,
    // 19 is Esri's own ceiling, and the ceiling only ever binds near the
    // ground: the screen-space error stops refining as soon as the imagery
    // reaches one pixel per texel, which at cruise happens around zoom 13.
    // Capping at 18 therefore cost nothing in the air and left the last
    // visible level blurry on approach and on the ground, which is where the
    // detail is being looked at hardest.
    maxZoom: 19,
    screenSpaceError: 1,
    prefetchSeconds: 120,
    timeoutMs: 12_000,
    label: 'Link: strong',
    advice: 'Full detail — terrain streams at maximum resolution.',
  },
  good: {
    concurrency: 20,
    maxZoom: 18,
    screenSpaceError: 1.15,
    prefetchSeconds: 90,
    timeoutMs: 14_000,
    label: 'Link: good',
    advice: 'Full detail, streaming slightly further ahead of the aircraft.',
  },
  slow: {
    concurrency: 12,
    maxZoom: 16,
    screenSpaceError: 1.5,
    prefetchSeconds: 60,
    timeoutMs: 18_000,
    label: 'Link: slow',
    advice: 'Detail reduced so the ground finishes loading instead of stalling.',
  },
  poor: {
    concurrency: 6,
    maxZoom: 14,
    screenSpaceError: 2.2,
    prefetchSeconds: 25,
    timeoutMs: 25_000,
    label: 'Link: weak',
    advice: 'Low detail — the terrain will be soft but complete and smooth.',
  },
  offline: {
    concurrency: 3,
    maxZoom: 13,
    screenSpaceError: 3,
    prefetchSeconds: 0,
    timeoutMs: 8_000,
    label: 'Link: offline',
    advice: 'No connection — showing terrain already stored on this device.',
  },
};

/** Ordered worst-first, so "is this an upgrade?" is an index comparison. */
const GRADE_ORDER: readonly NetworkGrade[] = ['offline', 'poor', 'slow', 'good', 'fast'];

export function gradeRank(grade: NetworkGrade): number {
  return GRADE_ORDER.indexOf(grade);
}

export function profileFor(grade: NetworkGrade): StreamingProfile {
  return { grade, ...PROFILES[grade] };
}

/** One completed (or failed) transfer. */
export interface TransferSample {
  /** Wall-clock duration of the request, ms. */
  ms: number;
  /** Payload size. 0 for a failure. */
  bytes: number;
  ok: boolean;
  /** True when the failure was a timeout rather than an error status. */
  timedOut?: boolean;
  /** Completion time; injectable so tests need no fake clock. */
  at?: number;
}

/** What `NetworkMonitor.readout()` publishes for the UI and diagnostics. */
export interface NetworkReadout {
  grade: NetworkGrade;
  /** Median request duration over the window, ms. Null before any samples. */
  latencyMs: number | null;
  /** Active round-trip probe, ms. Null until a probe has run. */
  pingMs: number | null;
  /** Bytes per second, measured across the window's wall-clock span. */
  throughputBps: number;
  /** Fraction of requests in the window that failed, 0-1. */
  failureRatio: number;
  /** Requests that ended in a timeout, over the window. */
  timeouts: number;
  samples: number;
  /** True when the browser itself says there is no connection. */
  offline: boolean;
  /** Set when the browser exposes a connection hint we chose to honour. */
  effectiveType: string | null;
  saveData: boolean;
}
