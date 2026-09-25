/**
 * The engine note, as numbers.
 *
 * What is worth pinning is that different aircraft come out *different*. A
 * synthesiser that produces one plausible drone for everything is no better
 * than a single sampled loop, which is the thing it exists to avoid — so most
 * of these are comparisons between two airframes rather than assertions about
 * one.
 */

import { describe, expect, it } from 'vitest';

import { CAMERA_MODES } from '@/render/pov';
import { shapeFor } from '@/render/aircraft';
import type { FlightRegime } from '@/state/regime';
import {
  engineClassFor,
  fundamentalHz,
  mixFor,
  perspectiveGain,
  windLevel,
} from './engineModel';

const cruise: FlightRegime = {
  power: 0.62,
  speedMps: 230,
  altFt: 35_000,
  onGround: false,
  departing: false,
};
const at = (over: Partial<FlightRegime>): FlightRegime => ({ ...cruise, ...over });

describe('engineClassFor', () => {
  it('separates the families that sound nothing alike', () => {
    expect(engineClassFor(shapeFor('A20N', 'A3'))).toBe('turbofan');
    expect(engineClassFor(shapeFor('DH8D', 'A2'))).toBe('turboprop');
    expect(engineClassFor(shapeFor('C172', 'A1'))).toBe('piston');
    expect(engineClassFor(shapeFor('EC35', 'A7'))).toBe('rotor');
    expect(engineClassFor(shapeFor(null, 'B1'))).toBe('silent');
  });

  it('calls a small rear-engined jet a turbojet, not a turbofan', () => {
    // A Citation whistles where an A320 rushes, and the two mixes are very
    // nearly opposites.
    expect(engineClassFor(shapeFor('C25A', 'A1'))).toBe('turbojet');
  });
});

describe('fundamentalHz', () => {
  it('puts both propellers in the low band, and not at the same pitch', () => {
    /*
     * Blade count times rate, and the arithmetic is worth writing down because
     * the intuition is wrong. A Q400 turns 1020 rpm on six blades — 102 Hz — and
     * a C172 turns 2400 on two, which is 80. The big turboprop is the *higher*
     * fundamental of the two; what makes it sound heavier is loudness and
     * harmonic content, not pitch. A model tuned to the folklore instead of the
     * arithmetic would have had them the other way round.
     */
    const q400 = fundamentalHz('turboprop', shapeFor('DH8D', 'A2'), cruise);
    const cessna = fundamentalHz('piston', shapeFor('C172', 'A1'), cruise);

    expect(q400).toBeCloseTo(102, 0);
    expect(cessna).toBeCloseTo(80, 0);
    // Both are a beat you feel, nowhere near the kilohertz whine of a fan.
    expect(Math.max(q400, cessna)).toBeLessThan(
      fundamentalHz('turbofan', shapeFor('A20N', 'A3'), cruise) / 4,
    );
  });

  it('beats slower under a bigger rotor disc', () => {
    // Tip speed is fixed at about 210 m/s on every helicopter ever built, so
    // the disc diameter decides the beat — which is why a heavy machine sounds
    // heavy before you can see what it is.
    const light = fundamentalHz('rotor', shapeFor('R44', 'A7'), cruise);
    const heavy = fundamentalHz('rotor', shapeFor('S92', 'A7'), cruise);
    expect(heavy).toBeLessThan(light);
  });

  it('is silent for a glider', () => {
    expect(fundamentalHz('silent', shapeFor(null, 'B1'), cruise)).toBe(0);
  });

  it('rises with power on a jet and holds on a turboprop', () => {
    const shape = shapeFor('A20N', 'A3');
    expect(fundamentalHz('turbofan', shape, at({ power: 1 }))).toBeGreaterThan(
      fundamentalHz('turbofan', shape, at({ power: 0.3 })),
    );

    // Constant-speed: the blade angle absorbs the power, not the rate.
    const prop = shapeFor('DH8D', 'A2');
    expect(fundamentalHz('turboprop', prop, at({ power: 1 }))).toBe(
      fundamentalHz('turboprop', prop, at({ power: 0.4 })),
    );
  });
});

describe('mixFor', () => {
  it('makes a turbofan mostly rush and a propeller mostly tone', () => {
    const fan = mixFor('turbofan', cruise);
    const prop = mixFor('turboprop', cruise);
    expect(fan.rush).toBeGreaterThan(fan.tone);
    expect(prop.tone).toBeGreaterThan(prop.rush);
  });

  it('gets louder with power, in both components', () => {
    const idle = mixFor('turbofan', at({ power: 0.05 }));
    const takeoff = mixFor('turbofan', at({ power: 1 }));
    expect(takeoff.rush).toBeGreaterThan(idle.rush);
    expect(takeoff.tone).toBeGreaterThan(idle.tone);
  });
});

describe('windLevel', () => {
  it('rises with speed and falls with altitude', () => {
    expect(windLevel(at({ speedMps: 160, altFt: 1_000 }))).toBeGreaterThan(
      windLevel(at({ speedMps: 80, altFt: 1_000 })),
    );
    // Same speed, thinner air: an airliner at FL350 hears far less of it.
    expect(windLevel(at({ speedMps: 230, altFt: 35_000 }))).toBeLessThan(
      windLevel(at({ speedMps: 230, altFt: 0 })),
    );
  });

  it('never drowns the engines out', () => {
    expect(windLevel(at({ speedMps: 400, altFt: 0 }))).toBeLessThanOrEqual(0.42);
  });
});

describe('perspectiveGain', () => {
  it('makes the flight deck quieter and duller than the wingtip', () => {
    // A flight deck is ahead of the engines and insulated; a wingtip camera is
    // level with one that is not.
    const cockpit = perspectiveGain('cockpit');
    const wing = perspectiveGain('wing');
    expect(cockpit.engine).toBeLessThan(wing.engine);
    expect(cockpit.cutoffHz).toBeLessThan(wing.cutoffHz);
  });

  it('gives the detached views less wind than the ones on the airframe', () => {
    // Wind noise is what you hear *on* the aeroplane, so it separates by where
    // the camera is mounted rather than by how the modes are listed: cockpit
    // and wingtip are bolted to the airframe, chase and orbit are not. The
    // list order is a UI ordering and says nothing about distance.
    const onAirframe = ['cockpit', 'wing'].map((m) => perspectiveGain(m).wind);
    const detached = ['chase', 'orbit'].map((m) => perspectiveGain(m).wind);
    expect(Math.min(...onAirframe)).toBeGreaterThan(Math.max(...detached));
  });

  it('answers for every camera mode that exists', () => {
    // The switch has a default, so a mode nobody wrote a case for is silently
    // given the generic answer. That is how Tower's numbers went on being
    // returned after Tower was removed — and how a new mode would ship
    // sounding like nothing in particular.
    for (const mode of CAMERA_MODES) {
      const gain = perspectiveGain(mode.id);
      expect(gain).not.toEqual(perspectiveGain('no-such-mode'));
    }
  });
});
