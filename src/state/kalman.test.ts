import { describe, expect, it } from 'vitest';
import { CvKalman1D } from './kalman';

describe('CvKalman1D', () => {
  it('starts uninitialised and seeds from the first position', () => {
    const k = new CvKalman1D();
    expect(k.ready).toBe(false);
    k.updatePosition(100, 25);
    expect(k.ready).toBe(true);
    expect(k.x).toBeCloseTo(100, 6);
  });

  it('converges onto a constant-velocity truth from noisy measurements', () => {
    const k = new CvKalman1D(0.2);
    const trueV = 230; // m/s, roughly cruise
    k.reset(0, 0, 1e4, 1e3);

    // Deterministic pseudo-noise so the test cannot flake.
    let seed = 42;
    const noise = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff - 0.5) * 60; // +/- 30 m
    };

    const dt = 1;
    for (let i = 1; i <= 60; i++) {
      k.predict(dt);
      k.updatePosition(trueV * i + noise(), 25 * 25);
      k.updateVelocity(trueV, 1);
    }

    expect(k.v).toBeCloseTo(trueV, 0);
    expect(k.x).toBeGreaterThan(trueV * 60 - 40);
    expect(k.x).toBeLessThan(trueV * 60 + 40);
  });

  it('smooths more than it follows: output noise is well under input noise', () => {
    const k = new CvKalman1D(0.05);
    k.reset(0, 0, 100, 10);

    let seed = 7;
    const noise = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff - 0.5) * 200; // +/- 100 m
    };

    let inputErr = 0;
    let outputErr = 0;
    for (let i = 1; i <= 120; i++) {
      k.predict(1);
      const measured = noise(); // truth is 0, stationary
      k.updatePosition(measured, 50 * 50);
      k.updateVelocity(0, 1);
      if (i > 30) {
        inputErr += measured * measured;
        outputErr += k.x * k.x;
      }
    }

    expect(Math.sqrt(outputErr)).toBeLessThan(Math.sqrt(inputErr) * 0.5);
  });

  it('grows position variance while only predicting', () => {
    const k = new CvKalman1D(0.5);
    k.reset(0, 100, 25, 4);
    const before = k.variance;
    for (let i = 0; i < 10; i++) k.predict(1);
    expect(k.variance).toBeGreaterThan(before);
  });

  it('shrinks variance on measurement', () => {
    const k = new CvKalman1D(0.5);
    k.reset(0, 100, 1e6, 1e4);
    const before = k.variance;
    k.updatePosition(5, 25);
    expect(k.variance).toBeLessThan(before);
  });

  it('extrapolates linearly without mutating state', () => {
    const k = new CvKalman1D();
    k.reset(1000, 250, 25, 4);
    expect(k.peek(4)).toBeCloseTo(2000, 6);
    expect(k.x).toBeCloseTo(1000, 6); // untouched
  });

  it('flags an implausible jump through the gate', () => {
    const k = new CvKalman1D(0.1);
    k.reset(0, 0, 25, 1);
    // A fix 500 km away is not this aircraft.
    expect(k.gate(500_000, 25)).toBeGreaterThan(10.8);
    // A fix 10 m away is entirely normal.
    expect(k.gate(10, 625)).toBeLessThan(10.8);
  });

  it('ignores non-positive prediction steps', () => {
    const k = new CvKalman1D();
    k.reset(50, 10, 25, 4);
    k.predict(0);
    k.predict(-5);
    expect(k.x).toBeCloseTo(50, 9);
  });
});
