/**
 * Propellers, and the spinner they turn on.
 *
 * Their own geometry rather than part of the airframe, because a propeller
 * that does not turn is worse than none: a stopped disc on an aircraft doing
 * 280 knots reads as a failure, and anyone who likes aeroplanes notices it
 * first. Separating it lets `OwnAircraft` spin the mesh at a rate taken from
 * the actual flight regime.
 *
 * Geometry is built in the plane perpendicular to **+Y** (the aircraft's
 * forward axis), centred on the hub, so the mesh spins about its own local +Y
 * with no offset to compensate for.
 *
 * ## The twist is not decoration
 *
 * A flat plate spun about its centre reads as a fan, not as a propeller. What
 * makes a propeller legible from the side is that its blades are *at an angle*
 * and that the angle changes along the span — coarse at the root, fine at the
 * tip. Three stations is enough to show it and is what is built here.
 */

import type { BufferGeometry } from 'three';

import { MeshBuilder } from './meshBuilder';

/** One blade cross-section: four corners in order LE-front, TE-front, TE-back, LE-back. */
type Station = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

/**
 * Corners of one blade section at a given radius.
 *
 * `pitch` rotates the chord out of the disc plane, which is the whole point of
 * a propeller and the only thing that makes it read as one.
 */
function station(radius: number, chord: number, thickness: number, pitch: number): Station {
  const cos = Math.cos(pitch);
  const sin = Math.sin(pitch);
  // Chord runs fore-aft, tilted by the pitch; thickness is perpendicular to it.
  const cy = cos * (chord / 2);
  const cz = sin * (chord / 2);
  const ty = -sin * (thickness / 2);
  const tz = cos * (thickness / 2);

  return [
    [radius, cy + ty, cz + tz],
    [radius, -cy + ty, -cz + tz],
    [radius, -cy - ty, -cz - tz],
    [radius, cy - ty, cz - tz],
  ];
}

/** Skin two sections together, plus a cap on the outer one. */
function loft(b: MeshBuilder, inner: Station, outer: Station, cap: boolean): void {
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    b.quad(inner[i]!, outer[i]!, outer[j]!, inner[j]!);
  }
  if (cap) {
    b.tri(...outer[0]!, ...outer[2]!, ...outer[1]!);
    b.tri(...outer[0]!, ...outer[3]!, ...outer[2]!);
  }
}

export interface PropellerOptions {
  blades: number;
  /** Tip radius, in the same length-normalised units as the airframe. */
  radius: number;
  /** Blade chord at the root. */
  chord: number;
  /** Spinner nose length ahead of the disc, 0 for none. */
  spinner: number;
  /**
   * Multiplier on the blade twist.
   *
   * 1 is a propeller. A helicopter rotor blade is very nearly flat — its
   * pitch is a few degrees and is changed in flight rather than built in — so
   * it wants something close to 0, and giving it a propeller's thirty degrees
   * of twist makes the disc read as an enormous fan.
   */
  twist?: number;
  detail: 'high' | 'low';
}

/**
 * A complete propeller: blades plus spinner, hub at the origin, disc in X-Z.
 *
 * The blades are given a slight sweep back through the disc rather than being
 * dead radial, which is what a modern six-bladed scimitar prop looks like and
 * what stops the four-bladed case reading as a child's windmill.
 */
function createPropellerGeometry(options: PropellerOptions): BufferGeometry {
  const { blades, radius, chord, spinner, detail } = options;
  const twist = options.twist ?? 1;
  const b = new MeshBuilder();

  const hubR = radius * 0.16;
  const thickRoot = chord * 0.22;

  for (let i = 0; i < blades; i++) {
    const mark = b.mark();

    // Coarse at the root, fine at the tip — about 30 degrees of twist, which
    // is roughly what a real blade carries and is plainly visible side-on.
    const root = station(hubR * 0.8, chord, thickRoot, 0.62 * twist);
    const mid = station(radius * 0.6, chord * 0.92, thickRoot * 0.55, 0.42 * twist);
    const tip = station(radius, chord * 0.42, thickRoot * 0.22, 0.26 * twist);

    loft(b, root, mid, false);
    loft(b, mid, tip, true);

    b.rotateYFrom(mark, (i / blades) * Math.PI * 2);
  }

  // --- spinner: a cone over the hub, pointing forward ----------------------
  if (spinner > 0) {
    b.tube(
      [
        [spinner, 0],
        [spinner * 0.62, hubR * 0.62],
        [spinner * 0.2, hubR * 0.98],
        [-spinner * 0.35, hubR],
        [-spinner * 0.45, hubR * 0.8],
      ],
      detail === 'high' ? 14 : 6,
    );
  }

  return b.build();
}

