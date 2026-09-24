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

import { disposeModel, parsePvm, texturesOf, type LoadedModel } from './pvm';

/** Where the converter writes, relative to the site root. */
const BASE = 'models';

/** Type code -> model id, loaded once from the converter's index. */
let catalogue: Promise<Record<string, string>> | null = null;

/** In-flight and completed loads, so two aircraft of a type share one download. */
const models = new Map<string, Promise<LoadedModel | null>>();

async function loadCatalogue(): Promise<Record<string, string>> {
  catalogue ??= fetch(`${BASE}/index.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, string>>) : {}))
    .catch(() => ({}));
  return catalogue;
}

/** True if a real model exists for this type. Never throws, never blocks long. */
export async function hasModelFor(typeCode: string | null): Promise<boolean> {
  if (!typeCode) return false;
  return (await loadCatalogue())[typeCode.toUpperCase()] !== undefined;
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
 * The real model for a type, or null if there is not one.
 *
 * Cached by model id rather than by type code, because several designators
 * share one airframe — every Dash 8 variant is one file.
 */
export async function loadModelFor(typeCode: string | null): Promise<LoadedModel | null> {
  if (!typeCode) return null;

  const id = (await loadCatalogue())[typeCode.toUpperCase()];
  if (!id) return null;

  let pending = models.get(id);
  if (!pending) {
    pending = fetchModel(id);
    models.set(id, pending);
  }
  return pending;
}

/** Drop everything, for tests and teardown. */
export function clearModelCache(): void {
  for (const pending of models.values()) {
    void pending.then((model) => {
      if (model) disposeModel(model);
    });
  }
  models.clear();
  catalogue = null;
}
