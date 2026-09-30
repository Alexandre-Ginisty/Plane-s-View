/**
 * What the cockpit's instruments show, as plain data.
 *
 * Filled once a frame by the orchestrator — from the flight model when the
 * sandbox is flying, from the feed otherwise — and read by every display.
 * Anything the source does not know is null, and the instrument that shows it
 * goes dark or dashes out rather than inventing a value.
 */

export interface CockpitContact {
  /** Bearing off the nose, radians, + right. */
  az: number;
  /** Slant range, metres. */
  rangeM: number;
  /** Height relative to ours, feet. */
  relAltFt: number;
  locked: boolean;
}

export interface CockpitReadings {
  iasKt: number;
  gsKt: number;
  mach: number | null;
  altFt: number;
  /** Height above the ground, feet, when known. */
  aglFt: number | null;
  vsFpm: number;
  headingDeg: number;
  trackDeg: number;
  pitchDeg: number;
  /** + right wing down. */
  rollDeg: number;
  /** Angle of attack and sideslip, degrees, when known (the flight path marker). */
  aoaDeg: number | null;
  betaDeg: number | null;
  g: number | null;
  /** 0..1 lever, when known. */
  throttle: number | null;
  afterburner: number;
  /** Jet core %, or propeller rpm. */
  rpm: number | null;
  jet: boolean;
  flapsDeg: number | null;
  gear: 'up' | 'down' | 'transit' | null;
  brake: boolean;
  speedBrake: boolean;
  stall: boolean;
  stallWarning: boolean;
  overspeed: boolean;
  windFromDeg: number | null;
  windKt: number | null;
  /** The weapon, for the combat displays; null when unarmed. */
  weapon: {
    name: string;
    /** 0 reloading … 1 ready. */
    ready: number;
    /** null = radar off, else 0..1 locking … locked. */
    lock: number | null;
    targetRangeM: number | null;
    targetName: string | null;
  } | null;
  /** Unit direction to the locked target in the body frame (x right, y up, z forward). */
  target: { x: number; y: number; z: number } | null;
  /** Aircraft around, for the radar and the navigation display. */
  contacts: CockpitContact[];
  /** Stick and pedal positions, −1..1, to move the controls in the cockpit. */
  stickX: number;
  stickY: number;
}

export function emptyReadings(): CockpitReadings {
  return {
    iasKt: 0,
    gsKt: 0,
    mach: null,
    altFt: 0,
    aglFt: null,
    vsFpm: 0,
    headingDeg: 0,
    trackDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    aoaDeg: null,
    betaDeg: null,
    g: null,
    throttle: null,
    afterburner: 0,
    rpm: null,
    jet: true,
    flapsDeg: null,
    gear: null,
    brake: false,
    speedBrake: false,
    stall: false,
    stallWarning: false,
    overspeed: false,
    windFromDeg: null,
    windKt: null,
    weapon: null,
    target: null,
    contacts: [],
    stickX: 0,
    stickY: 0,
  };
}
