/**
 * The four calibrated airframes, and the similarity scaling that turns them
 * into everything else in the hangar.
 *
 * Adapted from Tater's Flight Sim (https://github.com/JaredTate/tatertotsflightsim),
 * MIT licence, Copyright (c) 2026 Jared Tate — see ./LICENSE. The airframe
 * numbers, their sources and their calibration are that project's; only the
 * keys the flight model reads are kept, plus `limits.cruiseKt` for spawning.
 *
 * Units are SI unless the key says otherwise (…Kt, …Deg, …Fpm). Positions are
 * in the BODY frame: origin at the CG, +X right, +Y up, -Z the nose.
 */

const DEG = Math.PI / 180;

export const MS_TO_KT = 1.943844;
export const KT_TO_MS = 1 / MS_TO_KT;
export const MS_TO_FPM = 3.280839895 * 60;

interface Point {
  x: number;
  y: number;
  z: number;
}

/** Turbofan, with or without afterburner. `engine.idleRpm` / `maxRpm` are core speed, %. */
export interface JetEngineConfig {
  /** Sea-level static thrust at military (full dry) power, N. */
  milThrustN: number;
  /** …with full afterburner (= milThrustN without one), N. */
  maxThrustN: number;
  idleThrustN: number;
  /** Throttle above this detent lights the afterburner (1 = none). */
  abDetent: number;
  /** Afterburner intensity just past the detent. */
  abMin: number;
  /** Light-off needs the core at this fraction of military. */
  abLightCore: number;
  abRampUpPerSec: number;
  abRampDownPerSec: number;
  /** Core spool time constants, s: from idle, near military, decelerating. */
  spoolUpTauIdle: number;
  spoolUpTauMil: number;
  spoolDownTau: number;
  /** Thrust ∝ σ^k. */
  densityExponent: number;
  /** Thrust × (1 − lowSpeedLapse·M + ram·M²), dry and afterburner. */
  lowSpeedLapse: number;
  ramDry: number;
  ramAb: number;
  /** Where the thrust acts. */
  thrustPoint: Point;
}

/** CD0 × factor(M); induced drag × (1 + inducedGain·max(0, M − 1)). */
interface TransonicConfig {
  machCrit: number;
  machPeak: number;
  peakFactor: number;
  factorAtMach2: number;
  inducedGain: number;
}

/** Fly-by-wire control laws (see ./fbw). */
export interface FbwConfig {
  maxG: number;
  minG: number;
  aoaLimitDeg: number;
  aoaLimitGearDownDeg: number;
  minAoaDeg: number;
  maxRollRateDeg: number;
  maxRollRateGearDownDeg: number;
  rollAoaStartDeg: number;
  rollAtAoaLimitFraction: number;
  betaLimitStartDeg: number;
  betaLimitFullDeg: number;
  rollShaping: number;
  pitchShaping: number;
  pathRateGearDownDeg: number;
  bankCompensationDeg: number;
  pitchOmega: number;
  pitchZeta: number;
  rollTau: number;
  rollAccelDeg?: number;
  rollStopAccelDeg?: number;
  yawOmega: number;
  yawZeta: number;
  pedalBetaDeg: number;
  groundElevatorGain: number;
  groundPitchRateGain: number;
  groundPitchRateDeg: number;
  groundPitchLimitDeg: number;
  groundPitchProtectGain: number;
  liftoffBlendS: number;
}

/** Airliner spoilers: flight spoilers with the lever, ground spoilers on the mains. */
interface SpoilerConfig {
  flightLiftLoss: number;
  groundLiftLoss: number;
  groundCd: number;
  autoIdleThrottle: number;
  autoMinGroundKt: number;
}

interface AeroConfig {
  cl0: number;
  clAlpha: number;
  stallAlphaDeg: number;
  stallAlphaNegDeg: number;
  stallRoundingDeg: number;
  stallBreakWidthDeg: number;
  flatPlateLift: number;
  flatPlateDrag: number;
  cd0: number;
  cdGear: number;
  cdFlapsFull: number;
  clFlapsFull: number;
  stallAlphaFlapsShiftDeg: number;
  cmFlapsFull: number;
  cdBeta: number;
  cyBeta: number;
  cyRudder: number;
  cm0: number;
  cm0Tail: number;
  cmAlpha: number;
  cmQ: number;
  cmAlphaDot: number;
  cmElevator: number;
  cmTrim: number;
  clBeta: number;
  clP: number;
  clR: number;
  clAileron: number;
  clRudder: number;
  cnBeta: number;
  cnP: number;
  cnR: number;
  cnAileron: number;
  cnRudder: number;
  stripStallBlendDeg: number;
  stripAsymOnset: number;
  stripAsymFull: number;
  stripAsymBeta: number;
  stripAsymAileron: number;
  wingStrips: number;
  washoutDeg: number;
  stripStallBreakWidthDeg: number;
  stripRollGainStalled: number;
  stripYawGain: number;
  aileronSpanStart: number;
  stallYawDampingLoss: number;
  stallRudderLoss: number;
  bodyCrossflowCn: number;
  postStallFlapLiftFraction: number;
  stallPitchBreak: number;
  stallTailBlanking: number;
  propwashTail: number;
  propwashTailMaxRatio: number;
  cmGroundEffect: number;
  groundEffectLift: number;
  groundEffectScale: number;
  pFactor: number;
  cdSpeedBrake: number;
  transonic: TransonicConfig | null;
  spoilers?: SpoilerConfig;
  /** Roll control with the flaps up, as a fraction of flaps-down (747 outboard aileron lockout). */
  aileronFlapsUpFraction?: number;
}

