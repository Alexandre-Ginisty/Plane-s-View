/**
 * Traffic client: provider fallback, polling and health reporting.
 *
 * Policy in one paragraph — walk the provider chain in the brief's order,
 * skipping anything disabled or behind an open circuit breaker, and return the
 * first success. Remember which provider worked and start there next time, so
 * a healthy feed is not re-probed through three dead ones every cycle. Back
 * off on repeated failure, pause entirely when the tab is hidden, and never
 * run two polls at once.
 */

import { CircuitBreaker, HttpError } from '@/data/http';
import type { AircraftState, ProviderId, TrafficQuery, TrafficSnapshot } from '@/data/types';
import type { InlineAirframeHint } from './normalize';
import { PROVIDERS, type AdsbProvider } from './providers';

export interface ProviderHealth {
  id: ProviderId;
  label: string;
  homepage: string;
  enabled: boolean;
  disabledReason: string | null;
  /** Circuit state, for the status dot in the UI. */
  status: 'ok' | 'degraded' | 'down' | 'disabled' | 'untried';
  lastLatencyMs: number | null;
  lastError: string | null;
  lastSuccessAt: number | null;
  aircraftLastSeen: number | null;
  retryInMs: number;
}

/** Where the poll gets its areas from. */
export interface QuerySource {
  /** The next area to fetch, or null to skip. Called once per request. */
  next(): TrafficQuery | null;
  /** How many areas the current view needs; more than one means a sweep. */
  readonly cellCount: number;
}

export interface TrafficClientEvents {
  onSnapshot(snapshot: TrafficSnapshot): void;
  onHints?(hints: InlineAirframeHint[]): void;
  onHealth?(health: ProviderHealth[]): void;
  /** Fired when every provider in the chain failed. */
  onAllFailed?(errors: Map<ProviderId, string>): void;
}

interface ProviderRuntime {
  provider: AdsbProvider;
  breaker: CircuitBreaker;
  lastRequestAt: number;
  lastLatencyMs: number | null;
  lastError: string | null;
  lastSuccessAt: number | null;
  aircraftLastSeen: number | null;
}

const MIN_POLL_MS = 1500;
const MAX_POLL_MS = 30_000;

export class TrafficClient {
  private readonly runtimes: ProviderRuntime[];
  /** Index of the provider that last worked — tried first next time. */
  private preferred = 0;
  private inFlight: AbortController | null = null;
  private timer: number | null = null;
  private running = false;
  private consecutiveTotalFailures = 0;
  private readonly onVisibility = () => this.handleVisibilityChange();

  constructor(
    private readonly events: TrafficClientEvents,
    providers: readonly AdsbProvider[] = PROVIDERS,
  ) {
    this.runtimes = providers.map((provider) => ({
      provider,
      breaker: new CircuitBreaker(provider.id),
      lastRequestAt: 0,
      lastLatencyMs: null,
      lastError: null,
      lastSuccessAt: null,
      aircraftLastSeen: null,
    }));
  }

  /** Providers to try, preferred-first, then the rest in declared order. */
  private *chain(): Generator<ProviderRuntime> {
    const n = this.runtimes.length;
    for (let i = 0; i < n; i++) {
      const rt = this.runtimes[(this.preferred + i) % n];
      if (rt) yield rt;
    }
  }

  /**
   * One pass over the chain. Resolves with the first provider that answers, or
   * null when all of them fail. Never throws for provider reasons — only for a
   * caller-initiated abort.
   */
  async fetchOnce(query: TrafficQuery, signal?: AbortSignal): Promise<TrafficSnapshot | null> {
    const errors = new Map<ProviderId, string>();
    const now = Date.now();
    let empty: TrafficSnapshot | null = null;

    for (const rt of this.chain()) {
      if (!this.isReady(rt, now)) continue;
      // A metered fallback is for when the feeds are down, not quiet.
      if (empty && rt.provider.fallbackOnly) continue;

      const started = performance.now();
      rt.lastRequestAt = Date.now();

      try {
        const snapshot = await this.request(rt, query, started, signal);
        this.consecutiveTotalFailures = 0;

        /*
         * An empty answer is not the end of the chain.
         *
         * The feeds are volunteer receiver networks and they do not overlap:
         * over much of Africa, South America or central Asia one of them has
         * a receiver where the other has none. Stopping at the first provider
         * that *answered* meant stopping at the first one that said "nothing
         * here", which is how whole regions came to look empty.
         */
        if (snapshot.aircraft.length === 0) {
          empty ??= snapshot;
          continue;
        }

        // Stick with whatever just found traffic.
        this.preferred = this.runtimes.indexOf(rt);
        return snapshot;
      } catch (err) {
        if (signal?.aborted) throw err;
        errors.set(rt.provider.id, this.recordError(rt, err, started));
      }
    }

    if (empty) return empty;

    // Only a real attempt can fail.
    //
    // Reaching here with an empty `errors` map means every provider was
    // skipped — by its politeness floor or an open breaker — so nothing was
    // tried and nothing failed. Counting that as a failure backed the poll
    // off exponentially with no cause and no notice to explain it, which is
    // reachable whenever a visibility change restarts the tick shortly after
    // a poll.
    if (errors.size > 0) {
      this.consecutiveTotalFailures++;
      this.emitHealth();
      this.events.onAllFailed?.(errors);
    }
    return null;
  }

