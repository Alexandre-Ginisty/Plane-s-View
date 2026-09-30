/**
 * Contracts of the flight model.
 *
 * Adapted from Tater's Flight Sim (https://github.com/JaredTate/tatertotsflightsim),
 * MIT licence, Copyright (c) 2026 Jared Tate — see ./LICENSE.
 *
 * ## Frames (read before touching any maths)
 *
 * WORLD: a local tangent plane at the anchor `GlobeFlight` keeps near the
 * aircraft. +X east, +Y up, +Z south (north is -Z). y is height above mean sea
 * level, metres. Heading 0 = north (-Z), 90 = east (+X).
 *
 * BODY: +X right wing, +Y up, -Z the nose. Origin at the centre of gravity.
 * `orientation` rotates body vectors into world vectors.
 *
 * Aircraft conventions, only through the helpers in ./frames:
 *   u (forward) = -v_body.z, v (right) = v_body.x, w (down) = -v_body.y
 *   alpha = atan2(w, u), beta = asin(v / V)
 *   p (roll, + right wing down) = -omega.z, q (pitch, + nose up) = omega.x,
 *   r (yaw, + nose right) = -omega.y
 *   L roll -> torque.z = -L, M pitch -> torque.x = M, N yaw -> torque.y = -N
 *
 * Display Euler angles: heading clockwise from north, pitch + nose up, roll +
 * right wing down; quat = Ry(-psi) Rx(theta) Rz(-phi).
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

type FlightPhase = 'ground' | 'airborne' | 'landed' | 'crashed';

export type SurfaceType =
  | 'runway'
  | 'asphalt'
  | 'grass'
  | 'dirt'
  | 'field'
  | 'forest'
  | 'rock'
  | 'snow'
  | 'sand'
  | 'urban'
  | 'water';

/** Pilot inputs as the physics sees them, already smoothed by ./controls. */
export interface Controls {
  /** 0..1 throttle lever (jets: afterburner past the detent). */
  throttle: number;
  /** -1..1, +1 = stick fully back (nose up). */
  elevator: number;
  /** -1..1, +1 = full right aileron. */
  aileron: number;
  /** -1..1, +1 = full right rudder (also steers the nosewheel on the ground). */
  rudder: number;
  /** -1..1, +1 = full nose-up trim. */
  elevatorTrim: number;
  /** Index into the airframe's flap notches (0 = up). */
  flapsNotch: number;
  gearDown: boolean;
  /** 0..1 wheel brakes. */
  brake: number;
  parkingBrake: boolean;
  engineOn: boolean;
  speedBrake?: boolean;
}

/**
 * The world as the physics sees it: pure functions of world x/z (metres).
 */
export interface Environment {
  /** Terrain height MSL at x, z. */
  groundHeight(x: number, z: number): number;
  /** Unit surface normal at x, z (optional; +Y otherwise). */
  groundNormal?(x: number, z: number): Vec3;
  surfaceAt(x: number, z: number): SurfaceType;
  /** Water surface height at x, z, or null where there is none. */
  waterLevel(x: number, z: number): number | null;
  /** Top of the tallest obstacle at x, z, or -Infinity. */
  obstacleTop?(x: number, z: number): number;
  /** Air velocity, world frame, m/s (where the air moves to). */
  wind?(x: number, y: number, z: number, time: number): Vec3;
}

export interface EngineState {
  running: boolean;
  starting: boolean;
  startTimer: number;
  failed: boolean;
  /** 0..1 of max power (piston) or of military thrust (jet core). */
  power: number;
  /** Propeller rpm, or core speed in percent for a jet. */
  rpm: number;
  /** Newtons. */
  thrust: number;
  /** 0..1 afterburner intensity (jets). */
  afterburner?: number;
}

export interface TouchdownRecord {
  time: number;
  /** Feet per minute at first contact, negative descending. */
  verticalSpeedFpm: number;
  airspeedKt: number;
  rating: 'butter' | 'smooth' | 'firm' | 'hard';
  bankDeg: number;
  pitchDeg: number;
  surface: SurfaceType;
}

export interface CrashRecord {
  time: number;
  /** Human-readable cause: "Hit terrain", "Structural failure — over-G", … */
  reason: string;
  speedKt: number;
  verticalSpeedFpm: number;
  position: Vec3;
}

/** Values derived from the state every step, for instruments and tests. */
export interface DerivedData {
  /** True airspeed, m/s. */
  tas: number;
  /** Indicated (equivalent) airspeed, m/s. */
  ias: number;
  groundSpeed: number;
  /** Radians. */
  alpha: number;
  beta: number;
  /** m/s, + climbing. */
  verticalSpeed: number;
  /** Height of the CG above the surface below, metres. */
  altitudeAGL: number;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** g along body up (1 in level flight). */
  loadFactor: number;
  density: number;
  /** Body rates, aircraft convention, rad/s. */
  p: number;
  q: number;
  r: number;
}

export interface AircraftState {
  time: number;
  /** CG, world metres. */
  position: Vec3;
  /** World velocity, m/s. */
  velocity: Vec3;
  /** Body -> world. */
  orientation: Quat;
  /** Body-frame angular velocity, rad/s. */
  angularVelocity: Vec3;
  engine: EngineState;
  flapsDeg: number;
  /** 0 up … 1 down and locked. */
  gearPos: number;
  phase: FlightPhase;
  stalled: boolean;
  onGround: boolean;
  /** [nose, left main, right main]. */
  wheelContact: [boolean, boolean, boolean];
  wheelCompression: [number, number, number];
  /** Seconds continuously airborne. */
  airborneTime: number;
  touchdown: TouchdownRecord | null;
  crash: CrashRecord | null;
  derived: DerivedData;
}
