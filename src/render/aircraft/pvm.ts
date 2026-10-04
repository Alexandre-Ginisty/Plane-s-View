/**
 * Reading a converted FlightGear model.
 *
 * `.pvm` is this project's own container, written by `tools/fgmodel`. glTF was
 * the obvious alternative and was not chosen: it would mean shipping a loader
 * for a large general-purpose format to read files produced by one script in
 * the same repository, when what has to cross the wire is a handful of vertex
 * buffers and a material per part. The format is a JSON header naming byte
 * ranges, followed by those ranges.
 *
 *   'PVM1' | 'PVM2'   4 bytes
 *   headerLength      uint32, little-endian, already padded to a multiple of 4
 *   header            UTF-8 JSON, then the padding
 *   payload           the buffers the header points into
 *
 * Offsets in the header are relative to the start of the payload, and every
 * one is a multiple of four so the typed-array views can be taken over the
 * original buffer with no copying.
 *
 * `PVM2` (see `tools/fgmodel/pvmpack.mjs`) stores the same model compactly:
 * positions as 16-bit integers over the part's box (`quant`), normals as
 * 8-bit, indices as 16-bit where they fit. Vertex data is widened back to
 * floats here, so nothing downstream sees the difference; only the download
 * shrinks.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  MeshLambertMaterial,
  RepeatWrapping,
  type Texture,
} from 'three';

type PartRole = 'hull' | 'gear' | 'prop' | 'mainRotor' | 'tailRotor' | 'disc';

interface Range {
  offset: number;
  count: number;
  /** Stored type, when not the float (or, for indices, uint32) default. */
  type?: 'i16' | 'i8' | 'u16';
}

interface PartHeader {
  role: PartRole;
  name: string;
  texture: number;
  color: [number, number, number];
  emissive: [number, number, number];
  opacity: number;
  origin: [number, number, number];
  axis: [number, number, number];
  position: Range;
  normal: Range;
  uv: Range;
  index: Range;
  /** The texture has cut-outs (a cockpit's bezels, grilles): drawn with an alpha test. */
  alpha?: boolean;
  /** The texture tiles (a cockpit's lining): its coordinates run past 0–1. */
  repeat?: boolean;
  /** A cockpit only: baked openness per vertex, one byte each (255 = open). */
  ao?: Range;
  /** `PVM2` positions: the box centre and half-extent they are quantised over. */
  quant?: [number, number, number, number, number, number];
}

/** A cockpit display's face, about the eye: +X right, +Y up, −Z forward, metres, radians. */
interface DisplayFace {
  id: 'pfd' | 'nd' | 'eicas' | 'radar' | 'systems' | 'sixpack';
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  tilt: number;
  yaw: number;
}

interface ModelHeader {
  id: string;
  source: string;
  license: string;
  lengthM: number;
  textures: string[];
  /** Texture slot an operator livery replaces, or -1 if the model has none. */
  liveryTexture?: number;
  /** A cockpit only: the eye in its exterior model, normalised, nose +Y, up +Z, about the centre. */
  shellEye?: [number, number, number] | null;
  /** A cockpit only: the faces its live displays are laid over. */
  displays?: DisplayFace[];
  /** A cockpit or cabin: where the view rests, radians (yaw left of the nose, pitch up). */
  look?: { yaw: number; pitch: number } | null;
  /** A cabin drawn in other airframes too: its eye in each, by model id. */
  shellEyes?: Record<string, [number, number, number] | null>;
  /** The undercarriage never retracts (a Cessna 172's): drawn down at every height. */
  fixedGear?: boolean;
  parts: PartHeader[];
}

interface ModelPart {
  role: PartRole;
  name: string;
  geometry: BufferGeometry;
  material: MeshLambertMaterial;
  /** Which of the model's textures this part is painted with, or -1. */
  textureIndex: number;
  origin: readonly [number, number, number];
  axis: readonly [number, number, number];
}

