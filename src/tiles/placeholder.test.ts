import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isNoDataTile } from './placeholder';

const fixture = (name: string): ArrayBuffer => {
  const bytes = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

describe('isNoDataTile', () => {
  it("recognises Esri's 'Map data not yet available' tile", () => {
    expect(isNoDataTile(fixture('esri-no-data.jpg'))).toBe(true);
  });

  it('leaves a real tile of the same length alone', () => {
    const lookalike = new Uint8Array(fixture('esri-no-data.jpg'));
    lookalike[1200] = lookalike[1200]! ^ 0xff;
    expect(isNoDataTile(lookalike.buffer)).toBe(false);
  });

  it('leaves tiles of any other length alone', () => {
    expect(isNoDataTile(new ArrayBuffer(0))).toBe(false);
    expect(isNoDataTile(new ArrayBuffer(40_000))).toBe(false);
  });
});
