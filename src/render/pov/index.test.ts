/**
 * The camera, from the outside.
 *
 * Framing is the one part of this the user judges continuously and cannot
 * describe: "the view isn't smooth" is a report about a subject that will not
 * stay where it is supposed to be. These tests assert that directly — where
 * the aircraft lands on screen, frame by frame, while the view is being
 * moved — rather than checking the arithmetic that is supposed to produce it.
 */

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';

import { FloatingOrigin } from '@/core/frame';
import { geodeticToEcef, FEET_TO_METRES } from '@/core/math/geo';
import type { SampledAircraft } from '@/state/traffic';
import { PovController } from './index';

function aircraft(overrides: Partial<SampledAircraft> = {}): SampledAircraft {
  return {
    hex: 'abc123',
    lat: 48.85,
    lon: 2.35,
    altFt: 36_000,
    trackDeg: 90,
    headingDeg: 90,
    rollDeg: 0,
    pitchDeg: 2,
    groundSpeedKt: 480,
    verticalRateFpm: 0,
    ageSec: 0,
    stale: false,
    uncertaintyM: 20,
    latest: { category: 'A3' } as SampledAircraft['latest'],
    ...overrides,
  };
}

/** Where the aircraft sits in normalised device coordinates, 0 = centred. */
function subjectOffset(camera: PerspectiveCamera, origin: FloatingOrigin, s: SampledAircraft): number {
  const ecef = geodeticToEcef(s.lat, s.lon, s.altFt * FEET_TO_METRES);
  const p = new Vector3(
    ecef[0] - origin.current[0],
    ecef[1] - origin.current[1],
    ecef[2] - origin.current[2],
  ).project(camera);
  return Math.hypot(p.x, p.y);
}

function rig(): { pov: PovController; camera: PerspectiveCamera; origin: FloatingOrigin } {
  const origin = new FloatingOrigin();
  const camera = new PerspectiveCamera(50, 1.9, 0.5, 500_000);
  camera.up.set(0, 0, 1);
  const pov = new PovController(origin);
  // 826 px tall at 50 degrees, the real window this was tuned against.
  pov.setViewport((2 * Math.tan((50 * Math.PI) / 180 / 2)) / 826);
  return { pov, camera, origin };
}

/**
 * Fly the aircraft east at its reported ground speed.
 *
 * The missing ingredient in everything below it: every other test feeds the
 * same sample every frame, and a target that never moves cannot reveal a
 * filter that cannot follow a moving one.
 */
function flyEast(base: SampledAircraft, frame: number, dt: number): SampledAircraft {
  const metresPerSecond = base.groundSpeedKt * 0.514_444;
  const metresPerDegree = 111_320 * Math.cos((base.lat * Math.PI) / 180);
  return { ...base, lon: base.lon + (metresPerSecond * dt * frame) / metresPerDegree };
}

describe('following an aircraft that is actually moving', () => {
  const dt = 1 / 60;

  it('keeps a fast airliner centred in orbit', () => {
    /*
     * The bug this exists for. A plain first-order lag on the anchor has a
     * steady-state error of speed times time constant — at 480 knots and
     * 0.1 s that is twenty-five metres, most of a fuselage — and the orbit
     * camera aims at the anchor while the model is drawn at the true
     * position. The aeroplane therefore sat permanently off to one side of
     * the one view whose entire purpose is to centre it, and every test
     * passed because none of them moved it.
     */
    const { pov, camera, origin } = rig();
    pov.setMode('orbit');
    const base = aircraft();

    let sample = base;
    for (let frame = 0; frame < 240; frame++) {
      sample = flyEast(base, frame, dt);
      pov.update(camera, sample, dt);
    }

    expect(subjectOffset(camera, origin, sample)).toBeLessThan(0.05);
  });

  it('keeps it centred in chase and wing views too', () => {
    for (const mode of ['chase', 'wing'] as const) {
      const { pov, camera, origin } = rig();
      pov.setMode(mode);
      const base = aircraft();

      let sample = base;
      for (let frame = 0; frame < 240; frame++) {
        sample = flyEast(base, frame, dt);
        pov.update(camera, sample, dt);
      }

      expect(subjectOffset(camera, origin, sample), mode).toBeLessThan(0.1);
    }
  });

  it('still absorbs a jump rather than snapping to it', () => {
    // The filter has to stay a filter. A new fix that disagrees with the
    // track by thirty metres is the tremor this exists to remove, and it must
    // not arrive in one frame.
    const { pov, camera, origin } = rig();
    pov.setMode('orbit');
    const base = aircraft({ groundSpeedKt: 0 });

    for (let frame = 0; frame < 120; frame++) pov.update(camera, base, dt);

    const jumped = { ...base, lat: base.lat + 0.0005 }; // about 55 m north
    pov.update(camera, jumped, dt);

    // One frame later the camera has moved a little towards it, not all of it.
    const settled = subjectOffset(camera, origin, base);
    expect(settled).toBeGreaterThan(0);

    for (let frame = 0; frame < 120; frame++) pov.update(camera, jumped, dt);
    expect(subjectOffset(camera, origin, jumped)).toBeLessThan(0.05);
  });
});

