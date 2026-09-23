/**
 * What each ICAO type designator looks like.
 *
 * Pure data, no geometry and no matching logic — `shapes.ts` owns those. Split
 * out because the table is the part that grows: every gap in it is an aircraft
 * drawn as something it is not, and the fix is always another row rather than
 * another rule.
 *
 * ## How big the gaps were
 *
 * Measured against eight busy terminal areas (Paris, London, Frankfurt,
 * New York, Dubai, Amsterdam, Rome, San Francisco), 1622 aircraft reporting a
 * type code: **46% matched nothing** and fell back to a generic 40 m twin-jet.
 * The three most common misses were `A21N`, `B38M` and `A20N` — the A321neo,
 * the 737 MAX 8 and the A320neo, which between them are most of the narrowbody
 * fleet flying today. The old table had `A32` and `B73`, and the re-engined
 * variants simply do not share those prefixes.
 *
 * So the rows below are chosen from what is actually in the sky rather than
 * from what is interesting: the neos and the MAXes first, then the light
 * aircraft that fill any European Sunday afternoon (C152, DA40/DA42, DR400,
 * PC-12), then the business jets, which were the worst-served of all — a
 * Phenom 300 reporting emitter category A1 was being drawn as a straight-wing
 * piston single.
 *
 * Values are eyeballed from published dimensions rather than measured. Close
 * enough that the silhouette reads correctly at the distances this is seen
 * from, which is the only requirement.
 */

export type AirframeKind = 'jet' | 'turboprop' | 'piston' | 'glider' | 'rotorcraft';

/**
 * Where the engines hang.
 *
 * Split from `tTail`, which used to carry both meanings and got both wrong for
 * half the table. A Dash 8 has a T-tail *and* underwing turboprops; a CRJ has a
 * T-tail *and* engines on the rear fuselage. Conflating them left every ATR,
 * every Dash 8 and every regional jet drawn with no engines at all.
 */
export type EngineMount = 'wing' | 'tail' | 'none';

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
  /** How many engines are drawn. */
  engines: 0 | 2 | 4;
  /** Where they are drawn. */
  engineMount: EngineMount;
  /** Wing dihedral, degrees. */
  dihedralDeg: number;
  /** Horizontal stabiliser on top of the fin rather than on the fuselage. */
  tTail: boolean;
  /** Main rotor diameter as a multiple of length. Rotorcraft only. */
  rotorRatio: number;
}

export const DEFAULT_SHAPE: AirframeShape = {
  kind: 'jet',
  length: 40,
  spanRatio: 0.92,
  radiusRatio: 0.048,
  sweepDeg: 27,
  engines: 2,
  engineMount: 'wing',
  dihedralDeg: 5,
  tTail: false,
  rotorRatio: 0,
};

type Row = readonly [string, Partial<AirframeShape>];

/** Rear-fuselage engines and a T-tail: the regional-jet and bizjet silhouette. */
const BIZJET: Partial<AirframeShape> = {
  kind: 'jet',
  tTail: true,
  engineMount: 'tail',
  engines: 2,
  radiusRatio: 0.062,
  dihedralDeg: 2,
};

/** Underwing turboprops and, on almost all of them, a T-tail. */
const TPROP: Partial<AirframeShape> = {
  kind: 'turboprop',
  tTail: true,
  engineMount: 'wing',
  engines: 2,
  sweepDeg: 3,
  radiusRatio: 0.062,
  dihedralDeg: 3,
};

/** Straight wing, engine in the nose, no pods. */
const SINGLE: Partial<AirframeShape> = {
  kind: 'piston',
  sweepDeg: 0,
  engines: 0,
  engineMount: 'none',
  radiusRatio: 0.08,
  dihedralDeg: 4,
  tTail: false,
};

/** Long thin wing, no engine, tail on the fin. Sized by the row. */
const SAILPLANE: Partial<AirframeShape> = {
  kind: 'glider',
  spanRatio: 2.2,
  radiusRatio: 0.045,
  sweepDeg: 1,
  engines: 0,
  engineMount: 'none',
  dihedralDeg: 3,
  tTail: true,
};

/** Straight wing, an engine on each one. */
const TWIN_PISTON: Partial<AirframeShape> = {
  ...SINGLE,
  engines: 2,
  engineMount: 'wing',
};

/**
 * Prefix rows, written in readable groups.
 *
 * Order in the source does not decide precedence — `SHAPES` sorts by prefix
 * length so the longest match always wins. That is what lets `A321` sit beside
 * `A32` without one shadowing the other, and it is why adding a row can never
 * silently break an existing one.
 */
