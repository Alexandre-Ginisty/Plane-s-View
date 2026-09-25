/**
 * Putting an aircraft on the ground instead of through it.
 *
 * ## The bug this exists to fix
 *
 * An aircraft on the surface broadcasts `alt_baro: "ground"` — a string, not a
 * number — and normally broadcasts no geometric altitude at all. The feed
 * normaliser turns that into zero feet, and zero feet, fed to `geodeticToEcef`,
 * means *zero metres above the WGS84 ellipsoid*. That is not the ground: at
 * Heathrow it is about 70 m below it, at Charles de Gaulle about 165 m.
 *
 * Measured against the live feed, a single snapshot of Heathrow carried 41
 * aircraft reporting `ground`, every one of them buried. They are not
 * invisible, either: wherever the terrain mesh dips between them and the
 * camera, a wingtip or a fin surfaces. Those are the spikes around airports.
 *
 * ## Why a clamp rather than a datum fix
 *
 * The honest fix is a geoid model, because barometric altitude is referenced
 * to mean sea level and the terrain tiles are elevations above mean sea level,
 * while `geodeticToEcef` wants height above the ellipsoid — three datums, two
 * of which need the geoid separation to convert between them. A geoid grid is
 * a megabyte of data to solve a problem that only shows within a few hundred
 * metres of the ground.
 *
 * Near the ground, the terrain itself is the better authority, and it is
 * already loaded. So: when the feed says the aircraft is on the surface, put
 * it on the surface; otherwise never let it go below the surface. Both answers
 * come from the same tiles that draw the ground, so the aircraft sits on the
 * terrain the user can actually see, which is the only thing being judged.
 */

import type { AirframeShape } from './aircraft';

/**
 * Above this height, skip the terrain sample entirely.
 *
 * Nothing on Earth reaches 6 km except the great ranges, and an airliner over
 * the Himalaya at that height is not the case this protects. The gate matters
 * because the sample walks the quadtree from the root, and paying for that on
 * every cruising aircraft in a 120 km circle, sixty times a second, is real
 * work for an answer that can never change the outcome.
 */
export const GROUND_CHECK_CEILING_M = 6000;

/**
 * How far the model's origin sits above the ground when parked, metres.
 *
 * The geometry is built around the fuselage centreline, so resting it on the
 * terrain means lifting it by the fuselage radius plus the undercarriage —
 * close enough to twice the radius for every airframe from a Cessna to an
 * A380, and it falls out of proportions the shape already carries.
 */
export function clearanceFor(shape: AirframeShape): number {
  return Math.max(0.6, shape.radiusRatio * shape.length * 1.9);
}

/**
 * The altitude to actually draw at, metres above the ellipsoid.
 *
 * `terrainM` is what the resident tiles say, and **NaN when they do not know**
 * — which is the case that matters. An aircraft descending into an airfield
 * arrives ahead of the tiles that cover it, so the moment the clamp is needed
 * most is the moment it is least likely to have an answer.
 *
 * Told nothing, it changes nothing: the reported altitude is drawn as-is. That
 * is wrong by whatever the airfield's elevation is, but it is wrong by less
 * than treating "unknown" as sea level, which planted every aircraft at Charles
 * de Gaulle a hundred and sixty-five metres underground. Callers that can do
 * better — by remembering where the ground was a moment ago — should; see
 * `GroundMemory`.
 */
export function surfaceAltitudeM(
  altM: number,
  onGround: boolean,
  terrainM: number,
  clearanceM: number,
): number {
  if (!Number.isFinite(terrainM)) return altM;

  const floor = terrainM + clearanceM;
  // On the surface, the reported altitude carries no information at all — it
  // is the literal zero the normaliser substituted for the string "ground".
  if (onGround) return floor;
  return Math.max(altM, floor);
}

/**
 * The last place the ground was known to be.
 *
 * A landing aircraft crosses a few kilometres of airfield in the seconds it
 * takes the deep tiles to arrive, and an airfield is flat — so the elevation
 * measured three hundred metres back is within a metre or two of the runway.
 * Holding it is a far better answer than "unknown", and an enormously better
 * one than sea level.
 *
 * It is deliberately not distance-limited. The failure it guards against lasts
 * seconds and resolves itself; a stale value is only ever consulted when the
 * alternative is no value at all, and terrain that far out of date would mean
 * the tiles have stopped arriving entirely, which the aircraft flying over
 * unloaded ground already looks like.
 */
export class GroundMemory {
  private known = Number.NaN;

  /** Feed a fresh sample, and get the best available answer. */
  update(sampled: number): number {
    if (Number.isFinite(sampled)) this.known = sampled;
    return this.known;
  }

  forget(): void {
    this.known = Number.NaN;
  }
}
