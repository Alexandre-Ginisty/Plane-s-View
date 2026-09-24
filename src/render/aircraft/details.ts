/**
 * The details the type table already implies but never spelled out.
 *
 * Propeller blade count, winglet style and undercarriage layout are not in
 * `typeTable.ts` and deliberately stay out of it. That table is 500 lines of
 * dimensions and every row added to it is a row that has to be kept right; the
 * things below are *consequences* of dimensions already there — a 27 m
 * turboprop has six-bladed props because 27 m turboprops do, and a 67 m jet
 * with 35 degrees of sweep has raked tips because that generation of widebody
 * does.
 *
 * Deriving them keeps one source of truth and makes the rules testable on
 * their own, which is the same split `shapes.ts` already makes against the
 * table. Where a derivation would be wrong for a notable type the answer is a
 * row in the table with an explicit override — not a special case here.
 */

import type { AirframeShape } from './typeTable';

/** Shape of the wingtip device, which is most of a modern jet's signature. */
export type WingletStyle = 'none' | 'fence' | 'blended' | 'raked';

/**
 * How many propeller blades to draw, 0 for a jet or a glider.
 *
 * The count is the recognition cue, far more than the diameter: a Q400's
 * six-bladed props and a Cessna's two-bladed one are the difference between
 * "airliner" and "light aircraft" at any distance where the props are visible
 * at all. Modern regional turboprops are six; the older and smaller ones are
 * four; piston singles are two, three once they are big enough to need it.
 */
export function propBladesFor(shape: AirframeShape): number {
  if (shape.kind === 'turboprop') {
    if (shape.length >= 24) return 6;
    return 4;
  }
  if (shape.kind === 'piston') return shape.length >= 8.5 ? 3 : 2;
  return 0;
}

/**
 * Where the propellers go, as offsets in model space (length-normalised).
 *
 * Two cases, and which one applies is already in the shape: an airframe with
 * wing-mounted engines gets one per nacelle, and a propeller-driven airframe
 * with *no* mounted engines has the engine in the nose, which is the only
 * place left for it. Jets get none, whatever is mounted where.
 */
export function propellerCount(shape: AirframeShape): number {
  if (propBladesFor(shape) === 0) return 0;
  if (shape.engineMount === 'wing') return shape.engines;
  return 1;
}

/**
 * Wingtip device, derived from generation rather than from a list.
 *
 * Sweep and length together are a good proxy for when an airframe was
 * designed, which is what actually decides this. The long-sweep widebodies —
 * 777, 787, A350, 747-8 — carry raked tips; the narrowbodies that were
 * re-engined rather than redesigned carry blended winglets or sharklets; the
 * rear-engined regional and business jets mostly carry a small fence or
 * nothing at all, and drawing a two-metre sharkline on a Citation would be a
 * more obvious error than drawing nothing.
 */
export function wingletStyleFor(shape: AirframeShape): WingletStyle {
  if (shape.kind !== 'jet') return 'none';
  if (shape.length >= 55 && shape.sweepDeg >= 32) return 'raked';
  if (shape.engineMount === 'tail') return shape.length >= 25 ? 'fence' : 'none';
  if (shape.length >= 25) return 'blended';
  return 'none';
}

/**
 * Whether the airframe has retractable gear worth drawing extended.
 *
 * Almost everything does; the exceptions are the airframes that have no gear
 * to retract. A glider gets a single centreline wheel and a helicopter gets
 * skids, both of which are drawn by their own builders.
 */
export function hasRetractableGear(shape: AirframeShape): boolean {
  return shape.kind !== 'glider' && shape.kind !== 'rotorcraft';
}

/**
 * Main-gear bogie wheel count per side.
 *
 * Purely a function of weight, for which length is the only proxy available.
 * The number matters less than its existence, but a 747 on two single wheels
 * looks wrong in a way that is hard to name and easy to see.
 */
export function mainWheelsPerSide(shape: AirframeShape): number {
  if (shape.length >= 62) return 4;
  if (shape.length >= 33) return 2;
  return 1;
}
