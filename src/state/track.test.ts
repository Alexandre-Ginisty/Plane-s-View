/**
 * Track geometry.
 *
 * The filter works in a local tangent plane that is re-centred whenever the
 * aircraft strays too far from its anchor. That re-centring is the one place
 * the track touches raw longitude arithmetic, and raw longitude arithmetic is
 * where the antimeridian bites.
 */

import { describe, expect, it } from 'vitest';

import { clamp } from '@/core/math/geo';
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

describe('the drawn position never jumps when a report lands', () => {
  /**
   * The complaint was "les avions font des lags quand on les voit en orbit …
   * quand il recharge la position il se tp". It is not the network and it is
   * not the frame rate: between reports the position is a smooth extrapolation,
   * and `updatePosition` then applies the whole Kalman correction in one
   * statement, so the next frame draws the aircraft somewhere else.
   *
   * These tests measure the drawn path frame by frame and assert it stays
   * continuous across an update. Every existing track test sampled either side
   * of a report without ever looking at the step between them, which is why
   * this survived.
   */

  const FRAME_MS = 16;

  /** Metres between two samples, in the plane. Good enough at these scales. */
  function metresBetween(
    a: { lat: number; lon: number },
    b: { lat: number; lon: number },
  ): number {
    const latM = (b.lat - a.lat) * 111_320;
    const lonM = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
    return Math.hypot(latM, lonM);
  }

  /**
   * Fly one frame at a time, folding in a report at `reportAt`, and return the
   * largest single-frame movement seen.
   */
  function largestFrameStep(offsetMetres: number): number {
    const track = new AircraftTrack(state({ hex: 'step01', lat: 0, lon: 0 }));

    // Settle: the filter needs a little history before a correction means
    // anything, and an unsettled filter snaps by design.
    for (let t = FRAME_MS; t <= 2000; t += FRAME_MS) track.sampleAt(T0 + t, FRAME_MS / 1000);

    let previous = track.sampleAt(T0 + 2000, 0);
    let worst = 0;
    let reported = false;

    for (let t = 2000 + FRAME_MS; t <= 4000; t += FRAME_MS) {
      // `>=`, not `===`: the frame clock lands on 2000 + 16k and never on an
      // arbitrary millisecond. An equality here silently never fires, which is
      // how the first draft of this test passed against the unfixed code.
      if (t >= 3000 && !reported) {
        reported = true;
        // A report that disagrees with the extrapolation by `offsetMetres`
        // across track — exactly the case that produced the visible snap.
        track.update(
          state({
            hex: 'step01',
            fixTime: T0 + 3000,
            observedAt: T0 + 3000,
            lat: offsetMetres / 111_320,
            lon: (480 * 0.514_444 * 3) / 111_320,
          }),
        );
      }
      const sample = track.sampleAt(T0 + t, FRAME_MS / 1000);
      worst = Math.max(worst, metresBetween(previous, sample));
      previous = sample;
    }
    return worst;
  }

  it('absorbs a correction instead of teleporting through it', () => {
    // At 480 kt one 16 ms frame is about 4 m of honest travel. A 60 m
    // correction applied as a step is an order of magnitude more than that,
    // and it is what the eye reads as a jump.
    const honestTravelPerFrame = 480 * 0.514_444 * (FRAME_MS / 1000);
    expect(largestFrameStep(60)).toBeLessThan(honestTravelPerFrame * 2.5);
  });

  it('stays continuous across a realistic stream of reports', () => {
    // One report a second for ten seconds, each a few metres off the
    // extrapolation — which is what a real feed looks like, and what the user
    // sees as a repeating stutter rather than one jump.
    const track = new AircraftTrack(state({ hex: 'flow01', lat: 0, lon: 0 }));
    const speedMps = 480 * 0.514_444;
    const honestTravelPerFrame = speedMps * (FRAME_MS / 1000);

    for (let t = FRAME_MS; t <= 2000; t += FRAME_MS) track.sampleAt(T0 + t, FRAME_MS / 1000);

    let previous = track.sampleAt(T0 + 2000, 0);
    let worst = 0;
    let nextReport = 3000;

    for (let t = 2000 + FRAME_MS; t <= 12_000; t += FRAME_MS) {
      if (t >= nextReport) {
        const seconds = nextReport / 1000;
        // Alternating few-metre jitter: well inside the outlier gate, so every
        // one of these is accepted and corrects the filter.
        const wobble = (nextReport / 1000) % 2 === 0 ? 18 : -18;
        track.update(
          state({
            hex: 'flow01',
            fixTime: T0 + nextReport,
            observedAt: T0 + nextReport,
            lat: wobble / 111_320,
            lon: (speedMps * seconds) / 111_320,
          }),
        );
        nextReport += 1000;
      }
      const sample = track.sampleAt(T0 + t, FRAME_MS / 1000);
      worst = Math.max(worst, metresBetween(previous, sample));
      previous = sample;
    }

    expect(worst).toBeLessThan(honestTravelPerFrame * 2.5);
  });

  it('still converges onto the filter rather than drifting behind it', () => {
    // Absorbing a correction is only acceptable if it is absorbed. An offset
    // that never decays is a permanently wrong position drawn smoothly.
    const track = new AircraftTrack(state({ hex: 'conv01', lat: 0, lon: 0 }));
    for (let t = FRAME_MS; t <= 2000; t += FRAME_MS) track.sampleAt(T0 + t, FRAME_MS / 1000);

    track.update(
      state({
        hex: 'conv01',
        fixTime: T0 + 2000,
        observedAt: T0 + 2000,
        lat: 80 / 111_320,
        lon: (480 * 0.514_444 * 2) / 111_320,
      }),
    );

    for (let t = 2000 + FRAME_MS; t <= 5000; t += FRAME_MS) {
      track.sampleAt(T0 + t, FRAME_MS / 1000);
    }

    // Three seconds is six time constants; the drawn position and the filter's
    // own answer must agree to within a metre.
    const drawn = track.sampleAt(T0 + 5000, FRAME_MS / 1000);
    const truth = track.sampleAt(T0 + 5000, 0);
    expect(metresBetween(drawn, truth)).toBeLessThan(1);
  });

  it('snaps rather than sliding when the aircraft genuinely relocates', () => {
    // A re-registered hex or a feed switch is not a correction. Sliding a
    // kilometre would draw a trajectory nothing flew.
    const track = new AircraftTrack(state({ hex: 'seed01', lat: 0, lon: 0 }));
    for (let t = FRAME_MS; t <= 2000; t += FRAME_MS) track.sampleAt(T0 + t, FRAME_MS / 1000);

    // Two agreeing outliers re-seed the filter (rule 2).
    for (const step of [0, 1]) {
      track.update(
        state({
          hex: 'seed01',
          fixTime: T0 + 2000 + step * 1000,
          observedAt: T0 + 2000 + step * 1000,
          lat: 2,
          lon: 2,
        }),
      );
    }

    const after = track.sampleAt(T0 + 4000 + FRAME_MS, FRAME_MS / 1000);
    expect(after.lat).toBeGreaterThan(1.9);
  });

  it('leaves an unsmoothed sample untouched', () => {
    // `sampleAt(now, 0)` is what the tests and any "where is it really" caller
    // use. It must see the filter, not the picture.
    const track = new AircraftTrack(state({ hex: 'raw001', lat: 0, lon: 0 }));
    for (let t = FRAME_MS; t <= 2000; t += FRAME_MS) track.sampleAt(T0 + t, FRAME_MS / 1000);

    const before = track.sampleAt(T0 + 2000, 0);
    const again = track.sampleAt(T0 + 2000, 0);
    expect(again.lat).toBe(before.lat);
    expect(again.lon).toBe(before.lon);
  });
});