  /** Enabled, breaker closed, and past its politeness floor. */
  private isReady(rt: ProviderRuntime, now: number): boolean {
    return (
      rt.provider.enabled &&
      rt.breaker.allowsRequest(now) &&
      now - rt.lastRequestAt >= rt.provider.minIntervalMs
    );
  }

  /** One request to one provider, with its bookkeeping. Throws on failure. */
  private async request(
    rt: ProviderRuntime,
    query: TrafficQuery,
    started: number,
    signal?: AbortSignal,
  ): Promise<TrafficSnapshot> {
    const result = await rt.provider.fetchTraffic(query, signal);
    const latency = performance.now() - started;

    rt.breaker.recordSuccess();
    rt.lastLatencyMs = latency;
    rt.lastError = null;
    rt.lastSuccessAt = Date.now();
    rt.aircraftLastSeen = result.states.length;

    if (result.hints.length > 0) this.events.onHints?.(result.hints);
    this.emitHealth();

    return {
      aircraft: result.states,
      source: rt.provider.id,
      receivedAt: rt.lastSuccessAt,
      latencyMs: latency,
    };
  }

  /** Feed a failure to the breaker. Returns the message recorded. */
  private recordError(rt: ProviderRuntime, err: unknown, started: number): string {
    if (err instanceof HttpError && err.isRateLimit) {
      // Back off hard rather than keep knocking.
      rt.breaker.recordRateLimit(err.retryAfterMs);
    } else {
      rt.breaker.recordFailure();
    }
    rt.lastError = err instanceof Error ? err.message : String(err);
    rt.lastLatencyMs = performance.now() - started;
    return rt.lastError;
  }

  /**
   * Begin polling.
   *
   * `source` is asked for a query once per request, so the caller can follow
   * the camera without restarting the client; returning null skips the cycle
   * (nothing selected, map not ready). A plain function is one fixed area; a
   * `QuerySource` with several cells is swept, one cell per request.
   */
  start(source: QuerySource | (() => TrafficQuery | null), intervalMs = 3000): void {
    if (this.running) return;
    this.running = true;
    this.baseIntervalMs = Math.max(MIN_POLL_MS, intervalMs);
    this.source = typeof source === 'function' ? { next: source, cellCount: 1 } : source;
    document.addEventListener('visibilitychange', this.onVisibility);
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inFlight?.abort();
    this.inFlight = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private baseIntervalMs = 3000;
  private source: QuerySource = { next: () => null, cellCount: 1 };

  private handleVisibilityChange(): void {
    if (!this.running) return;
    if (document.hidden) {
      // A background tab still costs the upstream service bandwidth.
      this.inFlight?.abort();
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    } else if (this.timer === null) {
      void this.tick();
    }
  }

  private async tick(): Promise<void> {
    // Cleared first, always.
    //
    // `timer` means "a cycle is pending", and `handleVisibilityChange` only
    // restarts polling when it is null. A tick that returned early while the
    // tab was hidden used to leave the *spent* handle in place, so the feed
    // looked scheduled for ever and never resumed when the tab came back — the
    // symptom being an app that shows zero aircraft until it is reloaded.
    this.timer = null;
    if (!this.running || document.hidden) return;

    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      await this.sweep(controller.signal);
    } catch {
      // Aborted by a newer cycle or by stop(); nothing to report.
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }

    // Hidden again while that request was in flight: leave `timer` null so the
    // next `visibilitychange` restarts polling at once instead of waiting out
    // a cycle that would only return early anyway.
    if (!this.running || document.hidden) return;
    this.timer = self.setTimeout(() => void this.tick(), this.nextDelayMs());
  }

