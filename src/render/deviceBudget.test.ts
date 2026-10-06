import { describe, expect, it } from 'vitest';

import { baseTier, budgetFor, stepDown, type DeviceSignals } from './deviceBudget';

const desktop: DeviceSignals = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  deviceMemoryGb: null,
  maxTouchPoints: 0,
  platform: 'MacIntel',
  screenShortSide: 1117,
};
const iphone: DeviceSignals = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  deviceMemoryGb: null,
  maxTouchPoints: 5,
  platform: 'iPhone',
  screenShortSide: 393,
};

describe('baseTier', () => {
  it('gives a desktop the full picture', () => {
    expect(baseTier(desktop)).toBe('high');
  });

  it('keeps a phone well inside what it lets a tab use', () => {
    expect(baseTier(iphone)).toBe('low');
    expect(baseTier({ ...iphone, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile', deviceMemoryGb: 2 })).toBe('minimal');
    expect(baseTier({ ...iphone, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile', deviceMemoryGb: 8 })).toBe('mid');
  });

  it('recognises an iPad that says it is a Mac', () => {
    expect(baseTier({ ...desktop, maxTouchPoints: 5, screenShortSide: 820 })).toBe('mid');
  });
});

describe('budgets', () => {
  it('only ever get lighter going down', () => {
    const tiers = ['high', 'mid', 'low', 'minimal'] as const;
    for (let i = 1; i < tiers.length; i++) {
      const a = budgetFor(tiers[i - 1]!, 3);
      const b = budgetFor(tiers[i]!, 3);
      expect(b.maxResidentTiles).toBeLessThan(a.maxResidentTiles);
      expect(b.maxPixelRatio).toBeLessThanOrEqual(a.maxPixelRatio);
      expect(b.msaaSamples).toBeLessThanOrEqual(a.msaaSamples);
    }
  });

  it('never asks for more pixels than the screen has', () => {
    expect(budgetFor('high', 1).maxPixelRatio).toBe(1);
  });

  it('steps down and stops at the bottom', () => {
    expect(stepDown('high', 1)).toBe('mid');
    expect(stepDown('low', 5)).toBe('minimal');
    expect(stepDown('mid', 0)).toBe('mid');
  });
});