const ROWS: readonly Row[] = [
  // ---- Airbus narrowbody, including the re-engined variants ---------------
  ['A318', { length: 31.4, spanRatio: 1.14, sweepDeg: 25 }],
  ['A319', { length: 33.8, spanRatio: 1.06, sweepDeg: 25 }],
  ['A19N', { length: 33.8, spanRatio: 1.06, sweepDeg: 25 }],
  ['A320', { length: 37.6, spanRatio: 0.95, sweepDeg: 25 }],
  ['A20N', { length: 37.6, spanRatio: 0.95, sweepDeg: 25 }],
  ['A321', { length: 44.5, spanRatio: 0.81, sweepDeg: 25 }],
  ['A21N', { length: 44.5, spanRatio: 0.81, sweepDeg: 25 }],
  ['A32', { length: 37.6, spanRatio: 0.95, sweepDeg: 25 }],
  ['A31', { length: 34, spanRatio: 1.04, sweepDeg: 25 }],
  ['A30', { length: 54.1, spanRatio: 0.82, sweepDeg: 28 }],

  // ---- Airbus widebody ----------------------------------------------------
  ['A38', { length: 73, spanRatio: 1.09, engines: 4, sweepDeg: 33 }],
  ['A35', { length: 67, spanRatio: 1.0, sweepDeg: 35 }],
  ['A34', { length: 63, spanRatio: 1.0, engines: 4, sweepDeg: 30 }],
  ['A33', { length: 59, spanRatio: 1.02, sweepDeg: 30 }],
  ['A400', { ...TPROP, length: 45.1, spanRatio: 0.94, engines: 4, tTail: false }],

  // ---- A220 (Bombardier C Series) ----------------------------------------
  ['BCS', { length: 38, spanRatio: 0.95, sweepDeg: 25 }],
  ['A22', { length: 38.7, spanRatio: 0.91, sweepDeg: 25 }],

  // ---- Boeing narrowbody, including the MAX ------------------------------
  ['B37M', { length: 35.6, spanRatio: 1.01, sweepDeg: 25 }],
  ['B38M', { length: 39.5, spanRatio: 0.91, sweepDeg: 25 }],
  ['B39M', { length: 42.2, spanRatio: 0.85, sweepDeg: 25 }],
  ['B3XM', { length: 43.8, spanRatio: 0.82, sweepDeg: 25 }],
  ['B73', { length: 39.5, spanRatio: 0.89, sweepDeg: 25 }],
  ['B39', { length: 42.2, spanRatio: 0.85, sweepDeg: 25 }],
  ['B75', { length: 47, spanRatio: 0.81, sweepDeg: 31 }],
  ['B712', { ...BIZJET, length: 37.8, spanRatio: 0.75, sweepDeg: 24 }],
  ['B72', { ...BIZJET, length: 46.7, spanRatio: 0.70, sweepDeg: 32 }],

  // ---- Boeing widebody ----------------------------------------------------
  ['B74', { length: 70, spanRatio: 0.93, engines: 4, sweepDeg: 37 }],
  ['B78', { length: 57, spanRatio: 1.05, sweepDeg: 34 }],
  ['B77', { length: 64, spanRatio: 1.02, sweepDeg: 35 }],
  ['B76', { length: 55, spanRatio: 0.85, sweepDeg: 31 }],

  // ---- McDonnell Douglas: rear engines, T-tail ----------------------------
  ['MD11', { length: 61.2, spanRatio: 0.85, sweepDeg: 35, tTail: true, engineMount: 'tail' }],
  ['MD8', { ...BIZJET, length: 45.1, spanRatio: 0.71, sweepDeg: 24 }],
  ['MD9', { ...BIZJET, length: 46.5, spanRatio: 0.71, sweepDeg: 24 }],
  ['DC9', { ...BIZJET, length: 36.4, spanRatio: 0.77, sweepDeg: 24 }],

  // ---- Regional jets ------------------------------------------------------
  ['CRJ', { ...BIZJET, length: 33, spanRatio: 0.72, sweepDeg: 25 }],
  ['E170', { length: 29.9, spanRatio: 0.87, sweepDeg: 23 }],
  ['E75', { length: 31.7, spanRatio: 0.82, sweepDeg: 23 }],
  ['E17', { length: 30, spanRatio: 0.87, sweepDeg: 23 }],
  ['E190', { length: 36.2, spanRatio: 0.78, sweepDeg: 23 }],
  ['E195', { length: 38.7, spanRatio: 0.74, sweepDeg: 23 }],
  ['E290', { length: 36.2, spanRatio: 0.93, sweepDeg: 23 }],
  ['E295', { length: 41.5, spanRatio: 0.85, sweepDeg: 23 }],
  ['E19', { length: 36.2, spanRatio: 0.78, sweepDeg: 23 }],
  // ERJ 135/140/145 and the Legacy built on them: long, thin, rear-engined.
  ['E13', { ...BIZJET, length: 26.3, spanRatio: 0.76, sweepDeg: 22 }],
  ['E14', { ...BIZJET, length: 29.9, spanRatio: 0.67, sweepDeg: 22 }],
  ['E45', { ...BIZJET, length: 29.9, spanRatio: 0.67, sweepDeg: 22 }],
  ['E35L', { ...BIZJET, length: 26.3, spanRatio: 0.81, sweepDeg: 22 }],
  ['SU95', { length: 29.9, spanRatio: 0.92, sweepDeg: 25 }],
  ['AN14', { ...TPROP, length: 28.1, spanRatio: 1.04, engines: 4, tTail: false }],

  // ---- Turboprop airliners ------------------------------------------------
  ['AT7', { ...TPROP, length: 27, spanRatio: 1.0 }],
  ['AT4', { ...TPROP, length: 22.7, spanRatio: 1.08 }],
  ['AT5', { ...TPROP, length: 22.7, spanRatio: 1.08 }],
  ['DH8', { ...TPROP, length: 33, spanRatio: 0.85 }],
  ['DHC6', { ...TPROP, length: 15.8, spanRatio: 1.25, tTail: false }],
  ['SF34', { ...TPROP, length: 19.7, spanRatio: 1.09, tTail: false }],
  ['SB20', { ...TPROP, length: 27.3, spanRatio: 0.83 }],
  ['D328', { ...TPROP, length: 21.3, spanRatio: 0.99 }],
  ['D228', { ...TPROP, length: 16.6, spanRatio: 1.09, tTail: false }],
  ['E120', { ...TPROP, length: 20.0, spanRatio: 0.99 }],
  ['JS3', { ...TPROP, length: 14.4, spanRatio: 1.21, tTail: false }],
  ['SW4', { ...TPROP, length: 18.1, spanRatio: 0.96, tTail: false }],
  ['C130', { ...TPROP, length: 29.8, spanRatio: 1.36, engines: 4, tTail: false }],
  ['L410', { ...TPROP, length: 14.4, spanRatio: 1.35, tTail: false }],

  // ---- Business jets ------------------------------------------------------
  ['GLF', { ...BIZJET, length: 29.4, spanRatio: 0.99, sweepDeg: 27 }],
  ['GLEX', { ...BIZJET, length: 30.3, spanRatio: 0.95, sweepDeg: 30 }],
  ['GL5T', { ...BIZJET, length: 29.5, spanRatio: 0.97, sweepDeg: 30 }],
  ['GL6T', { ...BIZJET, length: 30.3, spanRatio: 0.95, sweepDeg: 30 }],
  ['GL7T', { ...BIZJET, length: 33.9, spanRatio: 0.94, sweepDeg: 30 }],
  ['G280', { ...BIZJET, length: 20.3, spanRatio: 0.96, sweepDeg: 27 }],
  ['CL30', { ...BIZJET, length: 20.9, spanRatio: 0.93, sweepDeg: 27 }],
  ['CL35', { ...BIZJET, length: 20.9, spanRatio: 0.93, sweepDeg: 27 }],
  ['CL60', { ...BIZJET, length: 20.9, spanRatio: 0.94, sweepDeg: 27 }],
  ['F2TH', { ...BIZJET, length: 20.2, spanRatio: 0.96, sweepDeg: 27 }],
  ['F900', { ...BIZJET, length: 20.2, spanRatio: 0.96, sweepDeg: 27 }],
  ['FA7X', { ...BIZJET, length: 23.2, spanRatio: 1.13, sweepDeg: 27 }],
  ['FA8X', { ...BIZJET, length: 24.5, spanRatio: 1.07, sweepDeg: 27 }],
  ['FA50', { ...BIZJET, length: 18.5, spanRatio: 0.99, sweepDeg: 27 }],
  ['E50P', { ...BIZJET, length: 12.8, spanRatio: 0.96, sweepDeg: 20 }],
  ['E55P', { ...BIZJET, length: 15.6, spanRatio: 1.04, sweepDeg: 20 }],
  ['E545', { ...BIZJET, length: 16.9, spanRatio: 1.15, sweepDeg: 22 }],
  ['E550', { ...BIZJET, length: 17.4, spanRatio: 1.17, sweepDeg: 22 }],
  ['PC24', { ...BIZJET, length: 16.9, spanRatio: 1.01, sweepDeg: 18 }],
  ['C510', { ...BIZJET, length: 12.4, spanRatio: 1.06, sweepDeg: 15 }],
  ['C525', { ...BIZJET, length: 12.9, spanRatio: 1.11, sweepDeg: 15 }],
  ['C25', { ...BIZJET, length: 15.2, spanRatio: 1.03, sweepDeg: 15 }],
  ['C56X', { ...BIZJET, length: 15.8, spanRatio: 1.09, sweepDeg: 20 }],
  ['C560', { ...BIZJET, length: 14.9, spanRatio: 1.07, sweepDeg: 20 }],
  ['C55', { ...BIZJET, length: 14.4, spanRatio: 1.09, sweepDeg: 20 }],
  ['C650', { ...BIZJET, length: 16.9, spanRatio: 0.95, sweepDeg: 25 }],
  ['C68', { ...BIZJET, length: 19.4, spanRatio: 1.05, sweepDeg: 25 }],
  ['C700', { ...BIZJET, length: 22.3, spanRatio: 0.94, sweepDeg: 25 }],
  ['C750', { ...BIZJET, length: 22.0, spanRatio: 0.88, sweepDeg: 35 }],
  ['LJ', { ...BIZJET, length: 17.7, spanRatio: 0.82, sweepDeg: 25 }],
  ['H25', { ...BIZJET, length: 15.6, spanRatio: 1.06, sweepDeg: 20 }],
  ['BE40', { ...BIZJET, length: 14.8, spanRatio: 0.90, sweepDeg: 20 }],
  ['PRM1', { ...BIZJET, length: 14.0, spanRatio: 0.97, sweepDeg: 20 }],
  ['GALX', { ...BIZJET, length: 19.9, spanRatio: 0.88, sweepDeg: 27 }],
  ['HDJT', { ...BIZJET, length: 12.6, spanRatio: 1.02, sweepDeg: 20 }],

  // ---- Single-engine turboprops ------------------------------------------
  ['PC12', { ...SINGLE, kind: 'turboprop', length: 14.4, spanRatio: 1.13, radiusRatio: 0.07 }],
  ['TBM', { ...SINGLE, kind: 'turboprop', length: 10.7, spanRatio: 1.20, radiusRatio: 0.075 }],
  ['M700', { ...SINGLE, kind: 'turboprop', length: 9.6, spanRatio: 1.35, radiusRatio: 0.075 }],
  ['EPIC', { ...SINGLE, kind: 'turboprop', length: 10.9, spanRatio: 1.29, radiusRatio: 0.075 }],
  ['C208', { ...SINGLE, kind: 'turboprop', length: 11.5, spanRatio: 1.38, radiusRatio: 0.075 }],
  ['PC6', { ...SINGLE, kind: 'turboprop', length: 10.9, spanRatio: 1.45, radiusRatio: 0.075 }],
  ['P46T', { ...SINGLE, kind: 'turboprop', length: 9.0, spanRatio: 1.49, radiusRatio: 0.075 }],

  // ---- Twin turboprops, cabin class --------------------------------------
  ['BE20', { ...TPROP, length: 13.3, spanRatio: 1.25, tTail: true, radiusRatio: 0.075 }],
  ['B350', { ...TPROP, length: 14.2, spanRatio: 1.25, tTail: true, radiusRatio: 0.075 }],
  ['BE9', { ...TPROP, length: 10.8, spanRatio: 1.42, tTail: true, radiusRatio: 0.08 }],
  ['C425', { ...TPROP, length: 11.0, spanRatio: 1.33, tTail: false, radiusRatio: 0.08 }],
  ['C441', { ...TPROP, length: 11.9, spanRatio: 1.29, tTail: false, radiusRatio: 0.08 }],
  ['P180', { ...TPROP, length: 14.4, spanRatio: 0.97, tTail: true, radiusRatio: 0.07 }],
  ['DA62', { ...TWIN_PISTON, length: 9.2, spanRatio: 1.59 }],

  // ---- Light singles ------------------------------------------------------
  ['C15', { ...SINGLE, length: 7.3, spanRatio: 1.40 }],
  ['C17', { ...SINGLE, length: 8.3, spanRatio: 1.35, radiusRatio: 0.075 }],
  ['C18', { ...SINGLE, length: 8.8, spanRatio: 1.25 }],
  ['C20', { ...SINGLE, length: 8.6, spanRatio: 1.30 }],
  ['C21', { ...SINGLE, length: 8.6, spanRatio: 1.30 }],
  ['C82', { ...SINGLE, length: 7.5, spanRatio: 1.45 }],
  ['P28', { ...SINGLE, length: 7.3, spanRatio: 1.40 }],
  ['P32', { ...SINGLE, length: 8.4, spanRatio: 1.30 }],
  ['PA18', { ...SINGLE, length: 6.8, spanRatio: 1.55 }],
  ['PA38', { ...SINGLE, length: 7.0, spanRatio: 1.42 }],
  ['SR2', { ...SINGLE, length: 7.9, spanRatio: 1.45 }],
  ['SR22', { ...SINGLE, length: 7.9, spanRatio: 1.48 }],
  ['DA40', { ...SINGLE, length: 8.1, spanRatio: 1.47 }],
  ['DV20', { ...SINGLE, length: 7.3, spanRatio: 1.49 }],
  ['DR40', { ...SINGLE, length: 7.0, spanRatio: 1.25 }],
  ['A210', { ...SINGLE, length: 7.3, spanRatio: 1.41 }],
  ['G115', { ...SINGLE, length: 7.6, spanRatio: 1.32 }],
  ['BE3', { ...SINGLE, length: 8.1, spanRatio: 1.26 }],
  ['M20', { ...SINGLE, length: 8.1, spanRatio: 1.36 }],
  ['RV', { ...SINGLE, length: 6.2, spanRatio: 1.13 }],
  ['AA5', { ...SINGLE, length: 6.7, spanRatio: 1.53 }],
  ['C42', { ...SINGLE, length: 6.4, spanRatio: 1.48, radiusRatio: 0.09 }],
  ['ULAC', { ...SINGLE, length: 6.0, spanRatio: 1.55, radiusRatio: 0.09 }],
  ['EV97', { ...SINGLE, length: 6.3, spanRatio: 1.47, radiusRatio: 0.09 }],

  // ---- Light twins --------------------------------------------------------
  ['DA42', { ...TWIN_PISTON, length: 8.6, spanRatio: 1.57 }],
  ['BE58', { ...TWIN_PISTON, length: 9.1, spanRatio: 1.26 }],
  ['BE76', { ...TWIN_PISTON, length: 8.8, spanRatio: 1.31 }],
  ['PA34', { ...TWIN_PISTON, length: 8.7, spanRatio: 1.37 }],
  ['PA44', { ...TWIN_PISTON, length: 8.4, spanRatio: 1.40 }],
  ['PA31', { ...TWIN_PISTON, length: 9.9, spanRatio: 1.24 }],
  ['P68', { ...TWIN_PISTON, length: 9.4, spanRatio: 1.28 }],
  ['P208', { ...TWIN_PISTON, length: 9.4, spanRatio: 1.28 }],
  ['C33', { ...TWIN_PISTON, length: 8.6, spanRatio: 1.32 }],
  ['C40', { ...TWIN_PISTON, length: 8.4, spanRatio: 1.36 }],

  // ---- Microlights and light sport --------------------------------------
  //
  // Numerous over Europe on any clear weekend, and all of them broadcast
  // either category A1 or nothing at all — which is how a 6 m two-seater
  // ended up sharing a silhouette with a business jet.
  ['VL3', { ...SINGLE, length: 6.3, spanRatio: 1.35, radiusRatio: 0.09 }],
  ['WT9', { ...SINGLE, length: 6.4, spanRatio: 1.45, radiusRatio: 0.09 }],
  ['FK9', { ...SINGLE, length: 6.0, spanRatio: 1.57, radiusRatio: 0.09 }],
  ['EFOX', { ...SINGLE, length: 6.0, spanRatio: 1.60, radiusRatio: 0.09 }],
  ['SIRA', { ...SINGLE, length: 6.3, spanRatio: 1.47, radiusRatio: 0.09 }],
  ['PNR', { ...SINGLE, length: 6.4, spanRatio: 1.30, radiusRatio: 0.09 }],
  ['P2008', { ...SINGLE, length: 6.9, spanRatio: 1.30, radiusRatio: 0.09 }],
  ['SUNP', { ...SINGLE, length: 6.5, spanRatio: 1.45, radiusRatio: 0.09 }],
  ['ATEC', { ...SINGLE, length: 6.2, spanRatio: 1.44, radiusRatio: 0.09 }],
  ['TL20', { ...SINGLE, length: 6.3, spanRatio: 1.47, radiusRatio: 0.09 }],
  ['SLGC', { ...SAILPLANE, length: 7.2 }],

  // ---- Sailplanes ---------------------------------------------------------
  //
  // Most of them broadcast no emitter category at all, so the `B1` route in
  // `shapeFor` never fires and the type code is the only signal there is.
  ['SLG', { ...SAILPLANE, length: 7.2 }],
  ['SF25', { ...SAILPLANE, length: 7.5, spanRatio: 2.0 }],
  ['G103', { ...SAILPLANE, length: 8.2, spanRatio: 2.2 }],
  ['G102', { ...SAILPLANE, length: 6.5, spanRatio: 2.4 }],
  ['G109', { ...SAILPLANE, length: 8.1, spanRatio: 2.1 }],
  ['DG', { ...SAILPLANE, length: 7.0, spanRatio: 2.4 }],
  ['LS', { ...SAILPLANE, length: 6.7, spanRatio: 2.4 }],
  ['ASK', { ...SAILPLANE, length: 7.0, spanRatio: 2.3 }],
  ['ASW', { ...SAILPLANE, length: 6.8, spanRatio: 2.4 }],
  ['ASG', { ...SAILPLANE, length: 6.9, spanRatio: 2.5 }],
  ['ARCU', { ...SAILPLANE, length: 8.3, spanRatio: 2.4 }],
  ['DISC', { ...SAILPLANE, length: 6.6, spanRatio: 2.3 }],
  ['VENT', { ...SAILPLANE, length: 7.0, spanRatio: 2.4 }],
  ['NIMB', { ...SAILPLANE, length: 7.2, spanRatio: 3.0 }],
  ['JANU', { ...SAILPLANE, length: 7.3, spanRatio: 2.5 }],
  ['DUOD', { ...SAILPLANE, length: 8.6, spanRatio: 2.3 }],

  // ---- More light singles and twins --------------------------------------
  ['TOBA', { ...SINGLE, length: 7.6, spanRatio: 1.42 }],
  ['TB', { ...SINGLE, length: 7.6, spanRatio: 1.42 }],
  ['C77', { ...SINGLE, length: 8.4, spanRatio: 1.35 }],
  ['BE24', { ...SINGLE, length: 7.8, spanRatio: 1.34 }],
  ['S22', { ...SINGLE, length: 7.9, spanRatio: 1.48 }],
  ['RF', { ...SINGLE, length: 7.0, spanRatio: 1.71 }],
  ['AA1', { ...SINGLE, length: 5.9, spanRatio: 1.59 }],
  ['RALL', { ...SINGLE, length: 7.2, spanRatio: 1.42 }],
  ['D140', { ...SINGLE, length: 7.2, spanRatio: 1.50 }],
  ['JOD', { ...SINGLE, length: 6.5, spanRatio: 1.31 }],
  ['YK18', { ...SINGLE, length: 6.9, spanRatio: 1.42 }],
  ['M7', { ...SINGLE, length: 7.1, spanRatio: 1.48 }],
  ['C30', { ...TWIN_PISTON, length: 9.3, spanRatio: 1.26 }],
  ['C31', { ...TWIN_PISTON, length: 9.7, spanRatio: 1.23 }],
  ['C34', { ...TWIN_PISTON, length: 10.5, spanRatio: 1.18 }],
  ['C41', { ...TWIN_PISTON, length: 11.1, spanRatio: 1.32 }],
  ['P06T', { ...TWIN_PISTON, length: 8.7, spanRatio: 1.38 }],
  ['AC11', { ...TWIN_PISTON, length: 10.6, spanRatio: 1.21 }],
  ['SC7', { ...TPROP, length: 12.2, spanRatio: 1.60, tTail: false }],
  ['C295', { ...TPROP, length: 24.5, spanRatio: 1.09 }],
  ['CN35', { ...TPROP, length: 21.4, spanRatio: 1.20 }],
  ['PA32', { ...SINGLE, length: 8.4, spanRatio: 1.30 }],
  ['PA46', { ...SINGLE, length: 8.7, spanRatio: 1.51 }],
  ['PA28', { ...SINGLE, length: 7.3, spanRatio: 1.40 }],
  ['GA7', { ...TWIN_PISTON, length: 8.5, spanRatio: 1.42 }],
  ['GA8', { ...SINGLE, length: 8.7, spanRatio: 1.45 }],
  ['CJ6', { ...SINGLE, length: 8.5, spanRatio: 1.22, radiusRatio: 0.085 }],
  ['YK52', { ...SINGLE, length: 7.7, spanRatio: 1.31, radiusRatio: 0.085 }],

  // ---- Fast jets ----------------------------------------------------------
  //
  // A delta on a short fuselage. Nothing in the airliner table can express it,
  // and a Typhoon drawn as a 40 m twin-jet is conspicuous when it is the one
  // thing on screen moving at 500 kt at 2000 ft.
  ['EUFI', { length: 15.9, spanRatio: 0.68, sweepDeg: 53, engines: 0, engineMount: 'none', radiusRatio: 0.075, dihedralDeg: 0 }],
  ['RFAL', { length: 15.3, spanRatio: 0.71, sweepDeg: 48, engines: 0, engineMount: 'none', radiusRatio: 0.075, dihedralDeg: 0 }],
  ['F16', { length: 15.0, spanRatio: 0.67, sweepDeg: 40, engines: 0, engineMount: 'none', radiusRatio: 0.075, dihedralDeg: 0 }],
  ['F15', { length: 19.4, spanRatio: 0.68, sweepDeg: 45, engines: 0, engineMount: 'none', radiusRatio: 0.075, dihedralDeg: 0 }],
  ['F35', { length: 15.6, spanRatio: 0.67, sweepDeg: 35, engines: 0, engineMount: 'none', radiusRatio: 0.08, dihedralDeg: 0 }],
  ['HAWK', { length: 11.9, spanRatio: 0.79, sweepDeg: 26, engines: 0, engineMount: 'none', radiusRatio: 0.075, dihedralDeg: 0 }],
  ['TOR', { length: 16.7, spanRatio: 0.80, sweepDeg: 45, engines: 0, engineMount: 'none', radiusRatio: 0.075, dihedralDeg: 0 }],
  ['SPIT', { ...SINGLE, length: 9.1, spanRatio: 1.23, radiusRatio: 0.075 }],
];

