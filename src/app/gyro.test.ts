import { describe, expect, it } from 'vitest';

import { lookRates } from './gyro';

describe('lookRates', () => {
  it('turns with the axis that points up, however the phone is held', () => {
    // Portrait: up is +Y, so a turn is gamma.
    expect(lookRates({ beta: 0, gamma: 10 }, 0)).toEqual({ yaw: 10, pitch: 0 });
    // Landscape, top to the left: up is +X, so a turn is beta.
    expect(lookRates({ beta: 10, gamma: 0 }, 90).yaw).toBe(10);
    // Landscape the other way round: up is −X.
    expect(lookRates({ beta: 10, gamma: 0 }, 270).yaw).toBe(-10);
    expect(lookRates({ beta: 10, gamma: 0 }, -90).yaw).toBe(-10);
  });

  it('tilts with the axis that points to the screen’s right', () => {
    expect(lookRates({ beta: 10, gamma: 0 }, 0).pitch).toBe(10);
    expect(lookRates({ beta: 0, gamma: 10 }, 90).pitch).toBe(-10);
    expect(lookRates({ beta: 0, gamma: 10 }, 270).pitch).toBe(10);
  });
});
