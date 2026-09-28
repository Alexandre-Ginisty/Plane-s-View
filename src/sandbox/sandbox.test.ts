import { describe, expect, it } from 'vitest';

import { ArcadeFlight, NO_INPUT } from './flight';
import { SANDBOX_AIRCRAFT, sandboxAircraft } from './catalog';
import { Score, killPoints } from './score';

const viper = sandboxAircraft('viper');
const striker = sandboxAircraft('striker');

function flight(spec = viper.flight, altM = 2000): ArcadeFlight {
  return new ArcadeFlight(spec, { lat: 48.85, lon: 2.35, altM, headingDeg: 0 }, 'sandbox', 'SBF1', 'VIPER');
}

describe('ArcadeFlight', () => {
  it('flies along its heading at the speed it shows', () => {
    const f = flight();
    for (let i = 0; i < 60; i++) f.step(1 / 60, NO_INPUT, 0, 5);
    const metres = (f.lat - 48.85) * 111_320;
    expect(metres).toBeCloseTo(f.speedMps, -1);
    expect(f.lon).toBeCloseTo(2.35, 6);
  });

  it('climbs with up and descends with down', () => {
    const up = flight();
    const down = flight();
    for (let i = 0; i < 120; i++) {
      up.step(1 / 60, { ...NO_INPUT, pitch: 1 }, 0, 5);
      down.step(1 / 60, { ...NO_INPUT, pitch: -1 }, 0, 5);
    }
    expect(up.altM).toBeGreaterThan(2050);
    expect(down.altM).toBeLessThan(1950);
    expect(up.pitchDeg).toBeGreaterThan(10);
  });

  it('banks into a turn and comes round', () => {
    const f = flight();
    for (let i = 0; i < 180; i++) f.step(1 / 60, { ...NO_INPUT, turn: 1 }, 0, 5);
    expect(f.rollDeg).toBeGreaterThan(40);
    expect(f.headingDeg).toBeGreaterThan(20);
    expect(f.headingDeg).toBeLessThan(180);
  });

  it('reports flying into the ground', () => {
    const f = flight(viper.flight, 30);
    let alive = true;
    for (let i = 0; i < 600 && alive; i++) alive = f.step(1 / 60, { ...NO_INPUT, pitch: -1 }, 0, 5);
    expect(alive).toBe(false);
  });

  it('lets a helicopter settle on the ground instead of crashing', () => {
    const f = flight(striker.flight, 40);
    let alive = true;
    for (let i = 0; i < 1500 && alive; i++) alive = f.step(1 / 60, { ...NO_INPUT, pitch: -0.3, brake: true }, 0, 3);
    expect(alive).toBe(true);
    expect(f.altM).toBeCloseTo(3, 0);
  });

  it('hands the rest of the app an ordinary sampled aircraft', () => {
    const f = flight();
    f.step(1 / 60, NO_INPUT, 0, 5);
    const s = f.toSample();
    expect(s.hex).toBe('sandbox');
    expect(s.altFt).toBeCloseTo(f.altM / 0.3048, 3);
    expect(s.latest.category).toBe('A3');
  });
});

describe('the catalogue', () => {
  it('offers the armed airframes and the whole hangar', () => {
    expect(SANDBOX_AIRCRAFT.filter((a) => a.group === 'combat')).toHaveLength(4);
    expect(SANDBOX_AIRCRAFT.length).toBeGreaterThan(40);
    expect(new Set(SANDBOX_AIRCRAFT.map((a) => a.id)).size).toBe(SANDBOX_AIRCRAFT.length);
  });
});

describe('Score', () => {
  const memory = (): Storage => {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
      clear: () => m.clear(),
      key: () => null,
      length: 0,
    };
  };

  it('pays more for bigger aircraft', () => {
    expect(killPoints(73, 1)).toBeGreaterThan(killPoints(8, 1));
  });

  it('multiplies kills in quick succession and resets after a gap', () => {
    const s = new Score(memory());
    const first = s.kill(40, 0);
    const second = s.kill(40, 5);
    expect(second.streak).toBe(2);
    expect(second.points).toBeGreaterThan(first.points);
    expect(s.kill(40, 60).streak).toBe(1);
  });

  it('keeps the best score', () => {
    const storage = memory();
    const s = new Score(storage);
    s.kill(40, 0);
    expect(new Score(storage).best).toBe(s.points);
  });
});