/**
 * The live table, longest prefix first.
 *
 * Sorting here rather than relying on how the rows above happen to be written
 * is what makes the "longest match wins" rule true by construction. The old
 * table relied on source order and its own docblock was already wrong about
 * it.
 */
export const SHAPES: readonly Row[] = [...ROWS].sort((a, b) => b[0].length - a[0].length);

/**
 * Designators a prefix rule would lie about.
 *
 * `C17` is the Boeing C-17 Globemaster III, a 53 m four-engine military
 * freighter — and also the prefix that catches the Cessna 170/172/175/177.
 * Four of them were in the sample above, every one drawn as an 8 m Cessna.
 * Exact matches are consulted before prefixes for exactly this case.
 */
export const EXACT: ReadonlyMap<string, Partial<AirframeShape>> = new Map([
  ['C17', { length: 53.0, spanRatio: 0.98, sweepDeg: 25, engines: 4, radiusRatio: 0.062 }],
  ['K35R', { length: 41.5, spanRatio: 0.96, sweepDeg: 35, engines: 4 }],
  ['E3TF', { length: 46.6, spanRatio: 1.00, sweepDeg: 35, engines: 4 }],
  ['A124', { length: 69.1, spanRatio: 1.17, sweepDeg: 32, engines: 4 }],
  ['C5M', { length: 75.5, spanRatio: 0.89, sweepDeg: 25, engines: 4 }],
]);

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
 * `EC`, `H1` and `R` are the exceptions below: Airbus and Robinson designators
 * in those ranges are rotorcraft-only, and listing every variant would be a
 * maintenance trap. The authoritative signal is the ADS-B emitter category
 * (`A7`) anyway — this table only covers the very common case of a feed that
 * reports a type code and no category.
 */