interface EngineConfig {
  type: 'piston' | 'jet';
  jet: JetEngineConfig | null;
  maxPowerW: number;
  staticThrustN: number;
  propEfficiency: number;
  spoolUpTau: number;
  spoolDownTau: number;
  idlePower: number;
  idleRpm: number;
  maxRpm: number;
  startTime: number;
  windmillRpmPerKt: number;
  crankRpm: number;
  rpmTau: number;
  spinDownTau: number;
  windmillDragCoeff: number;
}

interface GeometryConfig {
  length: number;
  noseWheel: Point;
  leftMainWheel: Point;
  rightMainWheel: Point;
  strutTravel: number;
  propHub: Point;
  propRadius: number;
  wingRootLeadingEdge: Point;
  wingRootChord: number;
  wingTipChord: number;
  wingTaperStart: number;
  /** Touching the ground with any of these is a crash (belly points only with the gear up). */
  structuralPoints: (Point & { name: string })[];
}

interface GroundConfig {
  springMain: number;
  damperMain: number;
  springNose: number;
  damperNose: number;
  rollingFriction: Record<string, number>;
  brakeFriction: number;
  lateralFriction: number;
  frictionSmoothing: number;
  steeringFadeSpeed: number;
  steeringMinFraction: number;
  longitudinalSmoothing: number;
  bottomOutStiffness: number;
  reboundDampingFactor: number;
  tailSkidFriction: number;
}

export interface AircraftConfig {
  name: string;
  mass: number;
  /** kg·m²: pitch = body X, yaw = body Y, roll = body Z. */
  inertia: { pitch: number; yaw: number; roll: number };
  wingArea: number;
  wingSpan: number;
  meanChord: number;
  oswald: number;
  aero: AeroConfig;
  engine: EngineConfig;
  flaps: {
    notchesDeg: number[];
    rateDegPerSec: number;
    vfeKt: number;
    /** Flaps that come down with the gear handle (F-16 flaperons), deg. */
    autoWithGearDeg: number;
    autoRetractKt: number;
  };
  gear: { transitTime: number; vleKt: number; retractDelay: number; squatSwitch: boolean };
  surfaces: { flapMaxDeg: number; nosewheelSteerMaxDeg: number };
  geometry: GeometryConfig;
  ground: GroundConfig;
  fbw: FbwConfig | null;
  limits: {
    vsoKt: number;
    vs1Kt: number;
    vnoKt: number;
    vneKt: number;
    /** Where a spawned aircraft is trimmed, KIAS (ours, not the source's). */
    cruiseKt: number;
    structuralFailureG: number;
    structuralFailureNegG: number;
    overspeedFailureFactor: number;
    maxAngularRate: number;
  };
  stall: { warningMarginDeg: number; recoveryHysteresisDeg: number };
  landing: {
    butterFpm: number;
    smoothFpm: number;
    firmFpm: number;
    hardFpm: number;
    maxBankDeg: number;
    minPitchDeg: number;
    minAirborneTime: number;
    ditchSpeedKt: number;
    scrapeSpeedMs: number;
    terrainImpactMs: number;
    terrainPenetrationM: number;
    nearGroundAglM: number;
    obstacleCheckAglM: number;
  };
}

export interface FlightConfig {
  sim: { fixedDt: number; gravity: number; seaLevelDensity: number };
  aircraft: AircraftConfig;
}

export const SIM: FlightConfig['sim'] = { fixedDt: 1 / 120, gravity: 9.80665, seaLevelDensity: 1.225 };

const ROLLING_FRICTION = {
  runway: 0.02, asphalt: 0.02, grass: 0.05, field: 0.07, dirt: 0.06, sand: 0.12, urban: 0.03, forest: 0.1, rock: 0.05, snow: 0.08, water: 0.5,
};

// ─── Cessna 172RG Cutlass RG ─────────────────────────────────────────────────
// POH and published stability derivatives (Roskam; JSBSim c172). Calibration:
// stall 49.5 / 42.4 KIAS clean / full flaps, Vy climb 679 fpm, 127 KTAS at 75 %
// power and 8000 ft, glide 9.6:1, developed spin 177 °/s, PARE recovery < ½ turn.

