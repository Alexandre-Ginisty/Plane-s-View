/**
 * The downloadable model library.
 *
 * Real, textured airframes for the types that have one, converted from
 * FlightGear's hangar by `tools/fgmodel` (see that script for the licensing
 * and the axis conventions). Everything else keeps the procedural model, which
 * is the point of the arrangement: the library covers the types people
 * actually fly in, and the generator covers the other six hundred designators
 * so nothing is ever drawn as a placeholder.
 *
 * ## Why this is asynchronous and never blocks
 *
 * A model is about a megabyte with its textures. On the connection this app is
 * built for that is a second or two, and making the aircraft wait for it would
 * put a hole in the middle of the screen at exactly the moment the user
 * stepped inside. So the procedural model is built and shown immediately and
 * the downloaded one replaces it when it lands — a visible upgrade a moment
 * later rather than a stall.
 *
 * ## Why it is gated on the detail setting
 *
 * The same reason the terrain is. A megabyte for a better-looking aeroplane is
 * a poor trade on a phone tether, and the user has already said which side of
 * that trade they are on.
 */

import { TextureLoader, SRGBColorSpace, type Texture } from 'three';

import { parsePvm, texturesOf, withLivery, type LoadedModel } from './pvm';
import { shapeFor } from './shapes';
import type { AirframeShape } from './typeTable';

type AirframeKind = AirframeShape['kind'];

/** Where the converter writes, relative to the site root. */
const BASE = 'models';

/**
 * The converter's catalogue.
 *
 * `types` maps an ICAO type designator to a model id; `liveries` maps a model
 * id to the operator paint schemes that exist for it, by ICAO airline
 * designator, plus a `NEUTRAL` entry.
 */
interface Catalogue {
  types: Record<string, string>;
  liveries: Record<string, Record<string, string>>;
  /** Model to use when the exact type has no entry, by airframe kind. */
  fallback: Partial<Record<AirframeKind, string>>;
}

let catalogue: Promise<Catalogue | null> | null = null;

/** In-flight and completed loads, so two aircraft of a type share one download. */
const models = new Map<string, Promise<LoadedModel | null>>();

/**
 * The catalogue, fetched once — but only *cached* once it has succeeded.
 *
 * A failure is not cached, and that distinction matters more here than
 * anywhere else in the file. This app is built to be opened on a phone tether
 * and to recover when the link comes back; caching the empty object from one
 * failed request would mean a single bad moment at boot disables every
 * downloadable model for the rest of the session, silently, with the
 * procedural fallback quietly standing in and nothing ever retrying.
 */
