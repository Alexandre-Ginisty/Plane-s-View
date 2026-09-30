/**
 * SGI `.rgb` images, decoded to RGBA.
 *
 * Older FlightGear models — cockpits especially — are textured with SGI
 * images, which neither the image encoder here nor any browser reads. The
 * format is small: a 512-byte header, then one plane per channel, each row
 * stored bottom-up either verbatim or run-length encoded.
 */

/** True when the buffer starts with the SGI magic number. */
export const isSgi = (data) => data.length > 512 && data.readUInt16BE(0) === 474;

/**
 * @param {Buffer} data
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
export function decodeSgi(data) {
  const rle = data[2] === 1;
  const bpc = data[3];
  if (bpc !== 1) throw new Error(`SGI with ${bpc} bytes per channel`);
  const width = data.readUInt16BE(6);
  const height = data.readUInt16BE(8);
  const channels = data.readUInt16BE(4) < 3 ? 1 : data.readUInt16BE(10);

  // Planes as written: channel-major, bottom row first.
  const planes = Array.from({ length: channels }, () => Buffer.alloc(width * height));
  if (!rle) {
    for (let c = 0; c < channels; c++) data.copy(planes[c], 0, 512 + c * width * height, 512 + (c + 1) * width * height);
  } else {
    for (let c = 0; c < channels; c++) {
      for (let y = 0; y < height; y++) {
        let at = data.readUInt32BE(512 + (c * height + y) * 4);
        const row = planes[c];
        let x = y * width;
        const end = x + width;
        for (;;) {
          const byte = data[at++];
          const count = byte & 0x7f;
          if (!count || at > data.length) break;
          if (byte & 0x80) {
            for (let k = 0; k < count && x < end; k++) row[x++] = data[at++];
          } else {
            const v = data[at++];
            for (let k = 0; k < count && x < end; k++) row[x++] = v;
          }
        }
      }
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width;
    for (let x = 0; x < width; x++) {
      const i = src + x;
      const o = (y * width + x) * 4;
      const g = planes[0][i];
      rgba[o] = g;
      rgba[o + 1] = channels >= 3 ? planes[1][i] : g;
      rgba[o + 2] = channels >= 3 ? planes[2][i] : g;
      rgba[o + 3] = channels === 4 ? planes[3][i] : channels === 2 ? planes[1][i] : 255;
    }
  }
  return { width, height, rgba };
}
