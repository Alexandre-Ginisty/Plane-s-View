import { describe, expect, it } from 'vitest';
import {
  feedClockToMs,
  normalizeReadsbResponse,
  usableFeedClock,
  type ReadsbResponse,
} from './normalize';

/**
 * Timestamps captured from the live services on 2026-09-22. The units differ
 * between providers and nothing in the payload says so, which is exactly the
 * trap this suite exists to keep shut.
 */
const ADSB_LOL_NOW_MS = 1790080770002;
const ADSB_FI_NOW_SEC = 1790080986;

const aircraftFixture = {
  hex: '391d49',
  flight: 'FGHKJ   ',
  r: 'F-GHKJ',
  t: 'P28A',
  alt_baro: 4500,
  alt_geom: 5125,
  gs: 124.1,
  track: 268.15,
  geom_rate: 128,
  squawk: '7040',
  emergency: 'none',
  category: 'A1',
  lat: 48.765427,
  lon: -0.650236,
  seen_pos: 1.2,
  rssi: -21.4,
  dst: 33.1,
};

describe('feed clock units', () => {
  it('reads adsb.lol milliseconds unchanged', () => {
    expect(feedClockToMs(ADSB_LOL_NOW_MS)).toBe(ADSB_LOL_NOW_MS);
  });

  it('promotes adsb.fi seconds to milliseconds', () => {
    expect(feedClockToMs(ADSB_FI_NOW_SEC)).toBe(ADSB_FI_NOW_SEC * 1000);
  });

  it('puts both providers at the same instant', () => {
    const lol = feedClockToMs(ADSB_LOL_NOW_MS)!;
    const fi = feedClockToMs(ADSB_FI_NOW_SEC)!;
    // The two captures were seconds apart in reality.
    expect(Math.abs(lol - fi)).toBeLessThan(5 * 60_000);
  });

  it('rejects junk', () => {
    expect(feedClockToMs(0)).toBeNull();
    expect(feedClockToMs(-5)).toBeNull();
    expect(feedClockToMs('nope')).toBeNull();
    expect(feedClockToMs(undefined)).toBeNull();
    expect(feedClockToMs(Number.NaN)).toBeNull();
  });

  it('falls back to local time when the feed clock is implausible', () => {
    const receivedAt = ADSB_LOL_NOW_MS;
    expect(usableFeedClock(receivedAt - 1000, receivedAt)).toBe(receivedAt - 1000);
    // A clock an hour out is not usable.
    expect(usableFeedClock(receivedAt - 3_600_000, receivedAt)).toBeNull();
  });
});

describe('normalizeReadsbResponse', () => {
  it('reads the adsb.lol shape (ac, milliseconds)', () => {
    const body: ReadsbResponse = { ac: [aircraftFixture], now: ADSB_LOL_NOW_MS };
    const { states } = normalizeReadsbResponse(body, 'adsb.lol', ADSB_LOL_NOW_MS);
    expect(states).toHaveLength(1);
    expect(states[0]!.hex).toBe('391d49');
  });

  it('reads the adsb.fi shape (aircraft, seconds)', () => {
    const receivedAt = ADSB_FI_NOW_SEC * 1000;
    const body: ReadsbResponse = { aircraft: [aircraftFixture], now: ADSB_FI_NOW_SEC };
    const { states } = normalizeReadsbResponse(body, 'adsb.fi', receivedAt);
    expect(states).toHaveLength(1);
  });

  /**
   * The regression that mattered: a seconds clock read as milliseconds dated
   * every aircraft to January 1970, so the staleness pruner deleted the whole
   * fleet on the tick it arrived. The feed returned 200 with hundreds of
   * aircraft and the map stayed empty.
   */
  it('dates aircraft to now, not to 1970, whichever unit the feed uses', () => {
    for (const [now, receivedAt] of [
      [ADSB_LOL_NOW_MS, ADSB_LOL_NOW_MS],
      [ADSB_FI_NOW_SEC, ADSB_FI_NOW_SEC * 1000],
    ] as const) {
      const key = now === ADSB_FI_NOW_SEC ? 'aircraft' : 'ac';
      const body = { [key]: [aircraftFixture], now } as ReadsbResponse;
      const { states } = normalizeReadsbResponse(body, 'adsb.fi', receivedAt);

      const ageSeconds = (receivedAt - states[0]!.fixTime) / 1000;
      expect(ageSeconds).toBeGreaterThanOrEqual(0);
      // Well inside the 120 s drop threshold.
      expect(ageSeconds).toBeLessThan(10);
    }
  });

  it('survives a feed with no clock at all', () => {
    const receivedAt = Date.now();
    const { states } = normalizeReadsbResponse(
      { ac: [aircraftFixture] },
      'adsb.lol',
      receivedAt,
    );
    expect((receivedAt - states[0]!.fixTime) / 1000).toBeLessThan(10);
  });

  it('maps r to registration and t to type code', () => {
    const { hints } = normalizeReadsbResponse(
      { ac: [aircraftFixture], now: ADSB_LOL_NOW_MS },
      'adsb.lol',
      ADSB_LOL_NOW_MS,
    );
    expect(hints[0]).toEqual({ hex: '391d49', registration: 'F-GHKJ', typeCode: 'P28A' });
  });

  it('drops positionless and Null Island records', () => {
    const { states } = normalizeReadsbResponse(
      {
        ac: [
          { hex: 'aaaaaa' },
          { hex: 'bbbbbb', lat: 0, lon: 0 },
          { hex: 'cccccc', lat: 200, lon: 5 },
          aircraftFixture,
        ],
        now: ADSB_LOL_NOW_MS,
      },
      'adsb.lol',
      ADSB_LOL_NOW_MS,
    );
    expect(states).toHaveLength(1);
  });

  it('treats "ground" altitude as on-ground at zero feet', () => {
    const { states } = normalizeReadsbResponse(
      { ac: [{ ...aircraftFixture, alt_baro: 'ground' }], now: ADSB_LOL_NOW_MS },
      'adsb.lol',
      ADSB_LOL_NOW_MS,
    );
    expect(states[0]!.onGround).toBe(true);
    expect(states[0]!.altBaroFt).toBe(0);
  });

  it('does not report "none" as an emergency', () => {
    const { states } = normalizeReadsbResponse(
      { ac: [aircraftFixture], now: ADSB_LOL_NOW_MS },
      'adsb.lol',
      ADSB_LOL_NOW_MS,
    );
    expect(states[0]!.emergency).toBeNull();
  });
});
