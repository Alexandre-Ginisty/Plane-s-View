/**
 * The things that hang off a wing.
 *
 * Nacelles, pylons and wingtip devices, split out of `fixedWing` because they
 * are the part of an airliner that is *added* rather than shaped: the fuselage
 * and the wing are one continuous surface described by a profile, and these are
 * discrete objects bolted onto it at positions the wing decides.
 *
 * They are also where most of the recognition lives. An airframe is a tube and
 * two swept panels until it has engines under the wing, at which point the eye
 * reads it as an aeroplane — which is why each of these gets more geometry than
 * its size suggests it deserves.
 *
 * Every builder writes into a `MeshBuilder` the caller owns, in the same
 * length-normalised frame as the airframe: nose along **+Y**, starboard along
 * **+X**, up along **+Z**.
 */

import { propBladesFor, wingletStyleFor } from './details';
import type { MeshBuilder } from './meshBuilder';
import { createSpinner, type Spinner } from './propeller';
import type { AirframeShape } from './typeTable';

/**
 * The lip is the detail that does the work: a modern high-bypass nacelle is
 * widest a few inches behind its leading edge and the intake is a shadowed
 * hole, so a plain cylinder reads as a piece of pipe stuck under the wing.
 * Five stations and one dark disc turn it into an engine.
 */
export function addTurbofanNacelle(
  b: MeshBuilder,
  t: MeshBuilder,
  shape: AirframeShape,
  x: number,
  wingY: number,
  wingZ: number,
  side: 1 | -1,
  detail: 'high' | 'low',
  rearMounted = false,
): void {
  const r = shape.radiusRatio;
  const high = detail === 'high';
  const segments = high ? 14 : 5;
  const nacelleR = r * (rearMounted ? 0.66 : 0.8);
  const half = shape.length > 55 ? 0.062 : 0.048;

  // Forward of the leading edge and below the wing, which is what makes a pod
  // read as a pod rather than as wing thickness.
  const ey = rearMounted ? wingY : wingY + half * 1.5;
  const ez = rearMounted ? wingZ : wingZ - nacelleR * 1.25;

  const mark = b.mark();
  b.tubeShaped(
    [
      [ey + half, nacelleR * 0.86, 0],
      [ey + half * 0.94, nacelleR * 1.0, 0],
      [ey + half * 0.45, nacelleR * 1.04, 0],
      [ey - half * 0.35, nacelleR * 0.97, 0],
      [ey - half * 0.9, nacelleR * 0.8, 0],
      [ey - half * 1.05, nacelleR * 0.72, 0],
    ],
    segments,
  );
  b.translateFrom(mark, x, 0, ez);

  if (high) {
    // The fan face: a dark disc set back inside the lip. Without it the intake
    // is a bright hole and the nacelle looks like a bead.
    const faceY = ey + half * 0.5;
    const faceR = nacelleR * 0.86;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const c = ((i + 1) / segments) * Math.PI * 2;
      t.tri(
        x, faceY, ez,
        x + Math.cos(c) * faceR, faceY, ez + Math.sin(c) * faceR,
        x + Math.cos(a) * faceR, faceY, ez + Math.sin(a) * faceR,
      );
    }

    // And the exhaust plug poking out of the nozzle.
    const plug = t.mark();
    t.tube(
      [
        [ey - half * 0.95, nacelleR * 0.6],
        [ey - half * 1.45, nacelleR * 0.3],
        [ey - half * 1.6, 0],
      ],
      segments,
    );
    t.translateFrom(plug, x, 0, ez);
  }

  // --- pylon ---------------------------------------------------------------
  if (rearMounted) {
    // Joining the nacelle inboard to the rear fuselage rather than up to a wing.
    b.panel(
      [x, ey + half * 0.55, ez + nacelleR * 0.1],
      [x, ey - half * 0.8, ez + nacelleR * 0.1],
      [side * r * 0.5, ey + half * 0.45, ez],
      [side * r * 0.5, ey - half * 0.7, ez],
      r * 0.16,
      side === -1,
    );
  } else {
    b.panel(
      [x, ey - half * 0.1, ez + nacelleR * 0.5],
      [x, ey - half * 1.25, ez + nacelleR * 0.5],
      [x, ey - half * 0.1, wingZ],
      [x, ey - half * 1.25, wingZ],
      r * 0.15,
      side === -1,
    );
  }
}

/**
 * Long and slim where the turbofan is short and fat, reaching well ahead of the
 * leading edge because the propeller has to clear it. Drawing these as
 * turbofans — the builder had only one kind of pod — is how an ATR ended up
 * looking like a small regional jet.
 */
