/**
 * Polling and visibility.
 *
 * The regression that motivated most of this: a poll cycle that returned early
 * because the tab was hidden left its spent timer handle in place, and the
 * `visibilitychange` handler only restarts polling when that handle is null.
 * The feed therefore never came back — the app sat at "0 aircraft" until it
 * was reloaded, and nothing in the UI said why.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TrafficClient } from './client';
import type { AdsbProvider } from './providers';
import type { AircraftState, ProviderId, TrafficQuery, TrafficSnapshot } from '@/data/types';

let hidden = false;
const visibilityListeners = new Set<() => void>();

function setHidden(value: boolean): void {
  hidden = value;
  for (const fn of [...visibilityListeners]) fn();
}

function fakeState(hex: string): AircraftState {
  return {
    hex,
    callsign: null,
    lat: 0,
    lon: 0,
    altBaroFt: null,
    altGeomFt: null,
    groundSpeedKt: null,
    trackDeg: null,
    headingDeg: null,
    baroRateFpm: null,
    geomRateFpm: null,
    iasKt: null,
    tasKt: null,
    mach: null,
    rollDeg: null,
    trackRateDegSec: null,
    windDirectionDeg: null,
    windSpeedKt: null,
    oatC: null,
    tatC: null,
    navModes: null,
    navAltitudeFmsFt: null,
    isMlat: false,
    isTisb: false,
    squawk: null,
    category: null,
    emergency: null,
    onGround: false,
    navAltitudeMcpFt: null,
    navHeadingDeg: null,
    navQnhHpa: null,
    seenPosSec: null,
    rssi: null,
    receiverDistanceNm: null,
    source: 'adsb.lol' as ProviderId,
    observedAt: 0,
    fixTime: 0,
  };
}

function fakeProvider(
  id: ProviderId,
  behaviour: () => AircraftState[] | never,
  minIntervalMs = 0,
): AdsbProvider & { calls: number; hexCalls: number } {
  const provider = {
    id,
    label: id,
    homepage: 'https://example.invalid',
    enabled: true,
    maxRadiusNm: 250,
    minIntervalMs,
    calls: 0,
    hexCalls: 0,
    async fetchTraffic() {
      provider.calls++;
      return { states: behaviour(), hints: [] };
    },
    async fetchByHex() {
      provider.hexCalls++;
      return { states: behaviour(), hints: [] };
    },
  };
  return provider as unknown as AdsbProvider & { calls: number; hexCalls: number };
}

const query: TrafficQuery = { lat: 0, lon: 0, radiusNm: 50 };

beforeEach(() => {
  hidden = false;
  visibilityListeners.clear();
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('document', {
    get hidden() {
      return hidden;
    },
    addEventListener: (_type: string, fn: () => void) => visibilityListeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => visibilityListeners.delete(fn),
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TrafficClient polling', () => {
  it('polls repeatedly while the tab is visible', async () => {
    const snapshots: TrafficSnapshot[] = [];
    const provider = fakeProvider('adsb.lol', () => [fakeState('aaa111')]);
    const client = new TrafficClient({ onSnapshot: (s) => snapshots.push(s) }, [provider]);

    client.start(() => query, 2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2100);
    expect(snapshots.length).toBeGreaterThanOrEqual(2);

    client.stop();
  });

  it('stops polling while the tab is hidden', async () => {
    const provider = fakeProvider('adsb.lol', () => [fakeState('aaa111')]);
    const client = new TrafficClient({ onSnapshot: () => undefined }, [provider]);

    client.start(() => query, 2000);
    await vi.advanceTimersByTimeAsync(0);
    const before = provider.calls;

    setHidden(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(provider.calls).toBe(before);

    client.stop();
  });

  /**
   * The regression. Hiding the tab must not be a one-way door.
   */
  it('resumes polling when the tab comes back', async () => {
    const provider = fakeProvider('adsb.lol', () => [fakeState('aaa111')]);
    const client = new TrafficClient({ onSnapshot: () => undefined }, [provider]);

    client.start(() => query, 2000);
    await vi.advanceTimersByTimeAsync(0);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(20_000);
    const whileHidden = provider.calls;

    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls).toBe(whileHidden + 1);

    // And it keeps going, rather than firing once and stalling again.
    await vi.advanceTimersByTimeAsync(2100);
    expect(provider.calls).toBeGreaterThan(whileHidden + 1);

    client.stop();
  });

  /**
   * The same door, closed at the awkward moment: hidden *during* a request,
   * which is the ordering that left the stale handle behind.
   */
  it('resumes after being hidden mid-request', async () => {
    // Initialised to a no-op rather than null: assigned only inside the
    // promise executor, a nullable here narrows to `never` at the call site.
    let release = (): void => undefined;
    const provider = {
      id: 'adsb.lol' as ProviderId,
      label: 'adsb.lol',
      homepage: 'https://example.invalid',
      enabled: true,
      maxRadiusNm: 250,
      minIntervalMs: 0,
      calls: 0,
      async fetchTraffic() {
        provider.calls++;
        await new Promise<void>((r) => {
          release = r;
        });
        return { states: [fakeState('aaa111')], hints: [] };
      },
    } as unknown as AdsbProvider & { calls: number };

    const client = new TrafficClient({ onSnapshot: () => undefined }, [provider]);
    client.start(() => query, 2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls).toBe(1);

    setHidden(true);
    release();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(provider.calls).toBe(1);

    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls).toBe(2);

    client.stop();
  });

  it('stays stopped after stop()', async () => {
    const provider = fakeProvider('adsb.lol', () => [fakeState('aaa111')]);
    const client = new TrafficClient({ onSnapshot: () => undefined }, [provider]);

    client.start(() => query, 2000);
    await vi.advanceTimersByTimeAsync(0);
    client.stop();

    const after = provider.calls;
    await vi.advanceTimersByTimeAsync(30_000);
    setHidden(true);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(provider.calls).toBe(after);
  });

  it('skips the cycle when the caller has no query yet', async () => {
    const provider = fakeProvider('adsb.lol', () => [fakeState('aaa111')]);
    const client = new TrafficClient({ onSnapshot: () => undefined }, [provider]);

    client.start(() => null, 2000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(provider.calls).toBe(0);

    client.stop();
  });
});

