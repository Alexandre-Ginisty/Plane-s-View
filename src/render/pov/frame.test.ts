/**
 * The compass bearing of a view direction.
 *
 * The heading strip was reported as "ne marche pas du tout quand on tourne".
 * Two faults: the strip itself did not scroll (see `Compass.svelte`), and it
 * was fed the *aircraft's* heading rather than the direction the camera was
 * actually looking — so free look turned the view without turning the strip,
 * and every external camera mode showed a bearing for a window nobody was
 * looking through.
 *
 * `bearingOf` is the arithmetic that fixes the second half, and it is exactly
 * the kind of thing that is plausible and wrong: an east/north swap, a sign,
 * or degrees measured anticlockwise all produce a strip that moves convincingly
 * and points the wrong way.
 */

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';

import { aircraftFrame, bearingOf } from './frame';
import type { SampledAircraft } from '@/state/traffic';
import type { AircraftState } from '@/data/types';

function sampleAt(lat: number, lon: number, headingDeg: number): SampledAircraft {
  return {
    hex: 'test01',
    lat,
    lon,
    altFt: 35_000,
    trackDeg: headingDeg,
    headingDeg,
    rollDeg: 0,
    pitchDeg: 0,
    groundSpeedKt: 450,
    verticalRateFpm: 0,
    ageSec: 0,
    stale: false,
    uncertaintyM: 10,
    latest: { onGround: false, category: null } as unknown as AircraftState,
  };
}

/** The four cardinals, plus two intercardinals that catch an axis swap. */
const CARDINALS: readonly [number, string][] = [
  [0, 'north'],
  [45, 'north-east'],
  [90, 'east'],
  [180, 'south'],
  [270, 'west'],
  [315, 'north-west'],
];

describe('bearingOf', () => {
  it.each(CARDINALS)('reads %i° as %s for an aircraft pointing there', (heading) => {
    const sample = sampleAt(48.85, 2.35, heading);
    const frame = aircraftFrame(sample);
    expect(bearingOf(frame.forward, frame, 0)).toBeCloseTo(heading, 3);
  });

  it('is unchanged by where on Earth the aircraft is', () => {
    // The bearing is measured against the *local* horizontal, so the same
    // heading must read the same in Sydney as in Reykjavik. A basis built from
    // a global axis instead would drift with latitude and be right only near
    // the equator.
    for (const [lat, lon] of [
      [-33.9, 151.2],
      [64.1, -21.9],
      [0, 0],
      [1.35, 103.8],
      [-54, -68],
    ] as const) {
      const frame = aircraftFrame(sampleAt(lat, lon, 117));
      expect(bearingOf(frame.forward, frame, 0)).toBeCloseTo(117, 2);
    }
  });

  it('turns right when the view turns right', () => {
    // The sign. An anticlockwise convention gives a card that slides the wrong
    // way, which looks like a working instrument and is worse than a broken one.
    const frame = aircraftFrame(sampleAt(48.85, 2.35, 10));
    const rotated = frame.forward
      .clone()
      .applyAxisAngle(frame.localUp, -30 * (Math.PI / 180));
    expect(bearingOf(rotated, frame, 0)).toBeCloseTo(40, 2);
  });

  it('always answers inside [0, 360)', () => {
    const frame = aircraftFrame(sampleAt(48.85, 2.35, 0));
    for (let deg = -720; deg <= 720; deg += 17) {
      const dir = frame.forward.clone().applyAxisAngle(frame.localUp, -deg * (Math.PI / 180));
      const bearing = bearingOf(dir, frame, 0);
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThan(360);
    }
  });

  it('keeps the previous answer when looking straight down', () => {
    // Straight down has no horizontal component, so there is no bearing to
    // report. Returning 0 would snap the strip to north every time the camera
    // pitched fully over.
    const frame = aircraftFrame(sampleAt(48.85, 2.35, 200));
    const down = frame.localUp.clone().negate();
    expect(bearingOf(down, frame, 137)).toBe(137);
  });

  it('ignores pitch: a climbing view still points the same way', () => {
    const frame = aircraftFrame(sampleAt(48.85, 2.35, 75));
    const climbing = frame.forward
      .clone()
      .addScaledVector(frame.localUp, 0.8)
      .normalize();
    expect(bearingOf(climbing, frame, 0)).toBeCloseTo(75, 2);
  });

  it('gives east and north axes that are perpendicular and horizontal', () => {
    // The basis the bearing is measured against. If these are not orthonormal
    // the arithmetic above is measuring against a sheared frame and every
    // answer is subtly wrong rather than obviously so.
    const frame = aircraftFrame(sampleAt(-12.5, 130.9, 0));
    expect(frame.east.dot(frame.north)).toBeCloseTo(0, 9);
    expect(frame.east.dot(frame.localUp)).toBeCloseTo(0, 9);
    expect(frame.north.dot(frame.localUp)).toBeCloseTo(0, 9);
    expect(frame.east.length()).toBeCloseTo(1, 9);
    expect(frame.north.length()).toBeCloseTo(1, 9);
  });

  it('is consistent with the camera it is derived from', () => {
    // A Vector3 built independently of the frame must still resolve: this
    // catches `bearingOf` quietly depending on `direction` being one of the
    // frame's own vectors.
    const frame = aircraftFrame(sampleAt(35.6, 139.7, 0));
    const east = new Vector3().copy(frame.east);
    expect(bearingOf(east, frame, 0)).toBeCloseTo(90, 2);
  });
});
