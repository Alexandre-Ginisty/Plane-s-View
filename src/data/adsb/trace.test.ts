import { describe, expect, it } from 'vitest';

import { currentLeg, parseTrace } from './trace';

const T0 = 1_791_189_274;

describe('parseTrace', () => {
  it('reads readsb trace rows into timed points', () => {
    const points = parseTrace({
      timestamp: T0,
      trace: [
        [0, 41.2, -8.67, 'ground', 12, 160, 1],
        [60, 41.25, -8.6, 1800, 160, 20, 0],
        [120, 41.3, -8.5, null, 200, 25, 0],
      ],
    });
    expect(points.map((p) => [p.altFt, p.t])).toEqual([
      [0, T0 * 1000],
      [1800, (T0 + 60) * 1000],
      // An altitude missing from a row holds the last one rather than diving to zero.
      [1800, (T0 + 120) * 1000],
    ]);
  });

  it('skips what is not a point', () => {
    expect(parseTrace(null)).toEqual([]);
    expect(parseTrace({ timestamp: T0, trace: [[0, 'x', 1], 'junk', [1, 95, 0, 0], [2, 10, 10, 1000]] })).toHaveLength(1);
  });
});

describe('currentLeg', () => {
  const leg = (dt: number, newLeg = false) => ({ lat: 1, lon: 1, altFt: 1000, t: (T0 + dt) * 1000, newLeg });

  it('starts at the last leg marker', () => {
    const full = [leg(0), leg(60), leg(7200, true), leg(7260), leg(7320)];
    expect(currentLeg(full, []).map((p) => p.t)).toEqual([7200, 7260, 7320].map((d) => (T0 + d) * 1000));
  });

  it('treats a long silence as the end of a flight even unmarked', () => {
    const full = [leg(0), leg(60), leg(60 + 3 * 3600), leg(60 + 3 * 3600 + 30)];
    expect(currentLeg(full, [])).toHaveLength(2);
  });

  it('adds the recent minutes the day file has not caught up with yet', () => {
    const full = [leg(0, true), leg(60)];
    const recent = [leg(30), leg(60), leg(90), leg(120)];
    expect(currentLeg(full, recent).map((p) => p.t)).toEqual([0, 60, 90, 120].map((d) => (T0 + d) * 1000));
  });
});