export const C172: AircraftConfig = {
  name: 'Cessna 172RG',
  mass: 1100,
  inertia: { pitch: 1825, yaw: 2667, roll: 1285 },
  wingArea: 16.2,
  wingSpan: 10.92,
  meanChord: 1.49,
  oswald: 0.75,
  aero: {
    cl0: 0.4,
    clAlpha: 4.9,
    stallAlphaDeg: 15.5,
    stallAlphaNegDeg: -13,
    stallRoundingDeg: 2.5,
    stallBreakWidthDeg: 5,
    flatPlateLift: 1.05,
    flatPlateDrag: 1.3,
    cd0: 0.024,
    cdGear: 0.01,
    cdFlapsFull: 0.055,
    clFlapsFull: 0.75,
    stallAlphaFlapsShiftDeg: -2,
    cmFlapsFull: 0.015,
    cdBeta: 0.6,
    cyBeta: -0.31,
    cyRudder: -0.06,
    cm0: 0.05,
    /** The tail's share of cm0; it rides the slipstream, so power pitches the nose up. */
    cm0Tail: 0.08,
    cmAlpha: -0.89,
    cmQ: -12.4,
    cmAlphaDot: -5.2,
    cmElevator: 0.24,
    cmTrim: 0.15,
    clBeta: -0.089,
    clP: -0.47,
    clR: 0.096,
    clAileron: 0.045,
    clRudder: -0.003,
    cnBeta: 0.065,
    cnP: -0.01,
    cnR: -0.099,
    /** Frise-type differential ailerons: net slightly proverse. */
    cnAileron: 0.001,
    cnRudder: 0.032,
    // Strip-theory wing for the stall and spin: see ./aero wingStripMoments.
    stripStallBlendDeg: 1.5,
    stripAsymOnset: 0.01,
    stripAsymFull: 0.05,
    stripAsymBeta: 0.3,
    stripAsymAileron: 0.05,
    wingStrips: 4,
    washoutDeg: 3,
    stripStallBreakWidthDeg: 12,
    stripRollGainStalled: 0.7,
    stripYawGain: 1,
    aileronSpanStart: 0.55,
    stallYawDampingLoss: 0.3,
    stallRudderLoss: 0.2,
    bodyCrossflowCn: 0.3,
    postStallFlapLiftFraction: 0.5,
    stallPitchBreak: -0.12,
    stallTailBlanking: 0.4,
    propwashTail: 0.3,
    propwashTailMaxRatio: 2,
    cmGroundEffect: 0.08,
    groundEffectLift: 0.25,
    groundEffectScale: 0.25,
    pFactor: 0.08,
    cdSpeedBrake: 0,
    transonic: null,
  },
  engine: {
    type: 'piston',
    jet: null,
    /** Lycoming O-360, 180 hp. */
    maxPowerW: 134000,
    staticThrustN: 2500,
    propEfficiency: 0.85,
    spoolUpTau: 0.9,
    spoolDownTau: 0.6,
    idlePower: 0.045,
    idleRpm: 700,
    maxRpm: 2700,
    startTime: 1.4,
    windmillRpmPerKt: 8,
    crankRpm: 180,
    rpmTau: 0.35,
    spinDownTau: 1.5,
    windmillDragCoeff: 0.18,
  },
  flaps: { notchesDeg: [0, 10, 20, 30], rateDegPerSec: 6, vfeKt: 100, autoWithGearDeg: 0, autoRetractKt: 0 },
  gear: { transitTime: 5, vleKt: 140, retractDelay: 1.5, squatSwitch: true },
  surfaces: { flapMaxDeg: 30, nosewheelSteerMaxDeg: 12 },
  geometry: {
    length: 8.28,
    noseWheel: { x: 0, y: -1.22, z: -1.25 },
    leftMainWheel: { x: -1.27, y: -1.22, z: 0.45 },
    rightMainWheel: { x: 1.27, y: -1.22, z: 0.45 },
    strutTravel: 0.18,
    propHub: { x: 0, y: 0.05, z: -2.05 },
    propRadius: 0.96,
    wingRootLeadingEdge: { x: 0, y: 0.95, z: -0.55 },
    wingRootChord: 1.63,
    wingTipChord: 1.13,
    wingTaperStart: 2.5,
    structuralPoints: [
      { name: 'propTip', x: 0, y: -0.91, z: -2.05 },
      { name: 'cowling', x: 0, y: -0.4, z: -1.85 },
      { name: 'leftWingtip', x: -5.46, y: 1.05, z: 0.35 },
      { name: 'rightWingtip', x: 5.46, y: 1.05, z: 0.35 },
      { name: 'tailcone', x: 0, y: -0.1, z: 5.0 },
      { name: 'finTop', x: 0, y: 1.5, z: 5.45 },
      { name: 'cabinRoof', x: 0, y: 1.1, z: 0.0 },
      { name: 'bellyFront', x: 0, y: -0.55, z: -0.9 },
      { name: 'bellyMid', x: 0, y: -0.5, z: 0.6 },
      { name: 'bellyRear', x: 0, y: -0.25, z: 2.8 },
      { name: 'leftStab', x: -1.72, y: -0.02, z: 5.6 },
      { name: 'rightStab', x: 1.72, y: -0.02, z: 5.6 },
    ],
  },
  ground: {
    springMain: 60000,
    damperMain: 6000,
    springNose: 40000,
    damperNose: 3500,
    rollingFriction: ROLLING_FRICTION,
    brakeFriction: 0.6,
    lateralFriction: 0.8,
    frictionSmoothing: 0.25,
    steeringFadeSpeed: 30,
    steeringMinFraction: 0.15,
    longitudinalSmoothing: 0.05,
    bottomOutStiffness: 10,
    reboundDampingFactor: 3,
    tailSkidFriction: 0.4,
  },
  fbw: null,
  limits: {
    vsoKt: 40,
    vs1Kt: 48,
    vnoKt: 129,
    vneKt: 163,
    cruiseKt: 110,
    structuralFailureG: 6.5,
    structuralFailureNegG: -3,
    overspeedFailureFactor: 1.3,
    maxAngularRate: 8,
  },
  stall: { warningMarginDeg: 3, recoveryHysteresisDeg: 2 },
  landing: {
    butterFpm: 120,
    smoothFpm: 300,
    firmFpm: 600,
    hardFpm: 900,
    maxBankDeg: 15,
    minPitchDeg: -6,
    minAirborneTime: 1.5,
    ditchSpeedKt: 0,
    scrapeSpeedMs: 3,
    terrainImpactMs: 8,
    terrainPenetrationM: 0.3,
    nearGroundAglM: 30,
    obstacleCheckAglM: 400,
  },
};

// ─── F-16C Block 50, F110-GE-129 ──────────────────────────────────────────────
// Clean, full internal fuel. Vortex lift to CLmax ≈ 1.6 at ~32° α, transonic
// drag rise, fly-by-wire: 9 g / −3 g, 25° AoA limiter, 300 °/s roll. M 2.0 at
// 40,000 ft, ~40,000 fpm peak climb. Derivatives after Stevens & Lewis / NASA TP-1538.

