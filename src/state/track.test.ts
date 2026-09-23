/**
 * Track geometry.
 *
 * The filter works in a local tangent plane that is re-centred whenever the
 * aircraft strays too far from its anchor. That re-centring is the one place
 * the track touches raw longitude arithmetic, and raw longitude arithmetic is
 * where the antimeridian bites.
 */

import { describe, expect, it } from 'vitest';

import { AircraftTrack } from './track';
import type { AircraftState, ProviderId } from '@/data/types';

const T0 = 1_700_000_000_000;

function state(over: Partial<AircraftState> & { hex: string }): AircraftState {
  return {
    callsign: null,
    lat: 0,
    lon: 179,
    altBaroFt: 35_000,
    altGeomFt: 35_000,
    groundSpeedKt: 480,
    trackDeg: 90,
    headingDeg: 90,
    baroRateFpm: 0,
    geomRateFpm: 0,
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
    observedAt: T0,
    fixTime: T0,
    ...over,
  };
}

describe('AircraftTrack across the antimeridian', () => {
  /**
   * Re-anchoring used a raw longitude subtraction where `toLocal` had always
   * taken the short way round. Crossing 180° made that difference exactly
   * 360°, which put ~40 000 km into the filter's east offset.
   *
   * Honest note: this was latent, not visible. A full turn is the one error
   * that survives `wrapLongitude` unchanged, and the next measurement pulls
   * the estimate straight back, so no assertion here fails on the old code —
   * verified by running this test against it. It is fixed because the state
   * was genuinely wrong and the next consumer to read it without wrapping
   * would have found out the hard way. What this test does pin is that a
   * crossing stays continuous at all, which is worth having either way.
   */
  it('keeps the position sane when the anchor moves over 180°', () => {
    const track = new AircraftTrack(state({ hex: 'abc123' }));

    // Fly east far enough past the anchor to force a re-anchor, then cross.
    let lon = 179;
    let t = T0;
    for (let i = 0; i < 40; i++) {
      t += 60_000;
      lon += 0.5;
      const wrapped = lon > 180 ? lon - 360 : lon;
      track.update(state({ hex: 'abc123', lon: wrapped, fixTime: t, observedAt: t }));

      const sample = track.sampleAt(t, 0.1);
      // Never more than a degree from where the feed actually put it,
      // measured the short way round.
      const delta = Math.abs(((sample.lon - wrapped + 540) % 360) - 180);
      expect(delta).toBeLessThan(1);
      expect(Number.isFinite(sample.lat)).toBe(true);
      expect(Math.abs(sample.lat)).toBeLessThanOrEqual(90);
    }
  });
});