export const ROTORCRAFT_TYPES: ReadonlySet<string> = new Set([
  'A109', 'A119', 'A129', 'A139', 'A149', 'A169', 'A189',
  'AS32', 'AS3B', 'AS50', 'AS55', 'AS65', 'ALO2', 'ALO3',
  'B06', 'B06T', 'B105', 'B212', 'B222', 'B230', 'B407', 'B412', 'B429', 'B430', 'B505',
  'BK17', 'CH47', 'CH53', 'EH10', 'EXPL', 'GAZL', 'HUCO',
  // MD52 and MD60 are MD Helicopters (520N, 600N); the MD 900 Explorer is
  // 'EXPL'. 'MD90' is the McDonnell Douglas MD-90 *airliner* and was in this
  // list by mistake, drawing every MD-90 with a rotor.
  'LYNX', 'MD52', 'MD60', 'MI17', 'MI24', 'MI8', 'NH90',
  'PUMA', 'S274', 'S276', 'S330', 'S61', 'S61R', 'S64', 'S65C', 'S70', 'S76', 'S92',
  'TIGR', 'UH1', 'UH60', 'A600', 'K126',
  // Schweizer/Hughes and the light Robinson-class machines that do not fall
  // under the `H1` range: common training helicopters, and every one of them
  // was drawn as a fixed-wing aircraft.
  'H269', 'H500', 'HUGH', 'B47G', 'B47J', 'EN28', 'EN48', 'R100', 'SCOR',
]);