/**
 * A parked aircraft, for the tests that measure the camera against fixed
 * world coordinates.
 *
 * Explicit, because the default sample reports 480 knots and the suite used to
 * hold it at one set of coordinates anyway — a state no real aircraft is ever
 * in, and precisely the reason a filter that could not follow a moving target
 * went unnoticed for so long. Anything measuring absolute displacement wants a
 * genuinely stationary subject; anything measuring *following* wants
 * `flyEast`, above.
 */
const parked = (): SampledAircraft => aircraft({ groundSpeedKt: 0, verticalRateFpm: 0 });

describe('PovController framing', () => {
  /**
   * The regression. Position and orientation used to be smoothed on separate
   * time constants — 40 ms and 180 ms — so a drag swung the eye round five
   * times faster than it re-aimed, and the aircraft slid out towards the edge
   * of frame before creeping back. That is what "the view sloshes when I move
   * it" was.
   */
  it('keeps the aircraft centred throughout an orbit drag', () => {
    const { pov, camera, origin } = rig();
    const s = parked();
    pov.setMode('orbit');
    for (let i = 0; i < 30; i++) pov.update(camera, s, 1 / 60);

    let worst = 0;
    // A brisk drag: 400 px across, over ten frames.
    for (let i = 0; i < 10; i++) {
      pov.applyDrag(40, 0);
      pov.update(camera, s, 1 / 60);
      worst = Math.max(worst, subjectOffset(camera, origin, s));
    }
    // ...and the follow-through once the hand stops.
    for (let i = 0; i < 20; i++) {
      pov.update(camera, s, 1 / 60);
      worst = Math.max(worst, subjectOffset(camera, origin, s));
    }

    // Half a percent of the half-height. The subject is pinned, not chased.
    expect(worst).toBeLessThan(0.005);
  });

  it('keeps it centred in chase and tower too', () => {
    for (const mode of ['chase', 'tower'] as const) {
      const { pov, camera, origin } = rig();
      const s = parked();
      pov.setMode(mode);
      for (let i = 0; i < 40; i++) pov.update(camera, s, 1 / 60);
      expect(subjectOffset(camera, origin, s), mode).toBeLessThan(0.01);
    }
  });
});

describe('PovController input', () => {
  /**
   * Drag used to be a flat 0.005 rad per pixel whatever the camera was doing,
   * which at this field of view is about five times the angle the pixel under
   * the cursor moved through — the view outran the hand.
   */
  it('rotates the orbit by the angle the cursor actually travelled', () => {
    const { pov } = rig();
    const radPerPx = (2 * Math.tan((50 * Math.PI) / 180 / 2)) / 826;
    pov.setMode('orbit');

    const before = pov.state.orbitYaw;
    pov.applyDrag(100, 0);
    expect(before - pov.state.orbitYaw).toBeCloseTo(100 * radPerPx, 6);
  });

  it('scales with the viewport rather than assuming one', () => {
    const { pov } = rig();
    pov.setMode('orbit');

    pov.setViewport(0.001);
    const a = pov.state.orbitYaw;
    pov.applyDrag(50, 0);
    const coarse = a - pov.state.orbitYaw;

    pov.setViewport(0.0005);
    const b = pov.state.orbitYaw;
    pov.applyDrag(50, 0);
    const fine = b - pov.state.orbitYaw;

    expect(coarse).toBeCloseTo(fine * 2, 8);
  });

  /** A trackpad sends a stream of small deltas; stepping on each is a stutter. */
  it('eases the orbit distance towards the wheel instead of jumping', () => {
    const { pov, camera } = rig();
    const s = aircraft();
    pov.setMode('orbit');
    pov.update(camera, s, 1 / 60);

    const start = pov.state.orbitDistance;
    pov.applyZoom(600); // a firm scroll outwards
    expect(pov.state.orbitDistance).toBe(start); // nothing until a frame runs

    pov.update(camera, s, 1 / 60);
    const afterOne = pov.state.orbitDistance;
    expect(afterOne).toBeGreaterThan(start);

    for (let i = 0; i < 60; i++) pov.update(camera, s, 1 / 60);
    const settled = pov.state.orbitDistance;

    // One frame moves a fraction of the way; a second of frames arrives.
    expect(afterOne - start).toBeLessThan((settled - start) * 0.25);
    expect(settled).toBeCloseTo(start * Math.exp(0.6), 0);
  });
});