describe('a helicopter moves like one', () => {
  /**
   * The complaint: "l'hélicoptère … glisse arrière avant". Every report
   * corrected the drawn position at a rate set by the correction alone, so a
   * ten-metre correction on an aircraft doing twenty knots slid it backwards
   * at twice its speed, once per report. And its attitude came from the
   * aeroplane rules: nose up to climb, wings level in every turn.
   *
   * A helicopter flown through a realistic profile — slow, hover-taxi slow,
   * fast, turning — reported every three seconds with the noise and latency a
   * real feed has.
   */
  const FRAME = 1 / 60;

  function fly(): { backFrames: number; pitch: [number, number]; roll: [number, number] } {
    let seed = 7;
    const rnd = (): number => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
    const gauss = (): number => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

    let e = 0;
    let n = 0;
    let hdg = 40;
    let v = 12;
    let alt = 250;
    let track: AircraftTrack | null = null;
    let nextFix = 0;
    let prev: { lat: number; lon: number } | null = null;
    let backFrames = 0;
    const pitch: [number, number] = [0, 0];
    const roll: [number, number] = [0, 0];

    for (let t = 0; t < 120; t += FRAME) {
      const targetV = t < 30 ? 12 : t < 50 ? 3 : t < 80 ? 30 : t < 100 ? 8 : 25;
      v += clamp(targetV - v, -1.2 * FRAME, 1.2 * FRAME);
      hdg += (t > 60 && t < 75 ? 6 : t > 100 && t < 110 ? -8 : 0) * FRAME;
      const vz = t > 50 && t < 65 ? 3 : 0;
      alt += vz * FRAME;
      const h = (hdg * Math.PI) / 180;
      e += v * Math.sin(h) * FRAME;
      n += v * Math.cos(h) * FRAME;
      const now = T0 + t * 1000;

      if (t >= nextFix) {
        nextFix += 3;
        const age = 0.3 + rnd() * 0.7;
        const s = state({
          hex: 'heli01',
          category: 'A7',
          headingDeg: null,
          lat: (n - v * Math.cos(h) * age + gauss() * 6) / 110_540,
          lon: (e - v * Math.sin(h) * age + gauss() * 6) / 111_320,
          altGeomFt: Math.round((alt * 3.2808) / 25) * 25,
          geomRateFpm: Math.round((vz * 196.85) / 64) * 64,
          groundSpeedKt: Math.round((v / 0.514_444 + gauss() * 0.5) * 10) / 10,
          trackDeg: hdg + gauss() * (v < 5 ? 8 : 1.5),
          fixTime: now - age * 1000,
          observedAt: now,
        });
        if (track) track.update(s);
        else track = new AircraftTrack(s);
      }
      if (!track) continue;

      const s = track.sampleAt(now, FRAME);
      if (prev && t > 5) {
        const along =
          (s.lon - prev.lon) * 111_320 * Math.sin(h) + (s.lat - prev.lat) * 110_540 * Math.cos(h);
        if (along < 0) backFrames++;
        pitch[0] = Math.min(pitch[0], s.pitchDeg);
        pitch[1] = Math.max(pitch[1], s.pitchDeg);
        roll[0] = Math.min(roll[0], s.rollDeg);
        roll[1] = Math.max(roll[1], s.rollDeg);
      }
      prev = { lat: s.lat, lon: s.lon };
    }
    return { backFrames, pitch, roll };
  }

  const result = fly();

  it('never slides backwards between reports', () => {
    expect(result.backFrames).toBe(0);
  });

  it('keeps a helicopter attitude: no nose-high climbs, nose down to go fast', () => {
    expect(result.pitch[1]).toBeLessThan(12);
    expect(result.pitch[0]).toBeLessThan(-3);
  });

  it('banks into turns that are never broadcast', () => {
    expect(result.roll[1]).toBeGreaterThan(8);
    expect(result.roll[0]).toBeLessThan(-8);
  });

  it('holds its heading in a hover instead of spinning with the noise', () => {
    const hover = new AircraftTrack(
      state({ hex: 'hover1', category: 'A7', lat: 0, lon: 0, groundSpeedKt: 0.5, trackDeg: 10, headingDeg: null }),
    );
    for (let t = 0; t < 20_000; t += 16) hover.sampleAt(T0 + t, 0.016);
    const start = hover.sampleAt(T0 + 20_000, 0.016).headingDeg;
    for (let k = 1; k <= 10; k++) {
      hover.update(
        state({
          hex: 'hover1',
          category: 'A7',
          lat: (k % 2 ? 3 : -3) / 111_320,
          lon: 0,
          groundSpeedKt: 1,
          trackDeg: (k * 97) % 360,
          headingDeg: null,
          fixTime: T0 + 20_000 + k * 3000,
          observedAt: T0 + 20_000 + k * 3000,
        }),
      );
      for (let t = 0; t < 3000; t += 16) hover.sampleAt(T0 + 20_000 + k * 3000 + t, 0.016);
    }
    const end = hover.sampleAt(T0 + 50_000, 0.016).headingDeg;
    expect(Math.abs(((end - start + 540) % 360) - 180)).toBeLessThan(5);
  });
});