export function addTurbopropNacelle(
  b: MeshBuilder,
  t: MeshBuilder,
  shape: AirframeShape,
  spinners: Spinner[],
  x: number,
  wingY: number,
  wingZ: number,
  detail: 'high' | 'low',
): void {
  const r = shape.radiusRatio;
  const high = detail === 'high';
  const segments = high ? 12 : 5;
  const nacelleR = r * 0.52;
  const front = wingY + 0.13;
  const back = wingY - 0.14;
  const ez = wingZ - nacelleR * 0.35;

  const mark = b.mark();
  b.tubeShaped(
    [
      [front, nacelleR * 0.42, 0],
      [front - 0.03, nacelleR * 0.92, 0],
      [front - 0.08, nacelleR, 0],
      [wingY - 0.02, nacelleR * 0.95, 0],
      [back + 0.03, nacelleR * 0.66, 0],
      [back, nacelleR * 0.42, 0],
    ],
    segments,
  );
  b.translateFrom(mark, x, 0, ez);

  if (high) {
    // Exhaust stub on the inboard side, where the Dash 8 and the ATR carry it.
    const stub = t.mark();
    t.tube([[wingY + 0.01, nacelleR * 0.26], [wingY - 0.05, nacelleR * 0.2]], 6);
    t.translateFrom(stub, x, 0, ez + nacelleR * 0.55);
  }

  const blades = propBladesFor(shape);
  if (blades > 0) {
    spinners.push(
      createSpinner(
        { blades, radius: r * 3.6, chord: r * 0.48, spinner: r * 0.7, detail },
        [x, front + 0.008, ez],
        [0, 1, 0],
        'propeller',
      ),
    );
  }
}

/**
 * Small, and disproportionately worth having: the tip is the part of the
 * silhouette the eye follows, and a blunt cut-off tip is the one thing no
 * airliner built in the last thirty years has. Approximated as a flat vertical
 * surface — a sharklet's twenty-degree cant is not visible from anywhere the
 * model is seen from.
 */
export function addWinglet(
  b: MeshBuilder,
  shape: AirframeShape,
  tipFore: readonly [number, number, number],
  tipAft: readonly [number, number, number],
  thickness: number,
  side: 1 | -1,
  span: number,
): void {
  const style = wingletStyleFor(shape);
  if (style === 'none') return;

  if (style === 'raked') {
    // Not an upturned surface at all: the tip simply carries on outboard with
    // far more sweep and almost no chord, which is the 787 and A350 planform.
    const chord = tipFore[1] - tipAft[1];
    const reach = span * 0.07;
    b.panel(
      tipFore,
      tipAft,
      [tipFore[0] + side * reach, tipFore[1] - reach * 1.5, tipFore[2] + reach * 0.35],
      [tipFore[0] + side * reach, tipFore[1] - reach * 1.5 - chord * 0.35, tipFore[2] + reach * 0.35],
      thickness * 0.6,
      side === -1,
    );
    return;
  }

  /*
   * A sharklet, not a plank.
   *
   * The first version stood a rectangle on the wingtip at ninety degrees, at
   * the wing's own thickness and 1.35 times the tip chord tall. From anywhere
   * but dead astern it read as a white board bolted to the wing — which is
   * what it was, and what got reported.
   *
   * Three things separate a winglet from a board, and all three are cheap:
   *
   *  - **Cant.** A blended winglet leans outboard, fifteen to twenty degrees
   *    off vertical. It is the first thing the eye uses to tell a winglet from
   *    a fin, because a fin is vertical and this is not.
   *  - **Sweep.** The leading edge rakes back far harder than the wing's, so
   *    the tip sits well behind the root and the whole surface is a slender
   *    triangle rather than a rectangle.
   *  - **A blended root.** It grows out of the tip over a short chord instead
   *    of meeting it at a corner. The corner is what makes it look bolted on.
   *
   * Built in two panels for that reason: a short blend that leans out of the
   * wing, then the surface proper above it.
   */
  const x = tipFore[0];
  const fore = tipFore[1];
  const aft = tipAft[1];
  const base = tipFore[2];
  const chord = fore - aft;

  const fence = style === 'fence';
  const height = fence ? chord * 0.45 : chord * 1.15;
  const cant = fence ? 0 : height * 0.3;
  const skin = thickness * (fence ? 0.35 : 0.3);

  /** A station along the winglet: how far up, out, and back, and its chord. */
  const station = (
    up: number,
    out: number,
    back: number,
    chordFraction: number,
  ): [readonly [number, number, number], readonly [number, number, number]] => {
    const leading = fore - back * chord;
    return [
      [x + side * out, leading, base + up],
      [x + side * out, leading - chord * chordFraction, base + up],
    ];
  };

  // The blend: a third of the height, leaning out, barely narrowing.
  const root = station(0, 0, 0, 1);
  const knee = station(height * 0.32, cant * 0.45, 0.1, 0.82);
  const tip = station(height, cant, 0.42, 0.34);

  b.panel(root[0], root[1], knee[0], knee[1], skin, side === -1);
  b.panel(knee[0], knee[1], tip[0], tip[1], skin, side === -1);

  if (fence) {
    // A fence runs below the tip as well as above it, and the lower half is
    // shorter — it is there to stop the flow curling round, not to carry load.
    const under = station(-height * 0.6, 0, 0.06, 0.6);
    b.panel(root[0], root[1], under[0], under[1], skin, side === 1);
  }
}