export const F16: AircraftConfig = {
  name: 'F-16C Fighting Falcon',
  mass: 12000,
  inertia: { pitch: 75674, yaw: 85552, roll: 12875 },
  wingArea: 27.87,
  wingSpan: 9.96,
  meanChord: 3.45,
  oswald: 0.8,
  aero: {
    cl0: 0.1,
    clAlpha: 3.5,
    stallAlphaDeg: 32,
    stallAlphaNegDeg: -20,
    stallRoundingDeg: 14,
    stallBreakWidthDeg: 15,
    flatPlateLift: 1.3,
    flatPlateDrag: 1.7,
    cd0: 0.0185,
    cdGear: 0.02,
    cdFlapsFull: 0.02,
    clFlapsFull: 0.3,
    stallAlphaFlapsShiftDeg: 0,
    cmFlapsFull: -0.03,
    cdBeta: 0.4,
    cyBeta: -1.0,
    cyRudder: -0.1,
    /** Relaxed static stability: nearly neutral in pitch; the FBW does the rest. */
    cm0: 0,
    cm0Tail: 0,
    cmAlpha: -0.25,
    cmQ: -5,
    cmAlphaDot: -1.5,
    cmElevator: 0.6,
    cmTrim: 0.05,
    clBeta: -0.06,
    clP: -0.35,
    clR: 0.1,
    clAileron: 0.05,
    clRudder: 0.01,
    cnBeta: 0.12,
    cnP: -0.02,
    cnR: -0.35,
    cnAileron: -0.004,
    cnRudder: 0.045,
    stripStallBlendDeg: 3,
    stripAsymOnset: 0.01,
    stripAsymFull: 0.05,
    stripAsymBeta: 0.3,
    stripAsymAileron: 0.05,
    wingStrips: 4,
    washoutDeg: 0,
    stripStallBreakWidthDeg: 20,
    stripRollGainStalled: 0.3,
    stripYawGain: 1,
    aileronSpanStart: 0.3,
    stallYawDampingLoss: 0.5,
    stallRudderLoss: 0.5,
    bodyCrossflowCn: 0.4,
    postStallFlapLiftFraction: 0.5,
    stallPitchBreak: -0.02,
    stallTailBlanking: 0.3,
    propwashTail: 0,
    propwashTailMaxRatio: 1,
    cmGroundEffect: 0.03,
    groundEffectLift: 0.12,
    groundEffectScale: 0.25,
    pFactor: 0,
    cdSpeedBrake: 0.06,
    transonic: { machCrit: 0.82, machPeak: 1.1, peakFactor: 2.4, factorAtMach2: 2.2, inducedGain: 0.7 },
  },
  engine: {
    type: 'jet',
    jet: {
      milThrustN: 76300,
      maxThrustN: 129000,
      idleThrustN: 3500,
      abDetent: 0.9,
      abMin: 0.3,
      abLightCore: 0.92,
      abRampUpPerSec: 1.0,
      abRampDownPerSec: 3,
      spoolUpTauIdle: 3.2,
      spoolUpTauMil: 0.6,
      spoolDownTau: 1.1,
      densityExponent: 0.8,
      lowSpeedLapse: 0.45,
      ramDry: 0.3,
      ramAb: 0.4,
      thrustPoint: { x: 0, y: -0.3, z: 7.0 },
    },
    maxPowerW: 0,
    staticThrustN: 76300,
    propEfficiency: 1,
    spoolUpTau: 1,
    spoolDownTau: 1,
    idlePower: 0,
    idleRpm: 70,
    maxRpm: 100,
    startTime: 6,
    windmillRpmPerKt: 0.05,
    crankRpm: 25,
    rpmTau: 0.35,
    spinDownTau: 3,
    windmillDragCoeff: 0,
  },
  flaps: { notchesDeg: [0, 10, 20], rateDegPerSec: 15, vfeKt: 370, autoWithGearDeg: 20, autoRetractKt: 370 },
  gear: { transitTime: 4, vleKt: 300, retractDelay: 1.5, squatSwitch: true },
  surfaces: { flapMaxDeg: 20, nosewheelSteerMaxDeg: 32 },
  geometry: {
    length: 15.06,
    noseWheel: { x: 0, y: -1.75, z: -3.5 },
    leftMainWheel: { x: -1.18, y: -1.75, z: 0.5 },
    rightMainWheel: { x: 1.18, y: -1.75, z: 0.5 },
    strutTravel: 0.22,
    propHub: { x: 0, y: -1.0, z: -2.95 },
    propRadius: 0.45,
    wingRootLeadingEdge: { x: 0, y: -0.3, z: -1.9 },
    wingRootChord: 5.0,
    wingTipChord: 1.05,
    wingTaperStart: 0.8,
    structuralPoints: [
      { name: 'noseTip', x: 0, y: -0.05, z: -8.6 },
      { name: 'radomeBelly', x: 0, y: -0.7, z: -6.4 },
      { name: 'intakeLip', x: 0, y: -0.85, z: -2.95 },
      { name: 'leftWingtip', x: -4.98, y: -0.35, z: 1.8 },
      { name: 'rightWingtip', x: 4.98, y: -0.35, z: 1.8 },
      { name: 'leftStab', x: -2.79, y: -0.55, z: 5.2 },
      { name: 'rightStab', x: 2.79, y: -0.55, z: 5.2 },
      { name: 'finTop', x: 0, y: 3.13, z: 5.6 },
      { name: 'tailcone', x: 0, y: -0.55, z: 5.4 },
      { name: 'leftVentral', x: -0.62, y: -0.85, z: 3.6 },
      { name: 'rightVentral', x: 0.62, y: -0.85, z: 3.6 },
      { name: 'bellyMid', x: 0, y: -0.8, z: 0.0 },
      { name: 'cabinRoof', x: 0, y: 1.25, z: -3.8 },
    ],
  },
  ground: {
    springMain: 650000,
    damperMain: 65000,
    springNose: 420000,
    damperNose: 38000,
    rollingFriction: ROLLING_FRICTION,
    brakeFriction: 0.45,
    lateralFriction: 0.7,
    frictionSmoothing: 0.25,
    steeringFadeSpeed: 25,
    steeringMinFraction: 0.08,
    longitudinalSmoothing: 0.05,
    bottomOutStiffness: 10,
    reboundDampingFactor: 3,
    tailSkidFriction: 0.4,
  },
  fbw: {
    maxG: 9,
    minG: -3,
    aoaLimitDeg: 25,
    aoaLimitGearDownDeg: 16,
    minAoaDeg: -10,
    maxRollRateDeg: 300,
    maxRollRateGearDownDeg: 120,
    rollAoaStartDeg: 10,
    rollAtAoaLimitFraction: 0.25,
    betaLimitStartDeg: 3,
    betaLimitFullDeg: 8,
    rollShaping: 0.6,
    pitchShaping: 0.5,
    pathRateGearDownDeg: 6,
    bankCompensationDeg: 45,
    pitchOmega: 5,
    pitchZeta: 0.8,
    rollTau: 0.12,
    rollAccelDeg: 420,
    rollStopAccelDeg: 1200,
    yawOmega: 3,
    yawZeta: 0.8,
    pedalBetaDeg: 6,
    groundElevatorGain: 0.5,
    groundPitchRateGain: 10,
    groundPitchRateDeg: 5,
    groundPitchLimitDeg: 12,
    groundPitchProtectGain: 2,
    liftoffBlendS: 1,
  },
  limits: {
    vsoKt: 115,
    vs1Kt: 130,
    vnoKt: 600,
    vneKt: 800,
    cruiseKt: 350,
    structuralFailureG: 13.5,
    structuralFailureNegG: -6,
    overspeedFailureFactor: 1.08,
    maxAngularRate: 8,
  },
  stall: { warningMarginDeg: 3, recoveryHysteresisDeg: 2 },
  landing: {
    butterFpm: 150,
    smoothFpm: 360,
    firmFpm: 660,
    hardFpm: 960,
    maxBankDeg: 12,
    minPitchDeg: -3,
    minAirborneTime: 1.5,
    ditchSpeedKt: 0,
    scrapeSpeedMs: 3,
    terrainImpactMs: 8,
    terrainPenetrationM: 0.3,
    nearGroundAglM: 40,
    obstacleCheckAglM: 400,
  },
};

