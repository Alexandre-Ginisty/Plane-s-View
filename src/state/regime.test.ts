/**
 * The power inference.
 *
 * It is a guess — ADS-B carries no engine data at all — so what is defended
 * here is not accuracy but *ordering*: climb must be louder than cruise, cruise
 * louder than descent, and a stand must be quieter than a takeoff roll. Get
 * any of those backwards and the aeroplane sounds like it is doing the
 * opposite of what the screen shows, which is worse than silence.
 */

import { describe, expect, it } from 'vitest';

import type { SampledAircraft } from './track';
import { flightRegime } from './regime';

function sample(overrides: Partial<SampledAircraft> & { onGround?: boolean } = {}): SampledAircraft {
  const { onGround = false, ...rest } = overrides;
  return {
    hex: 'abc123',
    lat: 51.5,
    lon: -0.3,
    altFt: 35_000,
    trackDeg: 90,
    headingDeg: 90,
    rollDeg: 0,
    pitchDeg: 0,
    groundSpeedKt: 450,
    verticalRateFpm: 0,
    ageSec: 0,
    stale: false,
    uncertaintyM: 10,
    latest: { onGround } as SampledAircraft['latest'],
    ...rest,
  } as SampledAircraft;
}

describe('flightRegime', () => {
  it('orders the phases of flight the way they actually sound', () => {
    const climb = flightRegime(sample({ verticalRateFpm: 2_000, altFt: 8_000 }));
    const cruise = flightRegime(sample({ verticalRateFpm: 0 }));
    const descent = flightRegime(sample({ verticalRateFpm: -1_800 }));

    expect(climb.power).toBeGreaterThan(cruise.power);
    expect(cruise.power).toBeGreaterThan(descent.power);
  });

  it('is nearly silent at a stand and at full power on the roll', () => {
    const parked = flightRegime(sample({ groundSpeedKt: 0, onGround: true, altFt: 0 }));
    const taxi = flightRegime(sample({ groundSpeedKt: 18, onGround: true, altFt: 0 }));
    const roll = flightRegime(sample({ groundSpeedKt: 95, onGround: true, altFt: 0 }));

    expect(parked.power).toBeLessThan(0.08);
    expect(taxi.power).toBeGreaterThan(parked.power);
    expect(taxi.power).toBeLessThan(0.2);
    expect(roll.power).toBeGreaterThan(0.9);
  });

  it('does not put a pushback at half power', () => {
    // Interpolating across the whole ground-speed range would, and a heavy jet
    // roaring while it is being pushed off the stand is an obvious error.
    expect(flightRegime(sample({ groundSpeedKt: 4, onGround: true })).power).toBeLessThan(0.12);
  });

  it('spools up on the approach, where the drag is', () => {
    // Low, slow and descending is the one case where the vertical speed lies:
    // the engines are working against flaps and gear, not gliding down.
    const approach = flightRegime(
      sample({ altFt: 2_000, groundSpeedKt: 150, verticalRateFpm: -700 }),
    );
    const highDescent = flightRegime(sample({ altFt: 30_000, verticalRateFpm: -1_800 }));
    expect(approach.power).toBeGreaterThan(highDescent.power);
  });

  it('stays inside 0 and 1 however absurd the vertical rate', () => {
    for (const verticalRateFpm of [-30_000, -6_000, 0, 6_000, 30_000]) {
      const { power } = flightRegime(sample({ verticalRateFpm }));
      expect(power).toBeGreaterThanOrEqual(0);
      expect(power).toBeLessThanOrEqual(1);
    }
  });
});