/**
 * Propeller RPM for a flight regime.
 *
 * Real propellers are constant-speed: the governor holds RPM and the blade
 * angle absorbs the power change, so the rate barely moves between climb and
 * cruise and drops properly only on the ground. Modelling it as proportional
 * to airspeed — the obvious thing — produces a propeller that visibly winds
 * down in the descent, which is exactly backwards.
 */
export function propellerRpm(kind: 'turboprop' | 'piston', power: number): number {
  const idle = kind === 'turboprop' ? 600 : 700;
  const governed = kind === 'turboprop' ? 1_020 : 2_400;
  // Below about a fifth power the governor is off its stop and the rate does
  // follow the throttle; above it, it is held.
  const engaged = Math.min(1, power / 0.2);
  return idle + (governed - idle) * engaged;
}

/**
 * The blur disc that stands in for a turning propeller.
 *
 * A propeller at 2400 rpm is forty revolutions a second; sampled at 60 Hz the
 * blades crawl, stop, or run backwards. Every simulator solves it the way a
 * camera and an eye do: above a few hundred rpm the blades stop being blades
 * and become a translucent disc with a faint shimmer.
 *
 * So the spinner carries both. `OwnAircraft` cross-fades between them on rate,
 * and the blade mesh is spun at a deliberately capped rate while it is still
 * visible, since a rate that aliases is worse than a rate that is wrong.
 */
function createPropellerDisc(radius: number, segments = 36): BufferGeometry {
  const b = new MeshBuilder();
  const inner = radius * 0.18;

  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = ((i + 1) / segments) * Math.PI * 2;
    const p = (angle: number, rad: number): readonly [number, number, number] =>
      [Math.cos(angle) * rad, 0, Math.sin(angle) * rad];

    b.quad(p(a, inner), p(a, radius), p(c, radius), p(c, inner));
  }

  return b.build();
}

/** The rate a blade mesh is animated at, revolutions per second. See `createPropellerDisc`. */
export function visibleSpinRate(rpm: number): number {
  // Capped well below the frame rate so the blades never alias while they are
  // still the thing being looked at.
  return Math.min(rpm, 340) / 60;
}

/** How solid the blades are, against the blur disc, at a given rate. */
export function bladeOpacity(rpm: number): number {
  if (rpm <= 260) return 1;
  if (rpm >= 850) return 0;
  return 1 - (rpm - 260) / (850 - 260);
}

export interface Spinner {
  /** The blades. Faded out in favour of `disc` once it is turning fast. */
  geometry: BufferGeometry;
  /** Translucent stand-in for the blades at speed. See `createPropellerDisc`. */
  disc: BufferGeometry;
  /** Tip radius, length-normalised. */
  radius: number;
  /** Hub position in length-normalised model space. */
  origin: readonly [number, number, number];
  /** Rotation axis in model space. */
  axis: readonly [number, number, number];
  /** Which way it turns, seen from behind. */
  direction: 1 | -1;
  /** What sets its rate. See `propellerRpm` and the rotor equivalents. */
  drive: 'propeller' | 'mainRotor' | 'tailRotor';
}

/**
 * A complete spinner: blades, blur disc, and where it lives on the airframe.
 *
 * A factory rather than four hand-built literals, because the radius has to
 * appear in three places — the blade geometry, the disc geometry and the
 * record itself — and the one call site that got it wrong produced a disc that
 * did not cover its own blades.
 */
export function createSpinner(
  options: PropellerOptions,
  origin: readonly [number, number, number],
  axis: readonly [number, number, number],
  drive: Spinner['drive'],
  direction: 1 | -1 = 1,
): Spinner {
  return {
    geometry: createPropellerGeometry(options),
    disc: createPropellerDisc(options.radius, options.detail === 'high' ? 36 : 14),
    radius: options.radius,
    origin,
    axis,
    direction,
    drive,
  };
}
