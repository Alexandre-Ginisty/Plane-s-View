/**
 * "Take me somewhere else".
 *
 * The failure modes here are all "it worked on my machine at 14:00 UTC":
 * whether the search survives a region that is asleep, a provider that throws,
 * and a snapshot full of aircraft parked on stands. None of those are
 * reproducible against the live feed, so they are pinned here instead.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AircraftState, TrafficQuery, TrafficSnapshot } from '@/data/types';
import { REGIONS, findRandomAircraft, isWorthFlying } from './shuffle';

function state(overrides: Partial<AircraftState> = {}): AircraftState {
  return {
    hex: 'aaa111',
    callsign: 'TEST1',
    lat: 51.5,
    lon: -0.3,
    altBaroFt: 35_000,
    altGeomFt: 35_200,
    groundSpeedKt: 450,
    trackDeg: 270,
    headingDeg: 268,
    baroRateFpm: 0,
    geomRateFpm: 0,
    onGround: false,
    ...overrides,
  } as AircraftState;
}

const snapshotOf = (aircraft: AircraftState[]): TrafficSnapshot => ({
  aircraft,
  source: 'adsb.lol' as TrafficSnapshot['source'],
  receivedAt: Date.now(),
  latencyMs: 20,
});

/** Deterministic stand-in for Math.random: always the first element. */
const alwaysFirst = (): number => 0;

describe('isWorthFlying', () => {
  it('rejects an aircraft on the ground', () => {
    // Being dropped onto a stand is the worst outcome this button has: nothing
    // moves, and a parked aircraft transmits so rarely that the POV session
    // times out and throws you back to the map a few seconds later.
    expect(isWorthFlying(state({ onGround: true }))).toBe(false);
  });

  it('rejects something taxiing that has not set the ground bit', () => {
    expect(isWorthFlying(state({ altBaroFt: 0, altGeomFt: null, groundSpeedKt: 12 }))).toBe(false);
  });

  it('rejects an aircraft with no direction to fly in', () => {
    // The whole body frame is built from track or heading. Without either, the
    // aircraft is drawn — and flown — pointing due north wherever it is going.
    expect(isWorthFlying(state({ trackDeg: null, headingDeg: null }))).toBe(false);
  });

  it('accepts an airliner at cruise', () => {
    expect(isWorthFlying(state())).toBe(true);
  });

  it('accepts a light aircraft at low level that is genuinely flying', () => {
    expect(
      isWorthFlying(state({ altBaroFt: 3_000, altGeomFt: null, groundSpeedKt: 110 })),
    ).toBe(true);
  });
});

describe('findRandomAircraft', () => {
  it('walks past regions that are asleep', () => {
    // Europe at 04:00 UTC returns almost nothing while the Gulf is busy.
    // Trusting one region would make the button fail for a third of the day.
    let call = 0;
    const fetchArea = vi.fn(async (_q: TrafficQuery): Promise<TrafficSnapshot | null> => {
      call++;
      return call < 3 ? snapshotOf([]) : snapshotOf([state({ hex: 'found1' })]);
    });

    return findRandomAircraft(fetchArea, { random: alwaysFirst }).then((result) => {
      expect(result?.aircraft.hex).toBe('found1');
      expect(fetchArea).toHaveBeenCalledTimes(3);
    });
  });

  it('survives a provider that throws', async () => {
    let call = 0;
    const fetchArea = async (): Promise<TrafficSnapshot | null> => {
      if (++call === 1) throw new Error('network down');
      return snapshotOf([state({ hex: 'found2' })]);
    };

    const result = await findRandomAircraft(fetchArea, { random: alwaysFirst });
    expect(result?.aircraft.hex).toBe('found2');
  });

  it('never returns the aircraft already being flown', async () => {
    const fetchArea = async (): Promise<TrafficSnapshot | null> =>
      snapshotOf([state({ hex: 'current' }), state({ hex: 'other' })]);

    const result = await findRandomAircraft(fetchArea, {
      random: alwaysFirst,
      excludeHex: 'current',
    });
    expect(result?.aircraft.hex).toBe('other');
  });

  it('gives up rather than hammering every region on Earth', async () => {
    // A dead feed should cost a handful of requests and one honest message,
    // not twenty-five timeouts in a row.
    const fetchArea = vi.fn(async (): Promise<TrafficSnapshot | null> => null);

    expect(await findRandomAircraft(fetchArea, { random: alwaysFirst })).toBeNull();
    expect(fetchArea.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('searches a different place each time', async () => {
    // With the real Math.random, two consecutive calls must not both start in
    // the London TMA — a "take me somewhere else" that always goes to the same
    // somewhere is the bug the name makes most obvious.
    const seen = new Set<string>();
    const fetchArea = async (q: TrafficQuery): Promise<TrafficSnapshot | null> => {
      seen.add(`${q.lat},${q.lon}`);
      return snapshotOf([state()]);
    };

    for (let i = 0; i < 12; i++) await findRandomAircraft(fetchArea);
    expect(seen.size).toBeGreaterThan(3);
  });

  it('spans every longitude band, so some region is always in daylight', () => {
    // The list is the feature. If it ever collapses onto one continent the
    // button silently stops working for most of the day.
    const east = REGIONS.filter((r) => r.lon > 60).length;
    const west = REGIONS.filter((r) => r.lon < -30).length;
    const middle = REGIONS.filter((r) => r.lon >= -30 && r.lon <= 60).length;

    expect(east).toBeGreaterThanOrEqual(4);
    expect(west).toBeGreaterThanOrEqual(4);
    expect(middle).toBeGreaterThanOrEqual(4);
    expect(REGIONS.some((r) => r.lat < 0)).toBe(true);
  });
});