// ─── A-10C Thunderbolt II ──────────────────────────────────────────────────────
// 16 t combat weight, 2 × TF34 (no afterburner, slow spool: idle → 95 % in 7 s),
// straight thick wing (CLmax 1.45 at 18°), direct hydraulic controls with the
// SAS folded into the damping. Roll ~100 °/s at 250–300 KIAS, 369 KTAS max.

export const A10: AircraftConfig = {
  name: 'A-10C Thunderbolt II',
  mass: 16000,
  inertia: { pitch: 130000, yaw: 205000, roll: 85000 },
  wingArea: 47.01,
  wingSpan: 17.53,
  meanChord: 2.73,
  oswald: 0.78,
  aero: {
    cl0: 0.125,
    clAlpha: 4.9,
    stallAlphaDeg: 18,
    stallAlphaNegDeg: -14,
    stallRoundingDeg: 5,
    stallBreakWidthDeg: 12,
    flatPlateLift: 1.2,
    flatPlateDrag: 1.3,
    cd0: 0.047,
    cdGear: 0.012,
    cdFlapsFull: 0.035,
    clFlapsFull: 0.55,
    stallAlphaFlapsShiftDeg: -1,
    cmFlapsFull: -0.02,
    cdBeta: 0.5,
    cyBeta: -0.7,
    cyRudder: -0.12,
    cm0: 0.06,
    cm0Tail: 0,
    cmAlpha: -0.9,
    cmQ: -18,
    cmAlphaDot: -6,
    cmElevator: 0.3,
    cmTrim: 0.2,
    clBeta: -0.09,
    clP: -0.45,
    clR: 0.1,
    clAileron: 0.05,
    clRudder: 0.012,
    cnBeta: 0.15,
    cnP: -0.02,
    cnR: -0.35,
    cnAileron: -0.003,
    cnRudder: 0.06,
    stripStallBlendDeg: 2,
    stripAsymOnset: 0.01,
    stripAsymFull: 0.05,
    stripAsymBeta: 0.3,
    stripAsymAileron: 0.05,
    wingStrips: 4,
    washoutDeg: 1.5,
    stripStallBreakWidthDeg: 20,
    stripRollGainStalled: 0.5,
    stripYawGain: 1,
    aileronSpanStart: 0.55,
    stallYawDampingLoss: 0.05,
    stallRudderLoss: 0.05,
    bodyCrossflowCn: 0.3,
    postStallFlapLiftFraction: 0.5,
    stallPitchBreak: -0.06,
    stallTailBlanking: 0.2,
    propwashTail: 0,
    propwashTailMaxRatio: 1,
    cmGroundEffect: 0.05,
    groundEffectLift: 0.15,
    groundEffectScale: 0.25,
    pFactor: 0,
    /** Decelerons ~60 % open. */
    cdSpeedBrake: 0.09,
    transonic: { machCrit: 0.62, machPeak: 0.85, peakFactor: 3, factorAtMach2: 3, inducedGain: 0 },
  },
  engine: {
    type: 'jet',
    jet: {
      milThrustN: 80600,
      maxThrustN: 80600,
      idleThrustN: 4000,
      abDetent: 1,
      abMin: 0,
      abLightCore: 1,
      abRampUpPerSec: 0,
      abRampDownPerSec: 10,
      spoolUpTauIdle: 5.5,
      spoolUpTauMil: 1.0,
      spoolDownTau: 1.8,
      densityExponent: 0.8,
      lowSpeedLapse: 1.1,
      ramDry: 0.75,
      ramAb: 0,
      thrustPoint: { x: 0, y: 0.35, z: 6.4 },
    },
    maxPowerW: 0,
    staticThrustN: 80600,
    propEfficiency: 1,
    spoolUpTau: 1,
    spoolDownTau: 1,
    idlePower: 0,
    idleRpm: 60,
    maxRpm: 100,
    startTime: 8,
    windmillRpmPerKt: 0.05,
    crankRpm: 22,
    rpmTau: 0.6,
    spinDownTau: 4,
    windmillDragCoeff: 0,
  },
  flaps: { notchesDeg: [0, 7, 20], rateDegPerSec: 4, vfeKt: 210, autoWithGearDeg: 0, autoRetractKt: 0 },
  gear: { transitTime: 6, vleKt: 200, retractDelay: 1.5, squatSwitch: true },
  surfaces: { flapMaxDeg: 20, nosewheelSteerMaxDeg: 45 },
  geometry: {
    length: 16.26,
    noseWheel: { x: 0.3, y: -1.95, z: -4.85 },
    leftMainWheel: { x: -2.62, y: -1.95, z: 0.55 },
    rightMainWheel: { x: 2.62, y: -1.95, z: 0.55 },
    strutTravel: 0.25,
    propHub: { x: 0, y: 1.1, z: 3.1 },
    propRadius: 0.62,
    wingRootLeadingEdge: { x: 0, y: -0.6, z: -0.75 },
    wingRootChord: 3.05,
    wingTipChord: 1.9,
    wingTaperStart: 0.35,
    structuralPoints: [
      { name: 'noseTip', x: 0, y: -0.35, z: -6.95 },
      { name: 'chin', x: 0, y: -1.0, z: -3.6 },
      { name: 'bellyMid', x: 0, y: -1.05, z: 0.5 },
      { name: 'leftWingtip', x: -8.76, y: 0.05, z: 0.9 },
      { name: 'rightWingtip', x: 8.76, y: 0.05, z: 0.9 },
      { name: 'leftEngine', x: -1.55, y: 1.75, z: 4.6 },
      { name: 'rightEngine', x: 1.55, y: 1.75, z: 4.6 },
      { name: 'leftFinTop', x: -2.87, y: 2.52, z: 8.8 },
      { name: 'rightFinTop', x: 2.87, y: 2.52, z: 8.8 },
      { name: 'leftFinRoot', x: -2.87, y: -0.35, z: 8.6 },
      { name: 'rightFinRoot', x: 2.87, y: -0.35, z: 8.6 },
      { name: 'tailcone', x: 0, y: -0.25, z: 9.3 },
      { name: 'cabinRoof', x: 0, y: 1.6, z: -4.0 },
    ],
  },
  ground: {
    springMain: 880000,
    damperMain: 90000,
    springNose: 230000,
    damperNose: 22000,
    rollingFriction: ROLLING_FRICTION,
    brakeFriction: 0.4,
    lateralFriction: 0.7,
    frictionSmoothing: 0.25,
    steeringFadeSpeed: 20,
    steeringMinFraction: 0.1,
    longitudinalSmoothing: 0.05,
    bottomOutStiffness: 10,
    reboundDampingFactor: 3,
    tailSkidFriction: 0.4,
  },
  fbw: null,
  limits: {
    vsoKt: 100,
    vs1Kt: 120,
    vnoKt: 400,
    vneKt: 450,
    cruiseKt: 260,
    structuralFailureG: 11,
    structuralFailureNegG: -4.5,
    overspeedFailureFactor: 1.12,
    maxAngularRate: 8,
  },
  stall: { warningMarginDeg: 4, recoveryHysteresisDeg: 2 },
  landing: {
    butterFpm: 150,
    smoothFpm: 360,
    firmFpm: 660,
    hardFpm: 1000,
    maxBankDeg: 12,
    minPitchDeg: -3,
    minAirborneTime: 1.5,
    ditchSpeedKt: 0,
    scrapeSpeedMs: 3,
    terrainImpactMs: 8,
    terrainPenetrationM: 0.3,
    nearGroundAglM: 40,
    obstacleCheckAglM: 400,
  },
};

