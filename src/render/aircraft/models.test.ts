/**
 * The shipped airframes, read off disk.
 *
 * A converted model can be wrong in a way nothing else notices: it type-checks,
 * it loads, it renders, and the aeroplane is simply missing a piece. The report
 * that prompted this was "I see the body but not the wings" — and the cause was
 * a classifier that read the *texture* name, so the MD-80's `txt_hstab_gear`
 * sheet made the whole horizontal stabiliser undercarriage, which the renderer
 * then retracted above circuit height.
 *
 * The converter validates this too, but only when someone runs it. These tests
 * check what is actually committed, which is what visitors are served.
 */

import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const DIR = 'public/models';

interface Part {
  role: string;
  name: string;
  /**
   * Where the part sits, and why measuring without it is wrong.
   *
   * A spinner's vertices are stored around its own hub so it can be rotated in
   * place, with the offset back to airframe space kept here. Measuring the raw
   * positions therefore collapses every rotor blade onto the centreline —
   * which is how a correctly normalised Bo 105 came out at 0.77 of unit
   * length once its flat blur discs stopped padding the bounding box.
   */
  origin: [number, number, number];
  position: { offset: number; count: number };
}

interface Header {
  id: string;
  lengthM: number;
  /** True for a helicopter. Written by the converter, not inferred here. */
  rotorcraft: boolean;
  parts: Part[];
}

/** Header JSON plus the byte offset its payload starts at. */
function readModel(file: string): { header: Header; buffer: Buffer; payload: number } {
  const buffer = readFileSync(`${DIR}/${file}`);
  const headerLength = buffer.readUint32LE(4);
  const headerStart = 8;
  const json = buffer
    .subarray(headerStart, headerStart + headerLength)
    .toString('utf8')
    .replace(/\0+$/, '');
  // The header is padded to a four-byte boundary; the payload follows it.
  const payload = headerStart + headerLength;
  return { header: JSON.parse(json) as Header, buffer, payload };
}

/** Extent of a set of parts along each axis, in normalised model units. */
function extentOf(
  model: ReturnType<typeof readModel>,
  keep: (part: Part) => boolean,
): { x: number; y: number; z: number } | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const part of model.header.parts) {
    if (!keep(part)) continue;
    const start = model.payload + part.position.offset;
    for (let i = 0; i < part.position.count; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = model.buffer.readFloatLE(start + (i + a) * 4) + (part.origin[a] ?? 0);
        min[a] = Math.min(min[a]!, v);
        max[a] = Math.max(max[a]!, v);
      }
    }
  }

  if (!Number.isFinite(min[0]!)) return null;
  return { x: max[0]! - min[0]!, y: max[1]! - min[1]!, z: max[2]! - min[2]! };
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.pvm'));

/*
 * Helicopters are exempt from the wing rules — their "span" is a rotor and they
 * have no fixed lifting surface. The flag is written by the converter rather
 * than inferred here, because the obvious inference ("it has a `mainRotor`
 * part") is circular: the R44 and UH-1 had *no* rotor, which is exactly the
 * fault that needed catching, and inferring would have exempted them from it.
 */

describe('every converted model', () => {
  it('ships at least the busiest airframes', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it.each(files)('%s has geometry in every part it declares', (file) => {
    const model = readModel(file);
    expect(model.header.parts.length).toBeGreaterThan(0);
    for (const part of model.header.parts) {
      expect(part.position.count, `${part.name} is empty`).toBeGreaterThan(0);
    }
  });

  it.each(files)('%s still has its wings once the gear retracts', (file) => {
    const model = readModel(file);
    if (model.header.rotorcraft) return;

    // Everything roled `gear` is hidden above circuit height. A lifting surface
    // misclassified as undercarriage therefore vanishes in the cruise, and it
    // always takes span with it — which is the one thing a fuselage does not
    // have. Normalised models are unit length along +Y, so this is a ratio.
    const cruise = extentOf(model, (part) => part.role !== 'gear');
    expect(cruise, 'nothing is drawn at cruise').not.toBeNull();
    expect(cruise!.x / cruise!.y, `${model.header.id} has no wings at cruise`).toBeGreaterThan(0.6);
  });

  it.each(files)('%s keeps its undercarriage underneath it', (file) => {
    const model = readModel(file);
    const gear = model.header.parts.filter((part) => part.role === 'gear');
    if (gear.length === 0) return;

    const whole = extentOf(model, () => true)!;
    const gearBox = extentOf(model, (part) => part.role === 'gear')!;

    // Wheels are small. A "gear" group the size of the aeroplane is a wing, a
    // fuselage or a tailplane that has been mislabelled.
    expect(gearBox.x / whole.x, `${model.header.id}: gear spans the airframe`).toBeLessThan(0.75);
  });

  it.each(files)('%s has a rotor if it is a helicopter', (file) => {
    const model = readModel(file);
    if (!model.header.rotorcraft) return;
    // A helicopter with no rotor hovers on a bare mast. Two shipped models did
    // — their rotors were in a file the converter does not assemble.
    expect(
      model.header.parts.some((part) => part.role === 'mainRotor'),
      `${model.header.id} has no main rotor`,
    ).toBe(true);
  });

  it.each(files)('%s is normalised to unit length', (file) => {
    // The renderer scales by the type's real length, so a model that is not
    // unit length is drawn at the wrong size — subtly, and consistently.
    const whole = extentOf(readModel(file), () => true)!;
    expect(whole.y).toBeGreaterThan(0.9);
    expect(whole.y).toBeLessThan(1.1);
  });
});
