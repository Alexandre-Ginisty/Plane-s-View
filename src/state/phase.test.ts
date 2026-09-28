import { describe, expect, it } from 'vitest';

import { PhaseTracker, classifyPhase, secondsToTouchdown, type PhaseInput } from './phase';

const input = (over: Partial<PhaseInput>): PhaseInput => ({
  onGround: false,
  groundSpeedKt: 250,
  verticalRateFpm: 0,
  aglFt: Number.NaN,
  altFt: 35_000,
  ...over,
});

describe('classifyPhase', () => {
  it('separates parked, taxi and a runway roll on the ground', () => {
    expect(classifyPhase(input({ onGround: true, groundSpeedKt: 0 }))).toBe('parked');
    expect(classifyPhase(input({ onGround: true, groundSpeedKt: 15 }))).toBe('taxi');
    expect(classifyPhase(input({ onGround: true, groundSpeedKt: 120 }))).toBe('takeoff');
  });

  it('calls a fast ground roll a rollout when the aircraft was arriving', () => {
    expect(classifyPhase(input({ onGround: true, groundSpeedKt: 120 }), 'final')).toBe('rollout');
  });

  it('reads the approach from height above ground, not altitude', () => {
    // 6 000 ft on the altimeter, 1 200 ft above a high airfield: that is final.
    expect(classifyPhase(input({ verticalRateFpm: -700, altFt: 6_000, aglFt: 1_200 }))).toBe('final');
    expect(classifyPhase(input({ verticalRateFpm: -700, altFt: 6_000, aglFt: 6_000 }))).toBe('approach');
    expect(classifyPhase(input({ verticalRateFpm: -2000, altFt: 30_000 }))).toBe('descent');
  });

  it('falls back to altitude when the terrain is unknown', () => {
    expect(classifyPhase(input({ verticalRateFpm: 1800, altFt: 900 }))).toBe('departure');
    expect(classifyPhase(input({ verticalRateFpm: 1800, altFt: 9_000 }))).toBe('climb');
  });

  it('holds final through the flare, when the sink rate goes to nothing', () => {
    expect(classifyPhase(input({ verticalRateFpm: -100, altFt: 30 }), 'final')).toBe('final');
    expect(classifyPhase(input({ verticalRateFpm: -100, altFt: 30 }))).toBe('level');
  });

  it('only calls level flight cruise when it is high', () => {
    expect(classifyPhase(input({ altFt: 37_000 }))).toBe('cruise');
    expect(classifyPhase(input({ altFt: 4_000 }))).toBe('level');
  });
});

describe('secondsToTouchdown', () => {
  it('divides height by sink rate', () => {
    expect(secondsToTouchdown(input({ verticalRateFpm: -600, aglFt: 1_000 }))).toBeCloseTo(100);
  });
  it('has no answer when climbing, level or high', () => {
    expect(secondsToTouchdown(input({ verticalRateFpm: 600, aglFt: 1_000 }))).toBeNull();
    expect(secondsToTouchdown(input({ verticalRateFpm: -600, aglFt: 20_000 }))).toBeNull();
  });
});

describe('PhaseTracker', () => {
  it('ignores a flicker shorter than the hold time', () => {
    const t = new PhaseTracker();
    t.update(input({ altFt: 37_000 }), 0.1);
    expect(t.update(input({ altFt: 37_000, verticalRateFpm: -900 }), 1).phase).toBe('cruise');
    expect(t.update(input({ altFt: 37_000 }), 1).phase).toBe('cruise');
  });

  it('commits a phase that holds', () => {
    const t = new PhaseTracker();
    t.update(input({ altFt: 37_000 }), 0.1);
    t.update(input({ altFt: 37_000, verticalRateFpm: -900 }), 2);
    expect(t.update(input({ altFt: 37_000, verticalRateFpm: -900 }), 1).phase).toBe('descent');
  });

  it('reports liftoff once, the moment the wheels leave', () => {
    const t = new PhaseTracker();
    t.update(input({ onGround: true, groundSpeedKt: 140, altFt: 0 }), 0.1);
    const up = t.update(input({ groundSpeedKt: 155, verticalRateFpm: 1500, altFt: 50 }), 0.1);
    expect(up).toEqual({ phase: 'departure', event: 'liftoff' });
    expect(t.update(input({ groundSpeedKt: 160, verticalRateFpm: 1800, altFt: 200 }), 0.1).event).toBeNull();
  });

  it('reports touchdown and then a rollout', () => {
    const t = new PhaseTracker();
    t.update(input({ groundSpeedKt: 140, verticalRateFpm: -700, altFt: 800 }), 0.1);
    const down = t.update(input({ onGround: true, groundSpeedKt: 130, altFt: 0 }), 0.1);
    expect(down).toEqual({ phase: 'rollout', event: 'touchdown' });
  });
});
