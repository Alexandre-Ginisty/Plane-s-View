/**
 * Tiles that are pictures of "no picture".
 *
 * Past its coverage — open ocean at deep zoom, mostly — Esri World Imagery
 * does not answer 404. It answers 200 with a grey JPEG reading "Map data not
 * yet available", and the globe drew it: from a cockpit over the sea, a
 * checkerboard of grey squares with mirrored text on them, right under the
 * aircraft, where the eye looks most.
 *
 * The image is the same file at every zoom, byte for byte, so it is
 * recognised by its length and a hash of its bytes rather than by looking at
 * its pixels: exact, a few microseconds, and a real photograph of grey
 * concrete can never be mistaken for it. A tile recognised here is treated
 * like one past the layer's maximum zoom — the ancestor's imagery is kept,
 * one level softer and the right colour.
 */

/** Length and FNV-1a hash of Esri's placeholder, as served in 2026. */
const KNOWN: ReadonlyArray<{ length: number; hash: number }> = [{ length: 2521, hash: 0x92d9118f }];

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function isNoDataTile(data: ArrayBuffer): boolean {
  const length = data.byteLength;
  // The length check first: every real tile is rejected without hashing.
  if (!KNOWN.some((k) => k.length === length)) return false;
  const hash = fnv1a(new Uint8Array(data));
  return KNOWN.some((k) => k.length === length && k.hash === hash);
}