// ─── Boeing 747-400, flown light (220 t) ───────────────────────────────────────
// 4 × PW4056, 541 m² swept wing. CLmax 1.30 clean / 2.35 flaps 30, L/D 17.1,
// M 0.85 cruise at FL350, outboard ailerons locked out flaps up, auto ground
// spoilers. Derivatives after Heffley & Jewell, NASA CR-2144.

export const B747: AircraftConfig = {
  name: 'Boeing 747-400',
  mass: 220000,
  inertia: { pitch: 34.2e6, yaw: 51.3e6, roll: 18.8e6 },
  wingArea: 541,
  wingSpan: 64.44,
  meanChord: 8.32,
  oswald: 0.85,
  aero: {
    cl0: 0.25,
    clAlpha: 5.0,
    stallAlphaDeg: 14,
    stallAlphaNegDeg: -12,
    stallRoundingDeg: 4,
    stallBreakWidthDeg: 6,
    flatPlateLift: 1.1,
    flatPlateDrag: 1.4,
    cd0: 0.0175,
    cdGear: 0.018,
    cdFlapsFull: 0.065,
    clFlapsFull: 0.77,
    stallAlphaFlapsShiftDeg: 3.2,
    cmFlapsFull: -0.05,
    cdBeta: 0.5,
    cyBeta: -0.9,
    cyRudder: -0.1,
    cm0: 0.057,
    cm0Tail: 0,
    cmAlpha: -1.3,
    cmQ: -20,
    cmAlphaDot: -4,
    cmElevator: 0.45,
    cmTrim: 0.4,
    clBeta: -0.17,
    clP: -0.45,
    clR: 0.15,
    clAileron: 0.055,
    clRudder: 0.005,
    cnBeta: 0.16,
    cnP: -0.02,
    /** Big fin + the yaw damper. */
    cnR: -0.4,
    cnAileron: 0,
    cnRudder: 0.045,
    stripStallBlendDeg: 2,
    stripAsymOnset: 0.01,
    stripAsymFull: 0.05,
    stripAsymBeta: 0.3,
    stripAsymAileron: 0.05,
    wingStrips: 4,
    washoutDeg: 3.5,
    stripStallBreakWidthDeg: 14,
    stripRollGainStalled: 0.5,
    stripYawGain: 1,
    aileronSpanStart: 0.55,
    stallYawDampingLoss: 0.15,
    stallRudderLoss: 0.1,
    bodyCrossflowCn: 0.3,
    postStallFlapLiftFraction: 0.5,
    stallPitchBreak: -0.3,
    stallTailBlanking: 0.25,
    propwashTail: 0,
    propwashTailMaxRatio: 1,
    cmGroundEffect: 0.06,
    groundEffectLift: 0.12,
    groundEffectScale: 0.25,
    pFactor: 0,
    cdSpeedBrake: 0.02,
    transonic: { machCrit: 0.86, machPeak: 1.05, peakFactor: 4.5, factorAtMach2: 4, inducedGain: 0 },
    spoilers: { flightLiftLoss: 0.12, groundLiftLoss: 0.85, groundCd: 0.08, autoIdleThrottle: 0.05, autoMinGroundKt: 30 },
    aileronFlapsUpFraction: 0.45,
  },
  engine: {
    type: 'jet',
    jet: {
      milThrustN: 1008000,
      maxThrustN: 1008000,
      idleThrustN: 36000,
      abDetent: 1,
      abMin: 0,
      abLightCore: 1,
      abRampUpPerSec: 0,
      abRampDownPerSec: 10,
      spoolUpTauIdle: 5.2,
      spoolUpTauMil: 1.2,
      spoolDownTau: 2.5,
      densityExponent: 0.8,
      lowSpeedLapse: 1.1,
      ramDry: 0.6,
      ramAb: 0,
      /** The pods hang below the CG: power pitches the nose up. */
      thrustPoint: { x: 0, y: -2.1, z: -6 },
    },
    maxPowerW: 0,
    staticThrustN: 1008000,
    propEfficiency: 1,
    spoolUpTau: 1,
    spoolDownTau: 1,
    idlePower: 0,
    idleRpm: 62,
    maxRpm: 100,
    startTime: 10,
    windmillRpmPerKt: 0.05,
    crankRpm: 22,
    rpmTau: 0.8,
    spinDownTau: 5,
    windmillDragCoeff: 0,
  },
  flaps: { notchesDeg: [0, 5, 10, 20, 25, 30], rateDegPerSec: 2, vfeKt: 180, autoWithGearDeg: 0, autoRetractKt: 0 },
  gear: { transitTime: 10, vleKt: 320, retractDelay: 1.5, squatSwitch: true },
  surfaces: { flapMaxDeg: 30, nosewheelSteerMaxDeg: 70 },
  geometry: {
    length: 70.66,
    noseWheel: { x: 0, y: -5.0, z: -23.6 },
    leftMainWheel: { x: -5.5, y: -5.0, z: 2.0 },
    rightMainWheel: { x: 5.5, y: -5.0, z: 2.0 },
    strutTravel: 0.45,
    propHub: { x: 0, y: -2.4, z: -12 },
    propRadius: 1.35,
    wingRootLeadingEdge: { x: 0, y: -2.2, z: -12 },
    wingRootChord: 14.5,
    wingTipChord: 4.1,
    wingTaperStart: 0.3,
    structuralPoints: [
      { name: 'noseTip', x: 0, y: 0, z: -32.0 },
      { name: 'chin', x: 0, y: -2.6, z: -28 },
      { name: 'bellyForward', x: 0, y: -3.2, z: -15 },
      { name: 'bellyMid', x: 0, y: -3.3, z: 0 },
      { name: 'bellyAft', x: 0, y: -2.9, z: 16 },
      { name: 'tailBumper', x: 0, y: -0.6, z: 26.5 },
      { name: 'tailcone', x: 0, y: 1.3, z: 36.6 },
      { name: 'finTop', x: 0, y: 14.41, z: 37.5 },
      { name: 'leftWingtip', x: -32.22, y: 1.4, z: 16.55 },
      { name: 'rightWingtip', x: 32.22, y: 1.4, z: 16.55 },
      { name: 'leftStab', x: -11.08, y: 2.2, z: 36 },
      { name: 'rightStab', x: 11.08, y: 2.2, z: 36 },
      { name: 'leftInboardEngine', x: -11.9, y: -3.75, z: -6.55 },
      { name: 'rightInboardEngine', x: 11.9, y: -3.75, z: -6.55 },
      { name: 'leftOutboardEngine', x: -21.2, y: -2.9, z: 2.17 },
      { name: 'rightOutboardEngine', x: 21.2, y: -2.9, z: 2.17 },
      { name: 'upperDeckRoof', x: 0, y: 5.2, z: -26 },
    ],
  },
  ground: {
    springMain: 6.7e6,
    damperMain: 9.0e5,
    springNose: 1.4e6,
    damperNose: 1.7e5,
    rollingFriction: ROLLING_FRICTION,
    brakeFriction: 0.34,
    lateralFriction: 0.7,
    frictionSmoothing: 0.25,
    steeringFadeSpeed: 15,
    steeringMinFraction: 0.05,
    longitudinalSmoothing: 0.05,
    bottomOutStiffness: 10,
    reboundDampingFactor: 3,
    tailSkidFriction: 0.4,
  },
  fbw: null,
  limits: {
    vsoKt: 103,
    vs1Kt: 138,
    vnoKt: 340,
    vneKt: 365,
    cruiseKt: 250,
    structuralFailureG: 3.75,
    structuralFailureNegG: -1.5,
    overspeedFailureFactor: 1.15,
    maxAngularRate: 3,
  },
  stall: { warningMarginDeg: 3, recoveryHysteresisDeg: 2 },
  landing: {
    butterFpm: 120,
    smoothFpm: 300,
    firmFpm: 480,
    hardFpm: 720,
    maxBankDeg: 8,
    minPitchDeg: -1,
    minAirborneTime: 1.5,
    ditchSpeedKt: 0,
    scrapeSpeedMs: 6,
    terrainImpactMs: 8,
    terrainPenetrationM: 0.3,
    nearGroundAglM: 45,
    obstacleCheckAglM: 400,
  },
};