describe('PovController input latency', () => {
  /** Angle between the camera's forward axis and a reference, radians. */
  function forwardOf(camera: PerspectiveCamera): Vector3 {
    return new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  }

  it('turns the head the full amount on the very next frame', () => {
    // The complaint this fixes. Free look used to be slerped on an 80 ms
    // constant along with the airframe's attitude, so a drag arrived over
    // about five frames and kept going after the hand stopped. Damping is for
    // noisy data; applying it to a deliberate input is just latency.
    const { pov, camera, origin } = rig();
    const s = aircraft();

    pov.setMode('cockpit');
    pov.update(camera, s, 1 / 60);
    const before = forwardOf(camera);

    pov.applyDrag(200, 0);
    pov.update(camera, s, 1 / 60);
    const afterOneFrame = forwardOf(camera).angleTo(before);

    // Ten more frames with no further input must add essentially nothing.
    for (let i = 0; i < 10; i++) pov.update(camera, s, 1 / 60);
    const settled = forwardOf(camera).angleTo(before);

    expect(afterOneFrame).toBeGreaterThan(0.05);
    expect(afterOneFrame).toBeCloseTo(settled, 3);
    expect(origin).toBeDefined();
  });

  it('orbits with the cursor rather than crawling after it', () => {
    // Orbit moved the *desired* position and then eased the real one towards
    // it over 140 ms, so the view trailed the drag by about a seventh of a
    // second — the most obvious lag in the app, because orbit is the mode
    // people drag hardest.
    const { pov, camera } = rig();
    const s = parked();

    pov.setMode('orbit');
    pov.update(camera, s, 1 / 60);
    const before = camera.position.clone();

    pov.applyDrag(150, 0);
    pov.update(camera, s, 1 / 60);
    const moved = camera.position.distanceTo(before);

    for (let i = 0; i < 10; i++) pov.update(camera, s, 1 / 60);
    const settled = camera.position.distanceTo(before);

    expect(moved).toBeGreaterThan(1);
    // Within a couple of percent of its final place immediately.
    expect(moved).toBeGreaterThan(settled * 0.98);
  });

  it('still damps the aircraft, so a jittering track does not shake the view', () => {
    // The other half: the reason smoothing exists at all. The camera must not
    // reproduce the track filter's frame-to-frame corrections.
    const { pov, camera } = rig();
    pov.setMode('cockpit');
    pov.update(camera, aircraft({ rollDeg: 0 }), 1 / 60);
    const level = forwardOf(camera);

    // One frame of a 6-degree roll correction, the size the filter produces.
    pov.update(camera, aircraft({ rollDeg: 6, pitchDeg: 8 }), 1 / 60);
    const jolted = forwardOf(camera).angleTo(level);

    for (let i = 0; i < 30; i++) pov.update(camera, aircraft({ rollDeg: 6, pitchDeg: 8 }), 1 / 60);
    const arrived = forwardOf(camera).angleTo(level);

    expect(arrived).toBeGreaterThan(0.05);
    // The first frame delivers only a fraction of it.
    expect(jolted).toBeLessThan(arrived * 0.5);
  });

  it('eases the return to centre instead of teleporting', () => {
    const { pov, camera } = rig();
    const s = aircraft();
    pov.setMode('cockpit');
    pov.update(camera, s, 1 / 60);
    const centred = forwardOf(camera);

    pov.applyDrag(300, 0);
    pov.update(camera, s, 1 / 60);
    const turned = forwardOf(camera).angleTo(centred);

    pov.recentre();
    pov.update(camera, s, 1 / 60);
    const afterOneFrame = forwardOf(camera).angleTo(centred);

    // Still most of the way out after one frame — it is travelling, not gone.
    expect(afterOneFrame).toBeGreaterThan(turned * 0.5);

    for (let i = 0; i < 90; i++) pov.update(camera, s, 1 / 60);
    expect(forwardOf(camera).angleTo(centred)).toBeLessThan(0.01);
  });

  it('lets a new drag override a return in progress', () => {
    const { pov, camera } = rig();
    const s = aircraft();
    pov.setMode('cockpit');
    pov.update(camera, s, 1 / 60);

    pov.applyDrag(200, 0);
    pov.update(camera, s, 1 / 60);
    pov.recentre();
    pov.update(camera, s, 1 / 60);
    pov.applyDrag(200, 0);

    // The hand wins: thirty frames later the view is where the drag put it,
    // not back at centre.
    const afterDrag = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    for (let i = 0; i < 30; i++) pov.update(camera, s, 1 / 60);
    expect(forwardOf(camera).angleTo(afterDrag)).toBeGreaterThan(0.05);
    expect(pov.state.lookYaw).not.toBe(0);
  });
});
