/**
 * What an aircraft sounds like, as numbers.
 *
 * Split from the Web Audio graph on purpose: the graph cannot be run in a test
 * — there is no AudioContext in Node and mocking one tests the mock — while
 * every decision worth defending is arithmetic. Which class of engine a type
 * has, what frequency its blades pass at, how loud the airflow is at a given
 * speed: all of that is here, and `engineAudio.ts` only turns it into
 * oscillators.
 *
 * ## Synthesised, not sampled
 *
 * There is no library of free per-type engine recordings, and a single generic
 * jet loop under every aircraft would be worse than silence: the point of
 * hearing the engines is that a Dash 8 and a 777 do not sound remotely alike,
 * and a loop makes them identical. Synthesis gets the *structure* right — the
 * blade-pass tone of a six-bladed propeller really is at a different frequency
 * from a four-bladed one, and it really does move with the flight regime — and
 * structure is what the ear recognises.
 */

import type { AirframeShape } from '@/render/aircraft';
import { propBladesFor } from '@/render/aircraft';
import type { FlightRegime } from '@/state/regime';

export type EngineClass = 'turbofan' | 'turbojet' | 'turboprop' | 'piston' | 'rotor' | 'silent';

/**
 * Which family of noise this airframe makes.
 *
 * The distinction that matters most is tonal versus broadband. A propeller is
 * a strong low tone with harmonics; a high-bypass turbofan is mostly rushing
 * air with a fan whine on top; a helicopter is an impulsive slap at the
 * blade-pass rate that neither of the other two resembles at all.
 */
export function engineClassFor(shape: AirframeShape): EngineClass {
  switch (shape.kind) {
    case 'rotorcraft':
      return 'rotor';
    case 'turboprop':
      return 'turboprop';
    case 'piston':
      return 'piston';
    case 'glider':
      return 'silent';
    case 'jet':
      // Rear-mounted engines on a short airframe is the low-bypass business
      // jet signature: much more whistle, much less rush.
      return shape.engineMount === 'tail' && shape.length < 32 ? 'turbojet' : 'turbofan';
  }
}

/**
 * Fundamental tone, hertz.
 *
 * For anything with blades this is the blade-pass frequency — rate times blade
 * count — which is the physical reason a six-bladed Q400 hums where a
 * two-bladed Cessna buzzes. For a turbofan it is the fan's own blade pass,
 * which is high enough to read as a whine rather than a beat.
 */
export function fundamentalHz(
  klass: EngineClass,
  shape: AirframeShape,
  regime: FlightRegime,
): number {
  const blades = Math.max(2, propBladesFor(shape));

  switch (klass) {
    case 'turboprop': {
      // Governed, so it barely moves: 1020 rpm at the propeller.
      const rpm = 600 + 420 * Math.min(1, regime.power / 0.2);
      return (rpm / 60) * blades;
    }
    case 'piston': {
      const rpm = 700 + 1_700 * Math.min(1, regime.power / 0.2);
      return (rpm / 60) * blades;
    }
    case 'rotor': {
      // Tip speed is fixed at about 210 m/s, so a bigger disc beats slower —
      // which is exactly why a heavy helicopter sounds heavier.
      const radiusM = Math.max(2, (shape.rotorRatio * shape.length) / 2);
      const rps = 210 / (2 * Math.PI * radiusM);
      return rps * (shape.length >= 15 ? 5 : 4);
    }
    case 'turbofan':
    case 'turbojet': {
      // N1 runs from about 25% at idle to 100%; the fan has of the order of
      // twenty blades, which puts the whine in the low kilohertz.
      const n1 = 0.25 + 0.75 * regime.power;
      const shaftHz = n1 * (klass === 'turbofan' ? 55 : 85);
      return shaftHz * 20;
    }
    case 'silent':
      return 0;
  }
}

/**
 * Loudness of the tonal component and of the broadband rush, each 0-1.
 *
 * They move in opposite directions with bypass ratio, which is the whole
 * difference between engine families: a propeller is nearly all tone, a modern
 * turbofan is nearly all rush, and an old low-bypass jet is a whistle over a
 * roar.
 */
export function mixFor(klass: EngineClass, regime: FlightRegime): { tone: number; rush: number } {
  const p = regime.power;
  switch (klass) {
    case 'turboprop':
      return { tone: 0.16 + 0.3 * p, rush: 0.05 + 0.1 * p };
    case 'piston':
      return { tone: 0.2 + 0.32 * p, rush: 0.03 + 0.05 * p };
    case 'rotor':
      return { tone: 0.22 + 0.2 * p, rush: 0.06 + 0.1 * p };
    case 'turbofan':
      return { tone: 0.04 + 0.1 * p, rush: 0.1 + 0.42 * p };
    case 'turbojet':
      return { tone: 0.08 + 0.18 * p, rush: 0.09 + 0.38 * p };
    case 'silent':
      return { tone: 0, rush: 0 };
  }
}

/**
 * Airflow noise over the airframe, 0-1.
 *
 * Rises roughly with the square of airspeed and falls with air density, which
 * together mean a glider at 60 knots is nearly silent and the same glider
 * doing 120 is not — and that an airliner at FL350 hears far less of it than
 * the same speed at sea level would suggest.
 */
export function windLevel(regime: FlightRegime): number {
  const density = Math.exp(-(regime.altFt * 0.3048) / 8_500);
  const q = (regime.speedMps / 120) ** 2 * density;
  return Math.min(0.42, q * 0.34);
}

/**
 * How much of all this you hear, by camera position.
 *
 * A flight deck is one of the quieter places on an aeroplane — ahead of the
 * engines and heavily insulated — while a wingtip camera is level with an
 * engine that is not insulated at all.
 */
export function perspectiveGain(mode: string): { engine: number; wind: number; cutoffHz: number } {
  switch (mode) {
    case 'cockpit':
      return { engine: 0.55, wind: 1, cutoffHz: 1_800 };
    case 'wing':
      return { engine: 1, wind: 0.8, cutoffHz: 7_000 };
    case 'chase':
      return { engine: 0.85, wind: 0.5, cutoffHz: 5_000 };
    case 'orbit':
      return { engine: 0.7, wind: 0.35, cutoffHz: 4_000 };
    default:
      return { engine: 0.7, wind: 0.5, cutoffHz: 4_000 };
  }
}