// ─── Similarity scaling ────────────────────────────────────────────────────────

export interface ScaleOptions {
  name: string;
  /** Overall length of the aircraft to build, metres. */
  lengthM: number;
  /** Its mass; the Froude-similar mass (base × k³) when absent. */
  massKg?: number;
  /** Extra factor on the engine's power / thrust beyond the similar one. */
  powerFactor?: number;
  /** Replace the never-exceed speed (KIAS) the scaling would give. */
  vneKt?: number;
}

const scalePoint = <P extends Point>(p: P, k: number): P => ({ ...p, x: p.x * k, y: p.y * k, z: p.z * k });

/**
 * A new airframe, dynamically similar to `base`.
 *
 * Froude scaling at the same air density: lengths × k, mass × k³, speeds × √k
 * — which leaves every aerodynamic coefficient, every calibrated handling
 * quality and every ratio of thrust to weight exactly as they were, so an
 * A320 built from the 747 flies like a smaller 747 rather than like guesswork.
 * A mass other than the similar one moves the wing loading, and the speeds
 * follow it: speed × √(mass ratio / k²).
 *
 * The struts keep their static compression as a fraction of their travel and
 * their fraction of critical damping; the limits and placards move with the
 * speeds; the load-factor limits and the landing ratings (sink rates the
 * gear is designed for, which are similar across sizes) stay.
 */