async function loadCatalogue(): Promise<Catalogue | null> {
  catalogue ??= fetch(`${BASE}/index.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Catalogue>) : null))
    .catch(() => null);

  const attempt = catalogue;
  const result = await attempt;
  // Only clear the attempt we awaited. A second caller that arrived after this
  // one failed has already started a fresh request; clearing unconditionally
  // would drop it and send a third caller off to fetch the same file again.
  if (result === null && catalogue === attempt) catalogue = null;
  return result;
}

function loadTexture(name: string): Promise<Texture | null> {
  return new Promise((resolve) => {
    new TextureLoader().load(
      `${BASE}/${name}`,
      (texture) => {
        // The liveries are authored as colour, not as data.
        texture.colorSpace = SRGBColorSpace;
        texture.flipY = true;
        resolve(texture);
      },
      undefined,
      () => resolve(null),
    );
  });
}

async function fetchModel(id: string): Promise<LoadedModel | null> {
  try {
    const response = await fetch(`${BASE}/${id}.pvm`);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();

    // Textures first: handing `parsePvm` a null map and patching it later
    // means a frame or two of untextured white, which reads as a bug.
    const textures = await Promise.all(texturesOf(buffer).map(loadTexture));
    return parsePvm(buffer, textures);
  } catch {
    // A model that will not load is not an error the user can act on — the
    // procedural one is already on screen and stays there.
    return null;
  }
}

/**
 * The airline an ADS-B callsign belongs to, or null.
 *
 * A commercial callsign is the operator's three-letter ICAO designator
 * followed by a flight number — `AFR1180`, `BAW117`. Anything else is a
 * registration flying privately, which has no operator and no livery.
 */
export function operatorOf(callsign: string | null | undefined): string | null {
  const match = /^([A-Z]{3})\d/.exec((callsign ?? '').trim().toUpperCase());
  return match?.[1] ?? null;
}

/** In-flight and completed livery texture loads, one per file. */
const liveries = new Map<string, Promise<Texture | null>>();

/**
 * The real model for a type, in an operator's colours where one exists.
 *
 * ## Why the livery matters more than the airframe
 *
 * Every 777 variant shares one converted model, and that model arrives wearing
 * whichever paint scheme the upstream author happened to author it in. Shipping
 * that as-is put a single airline's livery on every 777 in the sky, which is
 * not a rough approximation of the truth — it is a specific false statement
 * about an aircraft the viewer can see the registration of.
 *
 * So the operator is read from the callsign and the matching livery swapped in.
 * When there is no match the *neutral* scheme is used, never another airline's:
 * a white aircraft is honest about not knowing, and a Qatar 777 painted as
 * Emirates is not.
 *
 * Cached by model id rather than by type code, because several designators
 * share one airframe — every Dash 8 variant is one file.
 */
export async function loadModelFor(
  typeCode: string | null,
  operator?: string | null,
  category?: string | null,
): Promise<LoadedModel | null> {
  if (!typeCode) return null;

  const index = await loadCatalogue();
  if (!index) return null;

  /*
   * Exact type, then the nearest model of the same kind.
   *
   * Two dozen airframes against six hundred designators means a miss is the
   * common case, and the alternative to a fallback is the procedural
   * generator — a decent silhouette that is unmistakably not a photograph of
   * an aeroplane. A real model of the wrong variant reads as far more true
   * than an accurate drawing of a generic one, and every helicopter in the
   * sky looks more like an EC135 than like anything a mesh generator makes.
   *
   * The fallback is per *kind*, never per type, so an unknown narrowbody
   * cannot be handed a helicopter. Where the kind is unknown too, nothing is
   * downloaded and the generator keeps the aircraft.
   */
  const upper = typeCode.toUpperCase();
  const id = index.types[upper] ?? index.fallback[shapeFor(upper, category ?? null).kind];
  if (!id) return null;

  // A livery belongs to the airframe it was painted for. Putting an Air France
  // 777 scheme on the generic narrowbody that stood in for an A320 would be a
  // worse lie than the substitution itself.
  const exact = index.types[upper] === id;

  let pending = models.get(id);
  if (!pending) {
    pending = fetchModel(id);
    models.set(id, pending);
  }

  const model = await pending;
  // Same reasoning as the catalogue: a download that failed is a download
  // worth trying again the next time this type comes round, not a permanent
  // verdict that the type has no model. The identity check keeps that retry
  // from evicting a newer attempt someone else has already started.
  if (model === null && models.get(id) === pending) models.delete(id);
  if (model === null) return null;

  const paint = exact ? await loadLivery(index, id, operator ?? null) : null;
  return paint ? withLivery(model, paint) : model;
}

/**
 * The livery texture for an operator, the neutral one, or null.
 *
 * Separate from the model download and cached separately, because the model is
 * shared by every 777 on screen while the paint is not — and because a visitor
 * who never flies a Qatar 777 should never download Qatar's paint.
 */
async function loadLivery(
  index: Catalogue,
  id: string,
  operator: string | null,
): Promise<Texture | null> {
  const available = index.liveries[id];
  if (!available) return null;

  const file = (operator ? available[operator] : null) ?? available['NEUTRAL'];
  if (!file) return null;

  let pending = liveries.get(file);
  if (!pending) {
    pending = loadTexture(file);
    liveries.set(file, pending);
  }

  const texture = await pending;
  if (texture === null && liveries.get(file) === pending) liveries.delete(file);
  return texture;
}