/** Prefixes that are unambiguously rotorcraft. See the note above. */
export const ROTORCRAFT_PREFIXES: readonly string[] = [
  'EC1', 'EC2', 'EC3', 'EC4', 'EC5', 'EC6', 'EC7',
  'H12', 'H13', 'H14', 'H15', 'H16', 'H17',
  'R22', 'R44', 'R66',
];

/** Rotorcraft proportions. Size comes from `ROTOR_LENGTH`. */
export const ROTOR_SHAPE: Omit<AirframeShape, 'length'> = {
  kind: 'rotorcraft',
  // A helicopter's rotor is wider than its fuselage is long. Reading
  // `spanRatio` as the rotor diameter keeps one field meaning "how wide is
  // this thing" for every airframe, which is what the range-scaling code in
  // `Traffic3D` actually wants to know.
  spanRatio: 1.15,
  radiusRatio: 0.12,
  sweepDeg: 0,
  engines: 0,
  engineMount: 'none',
  dihedralDeg: 0,
  tTail: false,
  rotorRatio: 1.15,
};

/** Overall length in metres for the rotorcraft this app is likely to meet. */
export const ROTOR_LENGTH: Readonly<Record<string, number>> = {
  R22: 8.8, R44: 9.0, R66: 9.1,
  B06: 12.6, B407: 12.9, B412: 17.1, B429: 13.1, B505: 12.4,
  EC35: 13.0, EC45: 13.6, EC30: 12.6, EC20: 11.0, EC55: 15.9, EC75: 19.5,
  H125: 12.9, H130: 12.6, H135: 12.2, H145: 13.6, H160: 14.0, H175: 18.0,
  A109: 13.0, A139: 16.7, A169: 14.6, A189: 19.5,
  S76: 16.0, S92: 20.9, S70: 19.8, UH60: 19.8, CH47: 30.1, CH53: 30.2,
  BK17: 13.0, NH90: 19.6, PUMA: 18.2, MI8: 18.2,
};

