/**
 * Airframe proportions, by type.
 *
 * The data half of the aircraft model: what shape a given ICAO type
 * designator or ADS-B emitter category implies. No geometry here, so the
 * matching rules — which are where the interesting mistakes live — can be
 * read, and tested, without a renderer.
 *
 * Values are eyeballed from real proportions rather than measured. Close
 * enough that the silhouette reads correctly at the distances this is seen
 * from, which is the only requirement.
 */

export type AirframeKind = 'jet' | 'turboprop' | 'piston' | 'glider' | 'rotorcraft';

export interface AirframeShape {
  kind: AirframeKind;
  /** Overall length, metres. For a rotorcraft, nose to tail-boom end. */
  length: number;
  /** Wingspan as a multiple of length. */
  spanRatio: number;
  /** Fuselage radius as a multiple of length. */
  radiusRatio: number;
  /** Quarter-chord sweep, degrees. */
  sweepDeg: number;
  /** Engines hung under the wings. */
  engines: 0 | 2 | 4;
  /** Wing dihedral, degrees. */
  dihedralDeg: number;
  /** Tail-mounted engines and a T-tail instead of underwing pods. */
  tTail: boolean;
  /** Main rotor diameter as a multiple of length. Rotorcraft only. */
  rotorRatio: number;
}

/**
 * Shape presets by ICAO type family.
 *
 * Matched longest-prefix-first, so "A35K" finds the A350 entry before the
 * generic "A3" one. Values are eyeballed from real proportions — close enough
 * that the silhouette reads correctly at the distances this is seen from.
 */
const SHAPES: ReadonlyArray<readonly [string, Partial<AirframeShape>]> = [
  ['A38', { length: 73, spanRatio: 1.09, engines: 4, sweepDeg: 33 }],
  ['B74', { length: 70, spanRatio: 0.93, engines: 4, sweepDeg: 37 }],
  ['A35', { length: 67, spanRatio: 1.0, sweepDeg: 35 }],
  ['B78', { length: 57, spanRatio: 1.05, sweepDeg: 34 }],
  ['B77', { length: 64, spanRatio: 1.02, sweepDeg: 35 }],
  ['A33', { length: 59, spanRatio: 1.02, sweepDeg: 30 }],
  ['A34', { length: 63, spanRatio: 1.0, engines: 4, sweepDeg: 30 }],
  ['B76', { length: 55, spanRatio: 0.85, sweepDeg: 31 }],
  ['B75', { length: 47, spanRatio: 0.81, sweepDeg: 31 }],
  ['A32', { length: 37, spanRatio: 0.96, sweepDeg: 25 }],
  ['A31', { length: 34, spanRatio: 1.04, sweepDeg: 25 }],
  ['A22', { length: 39, spanRatio: 0.92, sweepDeg: 28 }],
  ['B73', { length: 40, spanRatio: 0.87, sweepDeg: 25 }],
  ['B39', { length: 42, spanRatio: 0.85, sweepDeg: 25 }],
  ['E19', { length: 36, spanRatio: 0.78, sweepDeg: 23 }],
  ['E17', { length: 32, spanRatio: 0.81, sweepDeg: 23 }],
  ['CRJ', { length: 33, spanRatio: 0.72, sweepDeg: 25, tTail: true }],
  ['BCS', { length: 38, spanRatio: 0.95, sweepDeg: 25 }],
  ['AT7', { kind: 'turboprop', length: 27, spanRatio: 1.0, sweepDeg: 3, tTail: true }],
  ['DH8', { kind: 'turboprop', length: 33, spanRatio: 0.85, sweepDeg: 3, tTail: true }],
  // Light aircraft: straight wing, single engine, no pods.
  ['C17', { kind: 'piston', length: 8.3, spanRatio: 1.35, sweepDeg: 0, engines: 0, radiusRatio: 0.075 }],
  ['P28', { kind: 'piston', length: 7.3, spanRatio: 1.4, sweepDeg: 0, engines: 0, radiusRatio: 0.08 }],
  ['SR2', { kind: 'piston', length: 7.9, spanRatio: 1.45, sweepDeg: 0, engines: 0, radiusRatio: 0.08 }],
];

/**
 * Rotorcraft, by exact ICAO type designator.
 *
 * Exact, not prefix-matched, and that is a deliberate reversal of how the
 * fixed-wing table works. Helicopter designators collide head-on with
 * airliners: a `B4` prefix would claim the Bell 412 *and* the Boeing 747, `A1`
 * would claim the AW109 and the A318, `S7` the Sikorsky S-76 and nothing good.
 * Prefix matching is safe for the airliner families because they genuinely
 * share a prefix by design; here it would silently turn 747s into helicopters.
 *
 * `EC`, `H1` and `R` are the exceptions: Airbus and Robinson designators in
 * those ranges are rotorcraft-only, and listing every variant would be a
 * maintenance trap. The authoritative signal is the ADS-B emitter category
 * (`A7`) anyway — this table only covers the very common case of a feed that
 * reports a type code and no category.
 */