  /**
   * One cycle: every provider that is ready gets a request of its own.
   *
   * The providers are separate receiver networks, so asking each of them is
   * what fills the gaps either one has alone — the tracker merges the
   * reports by aircraft and fix time, so an aircraft both of them hear is
   * simply heard twice. Each provider still keeps its own politeness floor;
   * this changes who is asked, not how often any one of them is.
   *
   * With several cells, each request takes the next cell, so the view is
   * swept and consecutive cycles hand every cell to a different network.
   */
  private async sweep(signal: AbortSignal): Promise<void> {
    const now = Date.now();
    const primaries = [...this.chain()].filter(
      (rt) => rt.provider.enabled && !rt.provider.fallbackOnly && rt.breaker.allowsRequest(now),
    );

    // Every sweeping provider is down: walk the whole chain, fallbacks
    // included, for one area — the old behaviour, kept for exactly this case.
    if (primaries.length === 0) {
      const query = this.source.next();
      const snapshot = query ? await this.fetchOnce(query, signal) : null;
      if (snapshot) this.events.onSnapshot(snapshot);
      return;
    }

    const ready = primaries.filter((rt) => this.isReady(rt, now));
    if (ready.length === 0) return;

    const errors = new Map<ProviderId, string>();
    let attempted = 0;
    let succeeded = 0;

    await Promise.all(
      ready.map(async (rt) => {
        const query = this.source.next();
        if (!query) return;
        attempted++;
        const started = performance.now();
        rt.lastRequestAt = Date.now();
        try {
          const snapshot = await this.request(rt, query, started, signal);
          succeeded++;
          if (snapshot.aircraft.length > 0) this.preferred = this.runtimes.indexOf(rt);
          this.events.onSnapshot(snapshot);
        } catch (err) {
          if (signal.aborted) throw err;
          errors.set(rt.provider.id, this.recordError(rt, err, started));
        }
      }),
    );

    if (succeeded > 0) {
      this.consecutiveTotalFailures = 0;
    } else if (attempted > 0 && errors.size > 0) {
      // Only a real attempt can fail — see `fetchOnce`.
      this.consecutiveTotalFailures++;
      this.emitHealth();
      this.events.onAllFailed?.(errors);
    }
  }

  /** Exponential backoff while the whole chain is down, capped. */
  private nextDelayMs(): number {
    if (this.consecutiveTotalFailures === 0) {
      if (this.source.cellCount <= 1) return this.baseIntervalMs;
      // Sweeping: come back as soon as the quickest provider may be asked
      // again. The floors, not this timer, set the actual request rate.
      const floors = this.runtimes
        .filter((rt) => rt.provider.enabled && !rt.provider.fallbackOnly)
        .map((rt) => rt.provider.minIntervalMs);
      return Math.max(MIN_POLL_MS, Math.min(this.baseIntervalMs, ...floors));
    }
    const backoff = this.baseIntervalMs * 2 ** Math.min(this.consecutiveTotalFailures, 4);
    return Math.min(MAX_POLL_MS, backoff) * (0.85 + Math.random() * 0.3);
  }

  health(): ProviderHealth[] {
    const now = Date.now();
    return this.runtimes.map((rt) => {
      const { provider, breaker } = rt;
      let status: ProviderHealth['status'];
      if (!provider.enabled) status = 'disabled';
      else if (breaker.isOpen) status = 'down';
      else if (rt.lastError) status = 'degraded';
      else if (rt.lastSuccessAt) status = 'ok';
      else status = 'untried';

      return {
        id: provider.id,
        label: provider.label,
        homepage: provider.homepage,
        enabled: provider.enabled,
        disabledReason: provider.disabledReason ?? null,
        status,
        lastLatencyMs: rt.lastLatencyMs,
        lastError: rt.lastError,
        lastSuccessAt: rt.lastSuccessAt,
        aircraftLastSeen: rt.aircraftLastSeen,
        retryInMs: breaker.retryAfterMs(now),
      };
    });
  }

  private emitHealth(): void {
    this.events.onHealth?.(this.health());
  }

  /**
   * Fetch a single aircraft by ICAO hex, anywhere in the world. Used by POV
   * mode so the followed aircraft keeps updating after it leaves the viewport
   * query circle.
   */
  async fetchAircraft(hex: string, signal?: AbortSignal): Promise<AircraftState | null> {
    const now = Date.now();

    for (const rt of this.chain()) {
      const { provider, breaker } = rt;
      if (!provider.enabled || !provider.fetchByHex) continue;
      if (!breaker.allowsRequest(now)) continue;
      // Same politeness floor as the area poll, and for the same reason.
      //
      // In POV mode this runs every 1.5-4 s on top of the 4 s area poll
      // against the same providers. Skipping the floor here drove adsb.lol
      // below the sub-3 s threshold its own docs warn returns 429 — this
      // path was generating the rate limiting that then throttled the whole
      // feed. The shared `lastRequestAt` is what makes the two callers add
      // up rather than each politely pace itself in isolation.
      if (now - rt.lastRequestAt < provider.minIntervalMs) continue;
      rt.lastRequestAt = Date.now();

      try {
        const result = await provider.fetchByHex(hex, signal);
        breaker.recordSuccess();
        if (result.hints.length > 0) this.events.onHints?.(result.hints);
        const match = result.states.find((s) => s.hex === hex);
        if (match) return match;
      } catch (err) {
        if (signal?.aborted) throw err;
        // A 429 means back off, not "this provider is broken" — treating it
        // as an ordinary failure needed three strikes to open the breaker
        // while the poll kept knocking.
        if (err instanceof HttpError && err.isRateLimit) breaker.recordRateLimit(err.retryAfterMs);
        else breaker.recordFailure();
      }
    }
    return null;
  }
}