export interface LoadedModel {
  id: string;
  source: string;
  license: string;
  /** Length of the source model, metres. Informational: geometry is unit length. */
  lengthM: number;
  /** Texture slot an operator livery replaces, or -1 if the model has none. */
  liveryTexture: number;
  /** A cockpit only: the eye in its exterior model (see the header). */
  shellEye: readonly [number, number, number] | null;
  displays: readonly DisplayFace[];
  look: { yaw: number; pitch: number } | null;
  shellEyes: Readonly<Record<string, readonly [number, number, number] | null>>;
  /** The undercarriage never retracts: `gear` parts are drawn at every height. */
  fixedGear: boolean;
  parts: ModelPart[];
}

const MAGICS = ['PVM1', 'PVM2'];

/** Vertex data widened to floats, whatever it was stored as. */
function floatsOf(buffer: ArrayBuffer, at: number, range: Range, quant?: readonly number[]): Float32Array {
  if (range.type === 'i16') {
    const q = new Int16Array(buffer, at, range.count);
    const out = new Float32Array(range.count);
    const k = quant ?? [0, 0, 0, 1, 1, 1];
    const s0 = k[3]! / 32767, s1 = k[4]! / 32767, s2 = k[5]! / 32767;
    for (let i = 0; i < out.length; i += 3) {
      out[i] = k[0]! + q[i]! * s0;
      out[i + 1] = k[1]! + q[i + 1]! * s1;
      out[i + 2] = k[2]! + q[i + 2]! * s2;
    }
    return out;
  }
  if (range.type === 'i8') {
    const q = new Int8Array(buffer, at, range.count);
    const out = new Float32Array(range.count);
    for (let i = 0; i < out.length; i++) out[i] = q[i]! / 127;
    return out;
  }
  return new Float32Array(buffer, at, range.count);
}

/** Whether any coordinate lies clear of the 0–1 square (a margin for a sheet a little oversewn at its edge). */
function outsideUnitSquare(uv: Float32Array): boolean {
  for (let i = 0; i < uv.length; i++) if (uv[i]! < -0.1 || uv[i]! > 1.1) return true;
  return false;
}

