/**
 * The aeroplane on the front page.
 *
 * A self-contained Three.js scene: its own canvas, its own renderer, its own
 * loop, torn down completely when the visitor goes in. It shares nothing with
 * the main renderer on purpose — the globe owns a WebGL context, a worker pool
 * and a floating origin, and none of that has any business being alive to spin
 * a model on a front page.
 *
 * ## The model is the real one
 *
 * It starts as the procedural airframe, because that is synchronous and the
 * page must not open with a hole in it, and upgrades to the converted
 * FlightGear 787 the moment its megabyte lands — the same asset the app swaps
 * in when you step inside one. A separate hero model would be a promise the
 * product then has to keep, and the first time the two drifted apart the front
 * page would be advertising an aeroplane the app does not draw.
 *
 * ## Rotation is driven, not merely animated
 *
 * There is a slow idle spin so the page is never static, and on top of it a
 * heading and a bank angle that the page drives from scroll position. Both are
 * eased towards rather than set, so scrolling turns the aeroplane the way a
 * control input would rather than cutting between poses.
 */

import {
  AmbientLight,
  DirectionalLight,
  Group,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type Material,
} from 'three';

import { buildAircraftModel, disposeAircraftModel, type AircraftModel } from '@/render/aircraft';
import { createVapour, wingtipsOf } from './vapour';
import { loadModelFor } from '@/render/aircraft/library';
import { HERO } from '@/ui/palette';

/**
 * Light turbulence, instead of an idle spin.
 *
 * A constant rotation was tried first and is the wrong idea: it makes the
 * aeroplane a display model on a turntable, and the one thing this page is
 * selling is that these aircraft are flying. What an aeroplane actually does
 * when it is holding a heading is move *slightly*, all the time, on all three
 * axes, and never repeat.
 *
 * Each axis is the sum of two sine waves whose periods share no common factor,
 * so the pattern does not visibly loop — with commensurate periods the eye
 * finds the cycle within about half a minute and it goes back to looking
 * mechanical. Amplitudes are degrees: small enough to read as air rather than
 * as an aeroplane in trouble.
 */
const TURBULENCE = {
  roll: [
    { amplitudeDeg: 3.4, periodSec: 7.3 },
    { amplitudeDeg: 1.1, periodSec: 2.9 },
  ],
  pitch: [
    { amplitudeDeg: 1.7, periodSec: 11.1 },
    { amplitudeDeg: 0.6, periodSec: 3.7 },
  ],
  yaw: [
    { amplitudeDeg: 2.1, periodSec: 13.9 },
    { amplitudeDeg: 0.8, periodSec: 4.3 },
  ],
} as const;


/** Sum of a turbulence axis at time `t`, in degrees. */
function wobble(axis: readonly { amplitudeDeg: number; periodSec: number }[], t: number): number {
  let sum = 0;
  for (const wave of axis) sum += wave.amplitudeDeg * Math.sin((2 * Math.PI * t) / wave.periodSec);
  return sum;
}

/** Nose held above the horizon, degrees, so it reads as flying rather than parked. */
const PITCH_DEG = 5;

/**
 * Camera placement: how far above, and how far round from dead astern.
 *
 * A near-level view from behind was tried first and reads as a smudge — the
 * wings are edge-on and the fuselage is a circle. A three-quarter from above
 * shows the planform and the fin at once, which is the angle every aircraft
 * photograph is taken from, for this reason.
 */
const CAMERA_ELEVATION_DEG = 20;
const CAMERA_AZIMUTH_DEG = 32;
const CAMERA_RANGE = 1.9;

/**
 * How quickly the aeroplane settles onto a new attitude, seconds.
 *
 * The placement changes the instant a new section becomes current, so without
 * easing the model snaps between poses while the CSS slides it across the
 * page — the two halves of the same movement, disagreeing. Long enough to read
 * as a manoeuvre, short enough to finish inside the CSS transition.
 */
const ATTITUDE_TAU = 0.9;

/** Peak bank, degrees, at the steepest part of a scroll. */
const MAX_BANK_DEG = 22;

/**
 * Pixel ratio ceiling.
 *
 * This is decoration on a page whose job is to load fast, and on a 3x phone the
 * difference between 2 and 3 is invisible at this size and costs 2.25x the
 * fragments. The main renderer measures and adapts; this one does not need to.
 */
const MAX_PIXEL_RATIO = 2;

export interface HeroScene {
  /**
   * Where the page wants the aeroplane pointed.
   *
   * @param turns Heading, in turns, added to the idle spin.
   * @param bank  Bank angle as a fraction of `MAX_BANK_DEG`, -1 to 1.
   */
  steer(turns: number, bank: number): void;
  /** Light or dark. Changes how the vapour is blended — see `VAPOUR_STYLE`. */
  setTheme(theme: 'dark' | 'light'): void;
  resize(): void;
  dispose(): void;
}

/**
 * Mount the hero.
 *
 * Returns null when WebGL is unavailable, which the caller renders as a note
 * rather than a hole. The front page must survive a browser that cannot run
 * the product: telling someone the app needs WebGL2 is useful, and a blank
 * rectangle where the aeroplane should be is not.
 */
