/**
 * Resilient fetch for public, keyless, best-effort APIs.
 *
 * Every endpoint this app talks to is a free community service. They go down,
 * they rate-limit, they occasionally return HTML error pages with a 200. The
 * job here is to fail *fast and quietly* so the provider chain can move on,
 * never to hammer a struggling service.
 */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    /** Parsed `Retry-After`, ms. Only ever set on a 429 or 503. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }

  /** 5xx and 429 are worth retrying; 4xx generally is not. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 408;
  }
}

export class TimeoutError extends Error {
  constructor(readonly url: string, readonly timeoutMs: number) {
    super(`Request to ${url} exceeded ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

export interface FetchOptions {
  /** Per-attempt timeout in ms. Default 8000. */
  timeoutMs?: number;
  /** Extra attempts after the first. Default 1. */
  retries?: number;
  /** Base backoff in ms, grown exponentially and jittered. Default 400. */
  backoffMs?: number;
  /** Caller-owned cancellation, composed with the internal timeout. */
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Passed straight through; used to opt tiles into the HTTP cache. */
  cache?: RequestCache;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });

/**
 * Compose the caller's signal with a fresh timeout.
 * `AbortSignal.any` is available everywhere we target, but guard anyway so a
 * missing implementation degrades to "timeout only" rather than throwing.
 */
function attemptSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, external]);
  return external.aborted ? external : timeout;
}

/** `Retry-After` is either delay-seconds or an HTTP date. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Raw fetch with timeout + retry. Returns the `Response` untouched. */
export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 8000, retries = 1, backoffMs = 400, signal, headers, cache } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');

    try {
      const res = await fetch(url, {
        signal: attemptSignal(timeoutMs, signal),
        headers: { Accept: 'application/json', ...headers },
        // These APIs are public and must never receive credentials.
        credentials: 'omit',
        mode: 'cors',
        redirect: 'follow',
        ...(cache ? { cache } : {}),
      });

      if (!res.ok) {
        const err = new HttpError(
          `HTTP ${res.status} from ${url}`,
          res.status,
          url,
          parseRetryAfter(res.headers.get('Retry-After')),
        );
        if (!err.retryable || attempt === retries) throw err;
        lastError = err;
      } else {
        return res;
      }
    } catch (err) {
      // A caller-initiated abort is not a failure to retry around.
      if (signal?.aborted) throw err;
      if (isAbort(err)) {
        lastError = new TimeoutError(url, timeoutMs);
      } else {
        lastError = err;
      }
      if (attempt === retries) break;
    }

    // Full jitter: spreads retries from many tabs instead of synchronising them.
    const backoff = backoffMs * 2 ** attempt;
    await sleep(Math.random() * backoff, signal);
  }

  throw lastError ?? new Error(`Request to ${url} failed`);
}

/**
 * Fetch and parse JSON. Guards against the common free-API failure of a 200
 * that carries an HTML error page, which would otherwise surface as a cryptic
 * `SyntaxError` far from the cause.
 */
export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, opts);
  const text = await res.text();

  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, ' ');
    throw new HttpError(`Non-JSON response from ${url}: "${preview}"`, res.status, url);
  }
}

/**
 * Circuit breaker.
 *
 * After `failureThreshold` consecutive failures a provider is considered down
 * and is skipped entirely for `cooldownMs`, rather than costing every poll
 * cycle a timeout. One probe is allowed through when the cooldown expires; a
 * success closes the circuit, a failure re-opens it with a longer cooldown.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt = 0;
  private openCount = 0;

  constructor(
    readonly name: string,
    private readonly failureThreshold = 3,
    private readonly baseCooldownMs = 30_000,
    private readonly maxCooldownMs = 5 * 60_000,
  ) {}

  private get cooldownMs(): number {
    if (this.forcedCooldownMs !== null) {
      return Math.min(Math.max(this.forcedCooldownMs, this.baseCooldownMs), this.maxCooldownMs);
    }
    return Math.min(this.baseCooldownMs * 2 ** Math.max(0, this.openCount - 1), this.maxCooldownMs);
  }

  /** True when requests should be attempted (closed, or probing). */
  allowsRequest(now = Date.now()): boolean {
    if (this.consecutiveFailures < this.failureThreshold) return true;
    return now - this.openedAt >= this.cooldownMs;
  }

  get isOpen(): boolean {
    return this.consecutiveFailures >= this.failureThreshold;
  }

  /** Ms until the next probe is allowed; 0 when the circuit is usable now. */
  retryAfterMs(now = Date.now()): number {
    if (!this.isOpen) return 0;
    return Math.max(0, this.cooldownMs - (now - this.openedAt));
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openCount = 0;
    this.forcedCooldownMs = null;
  }

  /**
   * Open the circuit immediately for a stated period.
   *
   * A 429 is not an outage to be probed around — it is the service telling us
   * we are asking too often. Treating it like an ordinary failure would let
   * two more requests through before the threshold tripped, which is exactly
   * the wrong response. `Retry-After` is honoured when supplied.
   */
  recordRateLimit(retryAfterMs: number | null, now = Date.now()): void {
    this.consecutiveFailures = Math.max(this.consecutiveFailures + 1, this.failureThreshold);
    this.openedAt = now;
    this.openCount = Math.max(this.openCount, 1);
    if (retryAfterMs !== null) this.forcedCooldownMs = retryAfterMs;
  }

  private forcedCooldownMs: number | null = null;

  recordFailure(now = Date.now()): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures === this.failureThreshold) {
      this.openCount++;
      this.openedAt = now;
    } else if (this.consecutiveFailures > this.failureThreshold) {
      // Probe failed: restart the (now longer) cooldown.
      this.openCount++;
      this.openedAt = now;
    }
  }
}