/** Parse a `.pvm` payload into geometries and materials. */
export function parsePvm(
  buffer: ArrayBuffer,
  textures: readonly (Texture | null)[],
): LoadedModel {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (!MAGICS.includes(magic)) throw new Error(`not a PlanesView model (magic ${JSON.stringify(magic)})`);

  const view = new DataView(buffer);
  const headerLength = view.getUint32(4, true);
  const headerStart = 8;
  const payload = headerStart + headerLength;

  const json = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength));
  // The header is padded with NULs to a four-byte boundary; JSON.parse will not
  // have them.
  const header = JSON.parse(json.replace(/\0+$/, '')) as ModelHeader;

  const parts: ModelPart[] = [];

  for (const part of header.parts) {
    const geometry = new BufferGeometry();
    const floats = (range: Range, itemSize: number): BufferAttribute =>
      new BufferAttribute(floatsOf(buffer, payload + range.offset, range, part.quant), itemSize);

    geometry.setAttribute('position', floats(part.position, 3));
    geometry.setAttribute('normal', floats(part.normal, 3));
    geometry.setAttribute('uv', floats(part.uv, 2));
    const at = payload + part.index.offset;
    geometry.setIndex(
      new BufferAttribute(
        part.index.type === 'u16' ? new Uint16Array(buffer, at, part.index.count) : new Uint32Array(buffer, at, part.index.count),
        1,
      ),
    );
    geometry.computeBoundingSphere();
    if (part.ao) {
      // Grey vertex colours: the baked contact shadow, multiplied into the material.
      const bytes = new Uint8Array(buffer, payload + part.ao.offset, part.ao.count);
      const grey = new Float32Array(bytes.length * 3);
      for (let i = 0; i < bytes.length; i++) grey[i * 3] = grey[i * 3 + 1] = grey[i * 3 + 2] = bytes[i]! / 255;
      geometry.setAttribute('color', new BufferAttribute(grey, 3));
    }

    const texture = part.texture >= 0 ? textures[part.texture] ?? null : null;
    /*
     * Coordinates past the unit square tile the texture in the simulator, which
     * wraps by default; here the default is to clamp, which smears the sheet's
     * edge pixels across the surface into streaks. Seat fabric, carpet, wall
     * lining and floors run to dozens of repeats, so the part's own coordinates
     * decide, not only the converter's `repeat` flag.
     */
    const tiles = part.repeat === true || (texture !== null && outsideUnitSquare(geometry.getAttribute('uv').array as Float32Array));
    if (texture && tiles && texture.wrapS !== RepeatWrapping) {
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.needsUpdate = true;
    }

    /*
     * Anything that turns is transparent from the start.
     *
     * Blades cross-fade into their blur disc as the rate climbs, so their
     * opacity is animated every frame. Setting `transparent` here rather than
     * in the renderer matters because models are cached and shared: a consumer
     * flipping the flag on a material it did not create leaves that change
     * behind for whoever loads the type next, and `transparent` also changes
     * the draw order, so the effect is not local.
     */
    const spins = part.role === 'prop' || part.role === 'mainRotor' || part.role === 'tailRotor';
    const transparent = part.opacity < 0.999 || spins || part.role === 'disc';

    const material = new MeshLambertMaterial({
      color: new Color(part.color[0], part.color[1], part.color[2]),
      emissive: new Color(part.emissive[0], part.emissive[1], part.emissive[2]),
      map: texture,
      transparent,
      opacity: part.opacity,
      alphaTest: part.alpha ? 0.5 : 0,
      vertexColors: Boolean(part.ao),
      /*
       * Two-sided throughout.
       *
       * These models are authored for a simulator that does not cull, so a
       * fair number of surfaces — control surfaces, gear doors, the thin
       * trailing edges — are single quads whose winding was never checked
       * from outside. Culling them produces holes that appear from one side
       * only, which is the hardest kind of artefact to notice and the easiest
       * to avoid: the parts are small and the cost is nil.
       */
      side: DoubleSide,
    });

    parts.push({
      role: part.role,
      name: part.name,
      geometry,
      material,
      textureIndex: part.texture,
      origin: part.origin,
      axis: part.axis,
    });
  }

  return {
    id: header.id,
    source: header.source,
    license: header.license,
    lengthM: header.lengthM,
    liveryTexture: header.liveryTexture ?? -1,
    shellEye: header.shellEye ?? null,
    displays: header.displays ?? [],
    look: header.look ?? null,
    shellEyes: header.shellEyes ?? {},
    fixedGear: header.fixedGear === true,
    parts,
  };
}

/**
 * The same model in a different operator's paint.
 *
 * Geometry is shared, not copied. A livery changes one texture slot and
 * nothing else, so re-parsing the buffer per airline would upload thirty
 * thousand triangles to the GPU again for a change of colour — and a session
 * that passes half a dozen different 777s would do it half a dozen times.
 * Only the materials of the parts actually wearing the livery are cloned.
 *
 * The original is left untouched, because it is the cache entry every other
 * caller is sharing.
 */
export function withLivery(model: LoadedModel, texture: Texture): LoadedModel {
  if (model.liveryTexture < 0) return model;

  return {
    ...model,
    parts: model.parts.map((part) => {
      if (part.textureIndex !== model.liveryTexture) return part;
      const material = part.material.clone();
      material.map = texture;
      material.needsUpdate = true;
      return { ...part, material };
    }),
  };
}

/** Texture filenames the model references, in the order `parsePvm` expects. */
export function texturesOf(buffer: ArrayBuffer): string[] {
  const view = new DataView(buffer);
  const headerLength = view.getUint32(4, true);
  const json = new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength));
  return (JSON.parse(json.replace(/\0+$/, '')) as ModelHeader).textures;
}
