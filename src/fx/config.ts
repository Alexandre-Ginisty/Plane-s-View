/**
 * Tuning of the effects simulation.
 *
 * Adapted from Tater's Flight Sim (https://github.com/JaredTate/tatertotsflightsim),
 * MIT licence, Copyright (c) 2026 Jared Tate — see ./LICENSE. The numbers are
 * theirs, tuned for a light aircraft; everything that should grow with the
 * size of what blew up takes a `scale` in `./sim` (1 = a ten-metre airframe).
 */

export const FX = {
  /** Seed of the effects RNG (deterministic bursts for tests). */
  seed: 1721,
  /** Preallocated pools: smoke/dust, fire/embers (one sorted draw call together) and solid debris. */
  smokeCapacity: 3200,
  fireCapacity: 2400,
  debrisCapacity: 160,
  /** Continuous emitters (part fires, smoke columns, steam), preallocated. */
  maxEmitters: 48,
  /** Particles fade out when the camera is closer than size × nearFade. */
  nearFade: 0.55,
  /** …and once one sprite would cover more than this fraction of the screen height. */
  maxScreenCover: 0.45,
  /** Fire: HDR emission scale of the black-body ramp, and how much the hottest flame still occludes. */
  fireIntensity: 2.4,
  fireOcclusion: 0.55,
  /** Sparks/embers: emission × fireIntensity; drawn as streaks over this exposure (s). */
  sparkIntensity: 1.5,
  shutter: 0.02,
  /** Sprites smaller than this many pixels grow to it with opacity × (size/min)². */
  minPixels: 1.5,
  /** Smoke self-shadowing strength 0..1. */
  selfShadow: 0.85,
  /** Fire light on smoke uses at least this albedo. */
  glowFloor: 0.1,
  /** Fire light on the smoke above it (linear RGB per unit glow). */
  smokeGlow: [0.4, 0.15, 0.035] as [number, number, number],
  /** Side of the tiling animated-noise texture, px. */
  noiseSize: 128,
  /** The point light at the fire (candela per unit fire level, at scale 1) and its reach (m). */
  fireLightIntensity: 150,
  fireLightDistance: 140,
  /** The white-hot flash through the same light (candela at flash level 1, scale 1). */
  flashLightIntensity: 1600,
  crash: {
    fireMinKt: 25,
    fireballCount: 80,
    fireballLife: [1.2, 2.4] as [number, number],
    fireballSize: [7, 16] as [number, number],
    fireballSpeed: 14,
    smokeDuration: 20,
    smokeRate: 12,
    smokeLife: [20, 32] as [number, number],
    smokeSize: [5, 36] as [number, number],
    smokeGrowTau: 9,
    smokeRise: 8,
    smokeBuoyancy: 3,
    smokeBuoyancyTau: 25,
    smokeDrag: 0.28,
    smokeAlbedo: 0.04,
    smokeLighten: 2.5,
    smokeTint: [1.1, 1.0, 0.88] as [number, number, number],
    groundFireDuration: 16,
    groundFireRate: 55,
    partFireRate: 45,
    partSmokeRate: 7,
    debrisCount: 30,
    emberCount: 80,
  },
  fire: {
    heightPerRadius: [1.0, 1.0] as [number, number],
    maxHeight: 7,
    maxFlameSize: 4.2,
    bodyShare: 0.4,
    tongueShare: 0.4,
  },
  touchdown: {
    minPuffs: 2,
    maxPuffs: 8,
    life: [0.8, 1.8] as [number, number],
    softSize: 0.9,
    hardSize: 2.6,
    softAlpha: 0.12,
    hardAlpha: 0.45,
    smokeAlbedo: [0.72, 0.73, 0.75] as [number, number, number],
    dustAlbedo: [0.46, 0.38, 0.28] as [number, number, number],
    grassAlbedo: [0.38, 0.4, 0.27] as [number, number, number],
    sprayAlbedo: [0.85, 0.88, 0.9] as [number, number, number],
    fullFpm: 700,
  },
} as const;
