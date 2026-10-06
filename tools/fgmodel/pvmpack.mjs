/**
 * Compact `.pvm` encoding: the same model in a little over half the bytes.
 *
 * The converters build a model with float vertex data (`PVM1`); this turns it
 * into `PVM2`, which the loader reads alongside the old one:
 *
 *  - **Positions** as 16-bit integers over each part's own bounding box
 *    (`quant`: centre and half-extent). The grid step is under a millimetre
 *    on an 80 m airliner and on a 30 m cabin.
 *  - **Normals** as 8-bit integers: half a degree, far below what Lambert
 *    shading shows.
 *  - **Indices** as 16-bit wherever a part has fewer than 65,536 vertices —
 *    all but a handful.
 *  - **UVs** unchanged: tiled coordinates run far past 0–1 and a half float
 *    would be a texel out on the big sheets.
 *
 * Every range stays four-byte aligned so the loader still takes typed-array
 * views without copying. Run as a script, it re-packs files in place:
 *
 *   node tools/fgmodel/pvmpack.mjs public/models/*.pvm
 */

import { readFileSync, writeFileSync } from 'node:fs';

const align = (n) => (n + 3) & ~3;

function readPvm(blob) {
  const magic = blob.toString('ascii', 0, 4);
  const headerLength = blob.readUInt32LE(4);
  const header = JSON.parse(blob.toString('utf8', 8, 8 + headerLength).replace(/\0+$/, ''));
  return { magic, header, payload: blob.subarray(8 + headerLength) };
}

function writePvm(magic, header, chunks) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const head = Buffer.alloc(8);
  head.write(magic, 0, 'ascii');
  head.writeUInt32LE(json.length + pad, 4);
  return Buffer.concat([head, json, Buffer.alloc(pad), ...chunks]);
}

/** A `PVM1` blob as `PVM2`; a `PVM2` blob is returned unchanged. */
export function packPvm(blob) {
  const { magic, header, payload } = readPvm(blob);
  if (magic === 'PVM2') return blob;
  if (magic !== 'PVM1') throw new Error(`not a PlanesView model (${magic})`);
  const f32 = (r) => new Float32Array(payload.buffer.slice(payload.byteOffset + r.offset, payload.byteOffset + r.offset + r.count * 4));

  const chunks = [];
  let offset = 0;
  const push = (bytes) => {
    const padded = Buffer.alloc(align(bytes.length));
    bytes.copy(padded);
    chunks.push(padded);
    const at = offset;
    offset += padded.length;
    return at;
  };

  for (const part of header.parts) {
    // Positions: centre and half-extent per axis, then ±32767 across it.
    const pos = f32(part.position);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i++) {
      const a = i % 3;
      if (pos[i] < lo[a]) lo[a] = pos[i];
      if (pos[i] > hi[a]) hi[a] = pos[i];
    }
    const centre = lo.map((l, a) => (pos.length ? (l + hi[a]) / 2 : 0));
    const half = lo.map((l, a) => (pos.length ? Math.max((hi[a] - l) / 2, 1e-9) : 1));
    const q = new Int16Array(pos.length);
    for (let i = 0; i < pos.length; i++) {
      const a = i % 3;
      q[i] = Math.max(-32767, Math.min(32767, Math.round(((pos[i] - centre[a]) / half[a]) * 32767)));
    }
    part.quant = [...centre, ...half];
    part.position = { offset: push(Buffer.from(q.buffer)), count: pos.length, type: 'i16' };

    const nrm = f32(part.normal);
    const n8 = new Int8Array(nrm.length);
    for (let i = 0; i < nrm.length; i++) n8[i] = Math.max(-127, Math.min(127, Math.round(nrm[i] * 127)));
    part.normal = { offset: push(Buffer.from(n8.buffer)), count: nrm.length, type: 'i8' };

    part.uv = { offset: push(Buffer.from(f32(part.uv).buffer)), count: part.uv.count };

    const idx = new Uint32Array(payload.buffer.slice(payload.byteOffset + part.index.offset, payload.byteOffset + part.index.offset + part.index.count * 4));
    if (pos.length / 3 <= 65536) {
      part.index = { offset: push(Buffer.from(Uint16Array.from(idx).buffer)), count: idx.length, type: 'u16' };
    } else {
      part.index = { offset: push(Buffer.from(idx.buffer)), count: idx.length };
    }

    if (part.ao) part.ao = { offset: push(Buffer.from(payload.subarray(part.ao.offset, part.ao.offset + part.ao.count))), count: part.ao.count };
    // An airport pack: which building each vertex belongs to, 16-bit.
    if (part.inst) part.inst = { offset: push(Buffer.from(payload.subarray(part.inst.offset, part.inst.offset + part.inst.count * 2))), count: part.inst.count, type: 'u16' };
  }
  return writePvm('PVM2', header, chunks);
}

/** Rewrite a model's header in place; `edit` returns true when it changed something. */
export function editHeader(blob, edit) {
  const { magic, header, payload } = readPvm(blob);
  return edit(header) ? writePvm(magic, header, [payload]) : blob;
}

/** Replace texture names in a model's header (a re-encoded or de-duplicated file). */
export function renameTextures(blob, rename) {
  const { magic, header, payload } = readPvm(blob);
  header.textures = header.textures.map((t) => rename(t) ?? t);
  return writePvm(magic, header, [payload]);
}

export function texturesOf(blob) {
  return readPvm(blob).header.textures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let before = 0;
  let after = 0;
  for (const path of process.argv.slice(2)) {
    const blob = readFileSync(path);
    const packed = packPvm(blob);
    before += blob.length;
    after += packed.length;
    if (packed !== blob) writeFileSync(path, packed);
  }
  console.log(`${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(1)} MB`);
}
