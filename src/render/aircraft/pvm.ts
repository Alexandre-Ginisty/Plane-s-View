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
 *   'PVM1'            4 bytes
 *   headerLength      uint32, little-endian, already padded to a multiple of 4
 *   header            UTF-8 JSON, then the padding
 *   payload           the buffers the header points into
 *
 * Offsets in the header are relative to the start of the payload, and every
 * one is a multiple of four so the typed-array views can be taken over the
 * original buffer with no copying.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  MeshLambertMaterial,
  type Texture,
} from 'three';

export type PartRole = 'hull' | 'gear' | 'prop' | 'mainRotor' | 'tailRotor' | 'disc';

interface Range {
  offset: number;
  count: number;
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
}

interface ModelHeader {
  id: string;
  source: string;
  license: string;
  lengthM: number;
  textures: string[];
  parts: PartHeader[];
}

export interface ModelPart {
  role: PartRole;
  name: string;
  geometry: BufferGeometry;
  material: MeshLambertMaterial;
  origin: readonly [number, number, number];
  axis: readonly [number, number, number];
}

export interface LoadedModel {
  id: string;
  source: string;
  license: string;
  /** Length of the source model, metres. Informational: geometry is unit length. */
  lengthM: number;
  parts: ModelPart[];
}

const MAGIC = 'PVM1';

/** Parse a `.pvm` payload into geometries and materials. */
export function parsePvm(
  buffer: ArrayBuffer,
  textures: readonly (Texture | null)[],
): LoadedModel {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== MAGIC) throw new Error(`not a PlanesView model (magic ${JSON.stringify(magic)})`);

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
      new BufferAttribute(new Float32Array(buffer, payload + range.offset, range.count), itemSize);

    geometry.setAttribute('position', floats(part.position, 3));
    geometry.setAttribute('normal', floats(part.normal, 3));
    geometry.setAttribute('uv', floats(part.uv, 2));
    geometry.setIndex(
      new BufferAttribute(new Uint32Array(buffer, payload + part.index.offset, part.index.count), 1),
    );
    geometry.computeBoundingSphere();

    const texture = part.texture >= 0 ? textures[part.texture] ?? null : null;
    const transparent = part.opacity < 0.999;

    const material = new MeshLambertMaterial({
      color: new Color(part.color[0], part.color[1], part.color[2]),
      emissive: new Color(part.emissive[0], part.emissive[1], part.emissive[2]),
      map: texture,
      transparent,
      opacity: part.opacity,
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
      origin: part.origin,
      axis: part.axis,
    });
  }

  return {
    id: header.id,
    source: header.source,
    license: header.license,
    lengthM: header.lengthM,
    parts,
  };
}

/** Texture filenames the model references, in the order `parsePvm` expects. */
export function texturesOf(buffer: ArrayBuffer): string[] {
  const view = new DataView(buffer);
  const headerLength = view.getUint32(4, true);
  const json = new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength));
  return (JSON.parse(json.replace(/\0+$/, '')) as ModelHeader).textures;
}

export function disposeModel(model: LoadedModel): void {
  for (const part of model.parts) {
    part.geometry.dispose();
    part.material.map?.dispose();
    part.material.dispose();
  }
}