export function scaleAirframe(base: AircraftConfig, o: ScaleOptions): AircraftConfig {
  const k = o.lengthM / base.geometry.length;
  const mass = o.massKg ?? base.mass * k * k * k;
  const m = mass / base.mass;
  const v = Math.sqrt(m / (k * k));
  const power = o.powerFactor ?? 1;
  const g = base.geometry;
  const e = base.engine;
  const j = e.jet;
  const speeds = <T extends Record<string, number>>(t: T, keys: (keyof T)[]): T => {
    const out = { ...t };
    for (const key of keys) (out[key] as number) = t[key]! * v;
    return out;
  };
  return {
    ...base,
    name: o.name,
    mass,
    inertia: { pitch: base.inertia.pitch * m * k * k, yaw: base.inertia.yaw * m * k * k, roll: base.inertia.roll * m * k * k },
    wingArea: base.wingArea * k * k,
    wingSpan: base.wingSpan * k,
    meanChord: base.meanChord * k,
    engine: {
      ...e,
      jet: j
        ? {
            ...j,
            milThrustN: j.milThrustN * m * power,
            maxThrustN: j.maxThrustN * m * power,
            idleThrustN: j.idleThrustN * m,
            thrustPoint: scalePoint(j.thrustPoint, k),
          }
        : null,
      maxPowerW: e.maxPowerW * m * v * power,
      staticThrustN: e.staticThrustN * m * power,
    },
    flaps: { ...base.flaps, vfeKt: base.flaps.vfeKt * v, autoRetractKt: base.flaps.autoRetractKt * v },
    gear: { ...base.gear, vleKt: base.gear.vleKt * v },
    geometry: {
      length: o.lengthM,
      noseWheel: scalePoint(g.noseWheel, k),
      leftMainWheel: scalePoint(g.leftMainWheel, k),
      rightMainWheel: scalePoint(g.rightMainWheel, k),
      strutTravel: g.strutTravel * k,
      propHub: scalePoint(g.propHub, k),
      propRadius: g.propRadius * k,
      wingRootLeadingEdge: scalePoint(g.wingRootLeadingEdge, k),
      wingRootChord: g.wingRootChord * k,
      wingTipChord: g.wingTipChord * k,
      wingTaperStart: g.wingTaperStart * k,
      structuralPoints: g.structuralPoints.map((p) => scalePoint(p, k)),
    },
    ground: {
      ...base.ground,
      springMain: (base.ground.springMain * m) / k,
      springNose: (base.ground.springNose * m) / k,
      damperMain: (base.ground.damperMain * m) / Math.sqrt(k),
      damperNose: (base.ground.damperNose * m) / Math.sqrt(k),
      steeringFadeSpeed: base.ground.steeringFadeSpeed * v,
    },
    limits: {
      ...speeds(base.limits, ['vsoKt', 'vs1Kt', 'vnoKt', 'vneKt', 'cruiseKt']),
      ...(o.vneKt ? { vneKt: o.vneKt } : {}),
    },
    landing: { ...base.landing, nearGroundAglM: base.landing.nearGroundAglM * Math.max(1, k) },
  };
}

/** Degrees of flap for a notch, clamped. */
export function flapNotchDeg(cfg: FlightConfig, notch: number): number {
  const n = cfg.aircraft.flaps.notchesDeg;
  return n[Math.max(0, Math.min(n.length - 1, Math.round(notch)))]!;
}

/** Stall angle of attack for flaps up, radians (for the stall-warning readout). */
export function stallWarningAlpha(cfg: FlightConfig, flapsDeg: number): number {
  const a = cfg.aircraft.aero;
  const f = Math.max(0, Math.min(1, flapsDeg / cfg.aircraft.surfaces.flapMaxDeg));
  return (a.stallAlphaDeg + a.stallAlphaFlapsShiftDeg * f - cfg.aircraft.stall.warningMarginDeg) * DEG;
}