const ROTORCRAFT_TYPES: ReadonlySet<string> = new Set([
  'A109', 'A119', 'A129', 'A139', 'A149', 'A169', 'A189',
  'AS32', 'AS3B', 'AS50', 'AS55', 'AS65', 'ALO2', 'ALO3',
  'B06', 'B06T', 'B105', 'B212', 'B222', 'B230', 'B407', 'B412', 'B429', 'B430', 'B505',
  'BK17', 'CH47', 'CH53', 'EH10', 'EXPL', 'GAZL', 'HUCO',
  // MD52 and MD60 are MD Helicopters (520N, 600N); the MD 900 Explorer is
  // 'EXPL', above. 'MD90' is the McDonnell Douglas MD-90 *airliner* and was
  // in this list by mistake, drawing every MD-90 with a rotor.
  'LYNX', 'MD52', 'MD60', 'MI17', 'MI24', 'MI8', 'NH90',
  'PUMA', 'S274', 'S276', 'S330', 'S61', 'S61R', 'S64', 'S65C', 'S70', 'S76', 'S92',
  'TIGR', 'UH1', 'UH60', 'A600', 'K126',
]);

/** Prefixes that are unambiguously rotorcraft. See the note above. */
const ROTORCRAFT_PREFIXES: readonly string[] = ['EC1', 'EC2', 'EC3', 'EC4', 'EC5', 'EC6', 'EC7', 'H12', 'H13', 'H14', 'H15', 'H16', 'H17', 'R22', 'R44', 'R66'];

/** Rotorcraft proportions by size, chosen from the type's own length. */
const ROTOR_SHAPE: Omit<AirframeShape, 'length'> = {
  kind: 'rotorcraft',
  // A helicopter's rotor is wider than its fuselage is long. Reading
  // `spanRatio` as the rotor diameter keeps one field meaning "how wide is
  // this thing" for every airframe, which is what the range-scaling code in
  // `Traffic3D` actually wants to know.
  spanRatio: 1.15,
  radiusRatio: 0.12,
  sweepDeg: 0,
  engines: 0,
  dihedralDeg: 0,
  tTail: false,
  rotorRatio: 1.15,
};

/** Overall length in metres for the rotorcraft this app is likely to meet. */
const ROTOR_LENGTH: Record<string, number> = {
  R22: 8.8, R44: 9.0, R66: 9.1,
  B06: 12.6, B407: 12.9, B412: 17.1, B429: 13.1, B505: 12.4,
  EC35: 13.0, EC45: 13.6, EC30: 12.6, EC20: 11.0, EC55: 15.9, EC75: 19.5,
  H125: 12.9, H130: 12.6, H135: 12.2, H145: 13.6, H160: 14.0, H175: 18.0,
  A109: 13.0, A139: 16.7, A169: 14.6, A189: 19.5,
  S76: 16.0, S92: 20.9, S70: 19.8, UH60: 19.8, CH47: 30.1,
};

/** Sailplanes: the other silhouette nothing else in the table can express. */
const GLIDER_SHAPE: Omit<AirframeShape, 'length'> = {
  kind: 'glider',
  // 15 m of wing on a 7 m fuselage. Getting this wrong is what made every
  // glider in the old build read as a very small airliner.
  spanRatio: 2.2,
  radiusRatio: 0.045,
  sweepDeg: 1,
  engines: 0,
  dihedralDeg: 3,
  tTail: true,
  rotorRatio: 0,
};

const DEFAULT_SHAPE: AirframeShape = {
  kind: 'jet',
  length: 40,
  spanRatio: 0.92,
  radiusRatio: 0.048,
  sweepDeg: 27,
  engines: 2,
  dihedralDeg: 5,
  tTail: false,
  rotorRatio: 0,
};

/** Fall back on the ADS-B emitter category when the type code is unknown. */
const CATEGORY_LENGTH: Record<string, number> = {
  A1: 9, A2: 20, A3: 40, A4: 55, A5: 68, A6: 25, A7: 14,
  B1: 12, B2: 30, B4: 7, B6: 5,
};

/** True when this type designator names a helicopter. */
export function isRotorcraftType(code: string): boolean {
  if (ROTORCRAFT_TYPES.has(code)) return true;
  return ROTORCRAFT_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/**
 * Pick the silhouette for an aircraft.
 *
 * Order matters and is not the obvious one. The **emitter category wins over
 * the type code** for rotorcraft and gliders, because the category is
 * broadcast by the aircraft itself while the type code is looked up from a
 * community registry that is frequently missing, stale, or wrong about
 * re-registered airframes. For everything else the type code is far more
 * specific than a category that lumps a CRJ and a 737 into `A3`, so it leads.
 */
export function shapeFor(typeCode: string | null, category: string | null): AirframeShape {
  const code = (typeCode ?? '').toUpperCase();
  const cat = (category ?? '').toUpperCase();

  // A7 is "rotorcraft" in the ADS-B emitter category table.
  if (cat === 'A7' || isRotorcraftType(code)) {
    const length = ROTOR_LENGTH[code] ?? (cat === 'A7' ? 13 : 13);
    return { ...ROTOR_SHAPE, length };
  }

  // B1 is "glider / sailplane".
  if (cat === 'B1' || code.startsWith('GLID')) {
    return { ...GLIDER_SHAPE, length: 7 };
  }

  for (const [prefix, overrides] of SHAPES) {
    if (code.startsWith(prefix)) return { ...DEFAULT_SHAPE, ...overrides };
  }

  const length = CATEGORY_LENGTH[cat] ?? DEFAULT_SHAPE.length;
  // Small airframes are straight-winged and proportionally fatter.
  if (length < 15) {
    return {
      ...DEFAULT_SHAPE,
      kind: 'piston',
      length,
      spanRatio: 1.4,
      sweepDeg: 0,
      engines: 0,
      radiusRatio: 0.08,
    };
  }
  return { ...DEFAULT_SHAPE, length };
}
