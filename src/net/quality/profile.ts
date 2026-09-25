/**
 * Connection quality monitor and streaming profile.
 *
 * Every streaming constant used to be one number tuned on a good connection:
 * 128 parallel requests, refine to zoom 17, accept 6 px of error. On a weak
 * link those are actively destructive, in a counter-intuitive way:
 *
 * **Asking for more makes you get less.** 128 parallel requests over a 500
 * kB/s link give each 4 kB/s, so a 40 kB tile needs ten seconds and *every*
 * tile misses the 12 s timeout at once; the batch fails together and the retry
 * asks for 128 more. That is the "sol charge pas bien" symptom. With twelve in
 * flight each gets 40 kB/s and the picture fills in ring by ring.
 *
 * Depth is the same. Refining to z17 on a weak link spends the whole pipe four
 * levels below what could finish, so the viewer looks at z11 blur while z17
 * requests time out behind it. A complete coarse picture beats an incomplete
 * sharp one.
 *
 * So this is not a "quality setting" but a statement about what the connection
 * can deliver, and every consumer derives its numbers from it. How it is
 * measured is `monitor.ts`.
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
 * They used to be 128 / 72 / 28 / 10, reasoning that HTTP/2 lifts the
 * six-connections-per-host limit so more streams mean more throughput. The
 * premise is true and the conclusion does not follow: streams to one host
 * share one connection, so what fills the pipe is the bandwidth-delay product
 * divided by the tile size, and past that extra streams only add queueing.
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
 * The link is full around twelve. Past that, zero extra bytes for 1.5x the
 * per-tile latency — and latency is not cosmetic: a tile taking 377 ms instead
 * of 244 may be one the camera flew past before it landed, abandoned and
 * re-fetched, congestion manufacturing more demand.
 *
 * So these follow the bandwidth-delay product for a ~16 kB tile at each grade's
 * assumed capacity and round trip, rounded up for jitter and for the
 * 404-and-fall-through to a second provider. `fast` assumes fibre.
 *
 * The old numbers were compensating for a quadtree demanding sixty-four times
 * the tiles it could show (see `REFINE_TEXELS`), so hundreds were always
 * queued. With the demand honest, the pipe needs filling, not the backlog.
 */
const PROFILES: Record<NetworkGrade, Omit<StreamingProfile, 'grade'>> = {
  fast: {
    concurrency: 32,
    // 19 is Esri's own ceiling, and it only binds near the ground: refinement
    // stops once imagery reaches one pixel per texel, which at cruise is about
    // zoom 13. Capping at 18 cost nothing in the air and left the last visible
    // level blurry on approach, where detail is looked at hardest.
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
