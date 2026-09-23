/**
 * Browser hints about the connection.
 *
 * Injected rather than read directly so the monitor can be driven from a test
 * with no browser at all, and guarded rather than assumed because Safari does
 * not implement `navigator.connection` and the test runner may not have a
 * `navigator` at all. An absent hint is not an error: the passive measurement
 * is the primary signal and these only sharpen it.
 */

/** Browser hints, injected so the monitor is testable outside a browser. */
export interface NetworkEnvironment {
  onLine(): boolean;
  /** `navigator.connection.effectiveType`, when the browser exposes it. */
  effectiveType(): string | null;
  saveData(): boolean;
  now(): number;
}

/**
 * `navigator.connection` where the browser has it.
 *
 * Guarded rather than assumed: Safari does not implement it at all, and this
 * module is also constructed under a test runner where `navigator` may not
 * exist. An absent hint is not an error — the passive measurement is the
 * primary signal and this only sharpens it.
 */
function connectionHint(): { effectiveType?: string; saveData?: boolean } | null {
  if (typeof navigator === 'undefined') return null;
  return (
    (navigator as unknown as { connection?: { effectiveType?: string; saveData?: boolean } })
      .connection ?? null
  );
}

export const browserEnvironment: NetworkEnvironment = {
  onLine: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  effectiveType: () => connectionHint()?.effectiveType ?? null,
  saveData: () => connectionHint()?.saveData === true,
  now: () => Date.now(),
};