/** Sailplanes: the other silhouette nothing else in the table can express. */
export const GLIDER_SHAPE: Omit<AirframeShape, 'length'> = {
  kind: 'glider',
  // 15 m of wing on a 7 m fuselage. Getting this wrong is what made every
  // glider in the old build read as a very small airliner.
  spanRatio: 2.2,
  radiusRatio: 0.045,
  sweepDeg: 1,
  engines: 0,
  engineMount: 'none',
  dihedralDeg: 3,
  tTail: true,
  rotorRatio: 0,
};

/** Fall back on the ADS-B emitter category when the type code is unknown. */
export const CATEGORY_LENGTH: Readonly<Record<string, number>> = {
  A1: 9, A2: 20, A3: 40, A4: 55, A5: 68, A6: 25, A7: 14,
  B1: 12, B2: 30, B4: 7, B6: 5,
};

/**
 * Emitter categories that are not aircraft.
 *
 * `C0`–`C3` are surface and obstacle emitters: emergency vehicles, service
 * vehicles, and fixed obstacles or tethered balloons. Airport ground fleets
 * broadcast ADS-B, so a busy field puts a dozen of them in every traffic
 * snapshot — and with no type code that matched anything, each one was drawn
 * as a 40 m airliner sitting at the reported ground altitude. They are the
 * spikes around airports.
 */
export const SURFACE_CATEGORIES: ReadonlySet<string> = new Set(['C0', 'C1', 'C2', 'C3']);
