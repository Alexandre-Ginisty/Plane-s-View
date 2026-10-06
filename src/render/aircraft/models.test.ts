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

import { parsePvm } from './pvm';

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

/** Header JSON, and the positions of each part as the loader decodes them. */
function readModel(file: string): { header: Header; positions: ArrayLike<number>[] } {
  const buffer = readFileSync(`${DIR}/${file}`);
  const headerLength = buffer.readUint32LE(4);
  const json = buffer
    .subarray(8, 8 + headerLength)
    .toString('utf8')
    .replace(/\0+$/, '');
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const positions = parsePvm(bytes, []).parts.map((p) => p.geometry.getAttribute('position').array);
  return { header: JSON.parse(json) as Header, positions };
}

/** Extent of a set of parts along each axis, in normalised model units. */
function extentOf(
  model: ReturnType<typeof readModel>,
  keep: (part: Part) => boolean,
): { x: number; y: number; z: number } | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  model.header.parts.forEach((part, p) => {
    if (!keep(part)) return;
    const pos = model.positions[p]!;
    for (let i = 0; i < pos.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = pos[i + a]! + (part.origin[a] ?? 0);
        min[a] = Math.min(min[a]!, v);
        max[a] = Math.max(max[a]!, v);
      }
    }
  });

  if (!Number.isFinite(min[0]!)) return null;
  return { x: max[0]! - min[0]!, y: max[1]! - min[1]!, z: max[2]! - min[2]! };
}

// Airframes only: an interior (`f16-cockpit.pvm`, `crj7-cabin.pvm`, `at72-cargo.pvm`) and the crew
// (`crew-fo.pvm`) are in metres about an eye, not unit length.
const files = readdirSync(DIR).filter((f) => f.endsWith('.pvm') && !/-(cockpit|cabin|cargo)\.pvm$|^crew-/.test(f));

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
    // have. Measured against the model's own span rather than a fixed ratio: a
    // MiG-21's delta spans under half its length, and that is not a lost wing.
    const all = extentOf(model, () => true);
    const cruise = extentOf(model, (part) => part.role !== 'gear');
    expect(cruise, 'nothing is drawn at cruise').not.toBeNull();
    expect(cruise!.x / all!.x, `${model.header.id} loses span at cruise`).toBeGreaterThan(0.9);
    expect(cruise!.x / cruise!.y, `${model.header.id} has no wings at cruise`).toBeGreaterThan(0.4);
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