describe('TrafficClient provider chain', () => {
  it('falls through to the next provider and then prefers it', async () => {
    const dead = fakeProvider('adsb.lol', () => {
      throw new Error('upstream down');
    });
    const alive = fakeProvider('adsb.fi', () => [fakeState('bbb222')]);

    const snapshots: TrafficSnapshot[] = [];
    const client = new TrafficClient({ onSnapshot: (s) => snapshots.push(s) }, [dead, alive]);

    client.start(() => query, 2000);
    await vi.advanceTimersByTimeAsync(0);

    expect(snapshots[0]?.source).toBe('adsb.fi');

    // Second cycle starts at the one that worked, not back at the dead one.
    const deadCalls = dead.calls;
    await vi.advanceTimersByTimeAsync(2100);
    expect(alive.calls).toBeGreaterThan(1);
    expect(dead.calls).toBe(deadCalls);

    client.stop();
  });

  it('reports every provider it failed on', async () => {
    const failures: string[] = [];
    const a = fakeProvider('adsb.lol', () => {
      throw new Error('boom a');
    });
    const b = fakeProvider('adsb.fi', () => {
      throw new Error('boom b');
    });

    const client = new TrafficClient(
      {
        onSnapshot: () => undefined,
        onAllFailed: (errors) => failures.push([...errors.keys()].sort().join(',')),
      },
      [a, b],
    );

    client.start(() => query, 2000);
    await vi.advanceTimersByTimeAsync(0);

    expect(failures[0]).toBe('adsb.fi,adsb.lol');
    expect(client.health().every((h) => h.status === 'degraded' || h.status === 'down')).toBe(true);

    client.stop();
  });
});

describe('TrafficClient provider politeness', () => {
  /**
   * Regression: the POV by-hex fetch ignored the per-provider floor.
   *
   * In the cockpit this runs every 1.5-4 s on top of the area poll, against
   * the same providers. Without the floor it drove adsb.lol below the
   * sub-3 s threshold its own docs say returns 429 — so this path generated
   * the rate limiting that then throttled the whole feed, and blamed the
   * provider for it.
   */
  it('honours the minimum interval when fetching one aircraft by hex', async () => {
    const provider = fakeProvider('adsb.lol', () => [fakeState('abc123')], 3000);
    const client = new TrafficClient({ onSnapshot: () => undefined }, [provider]);

    await client.fetchAircraft('abc123');
    expect(provider.hexCalls).toBe(1);

    // Immediately again: too soon, so it must be skipped entirely.
    await client.fetchAircraft('abc123');
    expect(provider.hexCalls).toBe(1);
  });

  /** The area poll and the by-hex fetch share one budget, not one each. */
  it('counts the area poll against the same floor', async () => {
    const provider = fakeProvider('adsb.lol', () => [fakeState('abc123')], 3000);
    const client = new TrafficClient({ onSnapshot: () => undefined }, [provider]);

    await client.fetchOnce(query);
    expect(provider.calls).toBe(1);

    await client.fetchAircraft('abc123');
    expect(provider.hexCalls).toBe(0);
  });

  /**
   * Regression: a cycle where every provider was skipped counted as a total
   * failure, so the poll backed off exponentially with nothing having gone
   * wrong and no notice to explain the silence.
   *
   * Observed through the poll cadence, which is the thing the user feels: a
   * provider with a 5 s floor polled every 1 s should still be reached about
   * every 5 s. Under the bug the skipped cycles compounded into a backoff and
   * the feed went quiet for no reason.
   */
  it('does not back off when nothing was attempted', async () => {
    const provider = fakeProvider('adsb.lol', () => [fakeState('abc123')], 5000);
    const client = new TrafficClient({ onSnapshot: () => undefined }, [provider]);

    client.start(() => query, 1000);
    await vi.advanceTimersByTimeAsync(30_000);
    client.stop();

    // ~6 reachable windows in 30 s. Allow slack, but a backed-off client
    // manages only two or three.
    expect(provider.calls).toBeGreaterThanOrEqual(5);
  });
});
