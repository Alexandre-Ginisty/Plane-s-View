/**
 * Traffic store tests.
 *
 * The properties pinned here are the ones the cockpit view depends on: the
 * aircraft you are sitting in must survive a coverage gap, must not be yanked
 * around by a bad fix, and must not have a trajectory invented for it once the
 * feed has been silent too long to justify one.
 */

import { describe, expect, it } from 'vitest';

import { TrafficStore } from './traffic';
import type { AircraftState, ProviderId, TrafficSnapshot } from '@/data/types';

const T0 = 1_700_000_000_000;

function state(over: Partial<AircraftState> & { hex: string }): AircraftState {
  return {
    callsign: null,
    lat: 48.85,
    lon: 2.35,
    altBaroFt: 35_000,
    altGeomFt: 35_000,
    groundSpeedKt: 450,
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

function snapshot(aircraft: AircraftState[], receivedAt = T0): TrafficSnapshot {
  return { aircraft, source: 'adsb.lol' as ProviderId, receivedAt, latencyMs: 10 };
}

describe('TrafficStore lifecycle', () => {
  it('creates one track per hex and folds later reports into it', () => {
    const store = new TrafficStore();
    store.ingest(snapshot([state({ hex: 'aaa111' }), state({ hex: 'bbb222' })]));
    expect(store.size).toBe(2);
    expect(store.lastNewCount).toBe(2);

    store.ingest(snapshot([state({ hex: 'aaa111', fixTime: T0 + 1000 })]));
    expect(store.size).toBe(2);
    expect(store.lastNewCount).toBe(0);
  });

  it('drops aircraft that have gone quiet', () => {
    const store = new TrafficStore();
    store.ingest(snapshot([state({ hex: 'aaa111' }), state({ hex: 'bbb222' })]));

    expect(store.prune(T0 + 10_000)).toEqual([]);
    expect(store.prune(T0 + 200_000).sort()).toEqual(['aaa111', 'bbb222']);
    expect(store.size).toBe(0);
  });

  /**
   * The aircraft the user is *inside* is exempt.
   *
   * It routinely leaves the viewport query circle — that is the whole reason
   * `fetchAircraft` exists — and without this exemption it would be pruned out
   * from under the cockpit view, which then has nothing to follow.
   */
  it('never prunes a kept aircraft, however long it has been silent', () => {
    const store = new TrafficStore();
    store.ingest(snapshot([state({ hex: 'aaa111' }), state({ hex: 'bbb222' })]));

    const removed = store.prune(T0 + 10_000_000, new Set(['aaa111']));
    expect(removed).toEqual(['bbb222']);
    expect(store.has('aaa111')).toBe(true);
    expect(store.sampleOne('aaa111', T0 + 10_000_000)).not.toBeNull();
  });

  it('reports a miss rather than throwing for an unknown hex', () => {
    expect(new TrafficStore().sampleOne('nope')).toBeNull();
  });
});

describe('AircraftTrack sampling', () => {
  it('advances the aircraft along its track between fixes', () => {
    const store = new TrafficStore();
    store.ingest(snapshot([state({ hex: 'aaa111', trackDeg: 90, groundSpeedKt: 450 })]));

    const at0 = store.sampleOne('aaa111', T0)!;
    const at10 = store.sampleOne('aaa111', T0 + 10_000)!;

    // Due east: longitude climbs, latitude holds.
    expect(at10.lon).toBeGreaterThan(at0.lon);
    expect(at10.lat).toBeCloseTo(at0.lat, 3);
    expect(at10.groundSpeedKt).toBeGreaterThan(400);
  });

  /**
   * Past the extrapolation cap the position must freeze. Continuing to
   * integrate a 450 kt velocity through a ten-minute silence puts the aircraft
   * 75 nm from where it actually is, and the terrain streams to the wrong
   * place.
   */
  it('stops extrapolating once the feed has been silent too long', () => {
    const store = new TrafficStore();
    store.ingest(snapshot([state({ hex: 'aaa111' })]));

    const at60 = store.sampleOne('aaa111', T0 + 60_000)!;
    const at600 = store.sampleOne('aaa111', T0 + 600_000)!;

    expect(at600.lon).toBeCloseTo(at60.lon, 6);
    expect(at600.ageSec).toBeGreaterThan(at60.ageSec);
  });

  it('marks an aircraft stale well before it becomes droppable', () => {
    const store = new TrafficStore();
    store.ingest(snapshot([state({ hex: 'aaa111' })]));

    expect(store.sampleOne('aaa111', T0 + 5_000)!.stale).toBe(false);
    expect(store.sampleOne('aaa111', T0 + 60_000)!.stale).toBe(true);
    // Still present: stale dims it, it does not remove it.
    expect(store.prune(T0 + 60_000)).toEqual([]);
  });

  /**
   * One absurd fix — a transposed digit, a stale receiver — must not teleport
   * the aircraft. Two in a row means our estimate is the wrong one, and the
   * filter re-seeds rather than staying stuck for ever.
   */
  it('rejects a single impossible jump but yields to a sustained one', () => {
    const store = new TrafficStore();
    store.ingest(snapshot([state({ hex: 'aaa111', lat: 48.85, lon: 2.35 })]));
    for (let i = 1; i <= 4; i++) {
      store.ingest(snapshot([state({ hex: 'aaa111', fixTime: T0 + i * 1000 })]));
    }

    const before = store.sampleOne('aaa111', T0 + 4000)!;

    // One wild fix, 500 km away.
    store.ingest(snapshot([state({ hex: 'aaa111', lat: 53.5, lon: 2.35, fixTime: T0 + 5000 })]));
    const afterOne = store.sampleOne('aaa111', T0 + 5000)!;
    expect(Math.abs(afterOne.lat - before.lat)).toBeLessThan(0.5);

    // It keeps saying the same thing: believe it.
    store.ingest(snapshot([state({ hex: 'aaa111', lat: 53.5, lon: 2.35, fixTime: T0 + 6000 })]));
    const afterTwo = store.sampleOne('aaa111', T0 + 6000)!;
    expect(afterTwo.lat).toBeCloseTo(53.5, 1);
  });

  it('ignores an out-of-order fix without corrupting the estimate', () => {
    const store = new TrafficStore();
    store.ingest(snapshot([state({ hex: 'aaa111', fixTime: T0 + 10_000 })]));
    const good = store.sampleOne('aaa111', T0 + 10_000)!;

    store.ingest(snapshot([state({ hex: 'aaa111', lat: 10, lon: 10, fixTime: T0 })]));
    const after = store.sampleOne('aaa111', T0 + 10_000)!;

    expect(after.lat).toBeCloseTo(good.lat, 6);
    expect(after.lon).toBeCloseTo(good.lon, 6);
  });

  /**
   * Geometric altitude is height above the ellipsoid, which is the frame the
   * terrain is drawn in. Trusting barometric altitude instead can bury the
   * camera in a hillside on a low-pressure day.
   */
  it('prefers geometric altitude over barometric', () => {
    const store = new TrafficStore();
    store.ingest(
      snapshot([state({ hex: 'aaa111', altBaroFt: 34_000, altGeomFt: 35_200 })]),
    );
    expect(store.sampleOne('aaa111', T0)!.altFt).toBeCloseTo(35_200, -2);
  });

  it('infers a bank angle from the turn rate when none is broadcast', () => {
    const store = new TrafficStore();
    store.ingest(
      snapshot([state({ hex: 'aaa111', trackRateDegSec: 3, rollDeg: null })]),
    );
    const sample = store.sampleOne('aaa111', T0)!;
    // A standard-rate turn at 450 kt is a real bank, to the right.
    expect(sample.rollDeg).toBeGreaterThan(5);
    expect(sample.rollDeg).toBeLessThanOrEqual(35);
  });

  it('uses the broadcast bank angle in preference to the inferred one', () => {
    const store = new TrafficStore();
    store.ingest(
      snapshot([state({ hex: 'aaa111', trackRateDegSec: 3, rollDeg: -22 })]),
    );
    expect(store.sampleOne('aaa111', T0)!.rollDeg).toBeCloseTo(-22, 5);
  });

  it('keeps a trail and drops near-duplicate fixes from it', () => {
    const store = new TrafficStore();
    store.ingest(snapshot([state({ hex: 'aaa111' })]));
    // Same position, later time: nothing new to record.
    store.ingest(snapshot([state({ hex: 'aaa111', fixTime: T0 + 1000 })]));
    expect(store.get('aaa111')!.trailPoints).toHaveLength(1);

    store.ingest(snapshot([state({ hex: 'aaa111', lon: 2.45, fixTime: T0 + 2000 })]));
    expect(store.get('aaa111')!.trailPoints).toHaveLength(2);
  });

  /** POV mode folds in single reports fetched by hex, outside any snapshot. */
  it('ingests a lone report for an aircraft it has never seen', () => {
    const store = new TrafficStore();
    store.ingestOne(state({ hex: 'ccc333' }));
    expect(store.has('ccc333')).toBe(true);
    store.ingestOne(state({ hex: 'ccc333', fixTime: T0 + 1000 }));
    expect(store.size).toBe(1);
  });
});