export function mountHeroScene(
  canvas: HTMLCanvasElement,
  typeCode: string,
  theme: 'dark' | 'light',
): HeroScene | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    return null;
  }

  renderer.setClearAlpha(0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(32, 1, 0.1, 100);

  // Three nested frames, so the three motions cannot interfere. `heading` is
  // the scroll-driven turn about the world vertical; `attitude` is the pose
  // that turn implies; `air` is the turbulence, applied last and in the
  // aircraft's own axes, which is where it physically belongs.
  const air = new Group();
  const attitude = new Group();
  const heading = new Group();
  attitude.add(air);
  heading.add(attitude);
  scene.add(heading);



  const ownedMaterials: Material[] = [];
  let procedural: AircraftModel | null = null;

  function clearYaw(): void {
    air.clear();
  }

  function showProcedural(): AircraftModel {
    const hull = new MeshLambertMaterial({ color: HERO.hull });
    const trim = new MeshLambertMaterial({ color: HERO.trim, emissive: HERO.trim });
    ownedMaterials.push(hull, trim);

    const model = buildAircraftModel(typeCode, null, 'high');
    air.add(new Mesh(model.hull, hull));
    if (model.trim) air.add(new Mesh(model.trim, trim));
    return model;
  }

  procedural = showProcedural();

  /*
   * The real airframe, when it arrives.
   *
   * Not awaited and not required. If the catalogue has no entry, the download
   * fails, or the visitor leaves first, the procedural model is already on
   * screen and simply stays — which is the same arrangement `OwnAircraft` uses,
   * for the same reason.
   */
  let disposed = false;
  void loadModelFor(typeCode, null).then((loaded) => {
    if (disposed || loaded === null) return;
    clearYaw();
    if (procedural) {
      disposeAircraftModel(procedural);
      procedural = null;
    }
    for (const part of loaded.parts) {
      // Gear up. The converted models carry the undercarriage in its extended
      // position, because that is how the source model is authored, and an
      // airliner at cruise with its wheels down is the first thing anyone who
      // likes aeroplanes notices. Nothing else here moves, so every remaining
      // part is drawn as one rigid body.
      if (part.role === 'gear') continue;
      const mesh = new Mesh(part.geometry, part.material);
      mesh.position.set(part.origin[0], part.origin[1], part.origin[2]);
      air.add(mesh);
    }

    // Re-measure: the converted airframe's wings are not where the procedural
    // one's were, and the trails have to follow the model that is on screen.
    const tips = wingtipsOf(
      loaded.parts.filter((part) => part.role !== 'gear').map((part) => part.geometry),
    );
    if (tips) vapour.attachTo(tips);
  });

  /*
   * Lit for contrast, not for realism.
   *
   * Two failures either side of this. Too dim and the aeroplane is a
   * silhouette against a page that is nearly the same value; too bright and
   * every surface clips to white and it reads as a paper cut-out, which is what
   * an ambient of 2.2 produced. The ambient is low enough to leave the shadow
   * side dark, and the key does the work.
   */
  scene.add(new AmbientLight(0xffffff, 0.9));
  const key = new DirectionalLight(0xfff6e8, 2.4);
  key.position.set(-1.4, 1.1, 1.9);
  scene.add(key);
  // Cool rim from below and behind. It separates the underside from the page,
  // which ambient cannot do because the page is the same value as the shadow.
  const rim = new DirectionalLight(HERO.glow, 1.7);
  rim.position.set(1.8, -1.0, -1.3);
  scene.add(rim);

  const vapour = createVapour(camera, attitude, theme);

  const elevation = (CAMERA_ELEVATION_DEG * Math.PI) / 180;
  const azimuth = (CAMERA_AZIMUTH_DEG * Math.PI) / 180;
  const ground = CAMERA_RANGE * Math.cos(elevation);
  camera.position.set(
    ground * Math.sin(azimuth),
    -ground * Math.cos(azimuth),
    CAMERA_RANGE * Math.sin(elevation),
  );
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);

  function resize(): void {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  let targetTurns = 0;
  let targetBank = 0;
  let turns = 0;
  let bank = 0;

  let last = performance.now();
  let elapsed = 0;
  let frame = 0;
  let running = true;

  function tick(now: number): void {
    if (!running) return;
    frame = requestAnimationFrame(tick);

    // Wall clock, clamped: a backgrounded tab hands back a delta of many
    // seconds, which would snap the model through a random number of turns.
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    elapsed += dt;

    const k = 1 - Math.exp(-dt / ATTITUDE_TAU);
    turns += (targetTurns - turns) * k;
    bank += (targetBank - bank) * k;

    heading.rotation.z = turns * Math.PI * 2;
    attitude.rotation.x = (PITCH_DEG * Math.PI) / 180;
    attitude.rotation.y = (bank * MAX_BANK_DEG * Math.PI) / 180;

    air.rotation.x = (wobble(TURBULENCE.pitch, elapsed) * Math.PI) / 180;
    air.rotation.y = (wobble(TURBULENCE.roll, elapsed) * Math.PI) / 180;
    air.rotation.z = (wobble(TURBULENCE.yaw, elapsed) * Math.PI) / 180;

    vapour.update(elapsed);

    renderer.render(scene, camera);
  }

  resize();
  frame = requestAnimationFrame(tick);

  return {
    steer(nextTurns: number, nextBank: number): void {
      targetTurns = nextTurns;
      targetBank = Math.max(-1, Math.min(1, nextBank));
    },
    setTheme: vapour.setTheme,
    resize,
    dispose(): void {
      disposed = true;
      running = false;
      cancelAnimationFrame(frame);
      if (procedural) disposeAircraftModel(procedural);
      vapour.dispose();
      for (const material of ownedMaterials) material.dispose();
      // The library's geometries and materials are cached and shared with the
      // app, which will want them when the visitor steps into a 787. Disposing
      // them here would be disposing someone else's.
      renderer.dispose();
    },
  };
}
