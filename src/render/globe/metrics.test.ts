/**
 * The quadtree's arithmetic.
 *
 * These five functions decide what gets drawn and in what order, and every one
 * of them has a plausible wrong version: an obliquity term without a floor
 * freezes the horizon at zoom 2, a horizon test with the wrong sign downloads
 * the far side of the planet, a Terrarium sub-rectangle computed from the
 * wrong ancestor puts Switzerland's elevation under Kent.
 *
 * They were unreachable from a test until they were lifted out of `Globe`,
 * which needs a WebGL context and a worker pool to construct.
 */

import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, PerspectiveCamera, Sphere } from 'three';

import { geodeticToEcef, lonToMercatorX, latToMercatorY, type Vec3 } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import {
  DESCENT_PRIORITY,
  MIN_OBLIQUITY,
  PREFETCH_PRIORITY,
  REFINE_TEXELS,
} from './constants';
import { profileFor } from '@/net/quality';
import { distanceTo, elevationRequest, isTileVisible, priorityOf, screenSpaceError } from './metrics';
import { TileNode } from './tileNode';

/** The globe always runs with the origin at, or near, the camera. */
const originAt = (ecef: Vec3): FloatingOrigin =>
  ({ current: ecef }) as unknown as FloatingOrigin;

/** A camera looking straight down at `lat`/`lon` from `heightM`. */
function overheadCamera(lat: number, lon: number, heightM: number): {
  camEcef: Vec3;
  frustum: Frustum;
  origin: FloatingOrigin;
} {
  const camEcef = geodeticToEcef(lat, lon, heightM);
  const target = geodeticToEcef(lat, lon, 0);
  const origin = originAt(camEcef);

  const camera = new PerspectiveCamera(60, 1, 0.5, 500_000);
  camera.up.set(0, 0, 1);
  camera.position.set(0, 0, 0); // camera sits at the floating origin
  camera.lookAt(target[0] - camEcef[0], target[1] - camEcef[1], target[2] - camEcef[2]);
  camera.updateMatrixWorld();

  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  return { camEcef, frustum, origin };
}

describe('distanceTo', () => {
  it('measures to the tile surface, not its centre', () => {
    const node = new TileNode(2, 2, 1, null);
    const cam = geodeticToEcef(0, 0, 10_000_000);
    // Subtracting the bounding radius is what stops a tile's own size making
    // it look further away than it is — at low zoom the radius is thousands
    // of kilometres.
    expect(distanceTo(node, cam)).toBeLessThan(
      Math.hypot(cam[0] - node.centerEcef[0], cam[1] - node.centerEcef[1], cam[2] - node.centerEcef[2]),
    );
  });

  it('never returns zero, even inside the bounding sphere', () => {
    const node = new TileNode(2, 2, 1, null);
    // Screen-space error divides by this. A camera inside a low-zoom tile's
    // bounding sphere — which is every cockpit view — would otherwise produce
    // an infinite error and refine the whole planet.
    expect(distanceTo(node, node.centerEcef)).toBeGreaterThan(0);
  });
});

describe('screenSpaceError', () => {
  it('falls as the camera moves away', () => {
    const node = new TileNode(10, 511, 340, null);
    const near = geodeticToEcef(51.5, -0.45, 3000);
    const far = geodeticToEcef(51.5, -0.45, 300_000);
    expect(screenSpaceError(node, near, 900, 32)).toBeGreaterThan(
      screenSpaceError(node, far, 900, 32),
    );
  });

  it('discounts terrain seen edge-on', () => {
    // Two tiles at the same range: one below the camera, one out towards the
    // horizon. From a cockpit at cruise the second is foreshortened into a
    // band of pixels a thumbnail could cover, and charging it full detail is
    // most of the bill.
    const camLat = 51.5;
    const cam = geodeticToEcef(camLat, 0, 12_000);

    const below = new TileNode(12, tileX(0, 12), tileY(camLat, 12), null);
    const ahead = new TileNode(12, tileX(0, 12), tileY(camLat + 1.4, 12), null);

    const errBelow = screenSpaceError(below, cam, 900, 32);
    const errAhead = screenSpaceError(ahead, cam, 900, 32);
    expect(errAhead).toBeLessThan(errBelow);
  });

  it('never discounts a grazing tile to nothing', () => {
    // A factor that reaches zero would freeze the horizon at the root zoom
    // for ever, because no tile out there could ever exceed the error target.
    const node = new TileNode(6, 32, 21, null);
    const cam = geodeticToEcef(0, 0, 11_000);
    const error = screenSpaceError(node, cam, 900, 32);
    expect(error).toBeGreaterThan(0);
    expect(MIN_OBLIQUITY).toBeGreaterThan(0);
  });

  it('scales with the viewport, so a taller window gets more detail', () => {
    const node = new TileNode(10, 511, 340, null);
    const cam = geodeticToEcef(51.5, -0.45, 8000);
    expect(screenSpaceError(node, cam, 1800, 32)).toBeCloseTo(
      2 * screenSpaceError(node, cam, 900, 32),
      6,
    );
  });

  it('falls as the mesh gets denser', () => {
    const node = new TileNode(10, 511, 340, null);
    const cam = geodeticToEcef(51.5, -0.45, 8000);
    // Geometric error is one grid cell of the tile's span, so doubling the
    // grid halves the error.
    expect(screenSpaceError(node, cam, 900, 64)).toBeCloseTo(
      screenSpaceError(node, cam, 900, 32) / 2,
      6,
    );
  });
});

describe('isTileVisible', () => {
  it('accepts the tile directly under the camera', () => {
    const { camEcef, frustum, origin } = overheadCamera(51.5, -0.45, 20_000);
    const node = new TileNode(8, tileX(-0.45, 8), tileY(51.5, 8), null);
    expect(isTileVisible(node, camEcef, frustum, origin, new Sphere())).toBe(true);
  });

  it('rejects the far side of the planet', () => {
    // Inside the frustum by sheer size, and completely occluded by the Earth.
    // Without the horizon test the whole back hemisphere gets selected,
    // refined and downloaded — a very expensive invisible mistake.
    const { camEcef, origin } = overheadCamera(51.5, -0.45, 20_000);
    const everything = new Frustum().setFromProjectionMatrix(new Matrix4());
    const antipode = new TileNode(4, tileX(179.55, 4), tileY(-51.5, 4), null);
    expect(isTileVisible(antipode, camEcef, everything, origin, new Sphere())).toBe(false);
  });
});

describe('elevationRequest', () => {
  it('asks for the tile itself up to Terrarium\'s maximum zoom', () => {
    const node = new TileNode(15, 16_370, 10_896, null);
    const req = elevationRequest(node);
    expect(req).toMatchObject({ z: 15, x: 16_370, y: 10_896 });
    expect(req.rect).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
  });

  it('reuses the z15 ancestor for deeper tiles, with the right sub-rectangle', () => {
    // Terrarium serves nothing past z15, so a z17 tile samples the quarter of
    // a quarter of its z15 ancestor that it actually covers. Getting this
    // rectangle wrong puts the wrong mountain under the aircraft.
    const z17 = new TileNode(17, 16_370 * 4 + 3, 10_896 * 4 + 1, null);
    const req = elevationRequest(z17);

    expect(req.z).toBe(15);
    expect(req.x).toBe(16_370);
    expect(req.y).toBe(10_896);
    expect(req.rect.x0).toBeCloseTo(3 / 4, 9);
    expect(req.rect.x1).toBeCloseTo(4 / 4, 9);
    expect(req.rect.y0).toBeCloseTo(1 / 4, 9);
    expect(req.rect.y1).toBeCloseTo(2 / 4, 9);
  });

  it('gives the four children of a z15 tile four disjoint quarters', () => {
    const seen = new Set<string>();
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const child = new TileNode(16, 16_370 * 2 + dx, 10_896 * 2 + dy, null);
        const { rect } = elevationRequest(child);
        seen.add(`${rect.x0},${rect.y0}`);
        expect(rect.x1 - rect.x0).toBeCloseTo(0.5, 9);
        expect(rect.y1 - rect.y0).toBeCloseTo(0.5, 9);
      }
    }
    expect(seen.size).toBe(4);
  });
});

describe('priorityOf', () => {
  /** The tile at `z` containing a point, scored against a real camera. */
  function scored(
    z: number,
    lat: number,
    lon: number,
    camEcef: Vec3,
    frame: number,
    onScreen = true,
  ): TileNode {
    const n = 1 << z;
    const node = new TileNode(
      z,
      Math.floor(lonToMercatorX(lon) * n),
      Math.floor(latToMercatorY(lat) * n),
      null,
    );
    // 900 px tall viewport at 50 degrees vertical, the app's own framing.
    const sseScale = 900 / (2 * Math.tan((50 * Math.PI) / 180 / 2));
    node.screenError = screenSpaceError(node, camEcef, sseScale, REFINE_TEXELS);
    if (onScreen) node.onScreenFrame = frame;
    return node;
  }

  it('still funds breadth before depth in the column under the camera', () => {
    // The property the old `z * 1000` ordering existed to guarantee, now
    // arising from the error instead of being decreed: a coarse tile covering
    // nearby ground looks far worse than the fine one inside it, because its
    // texels are metres wide a few hundred metres from the eye.
    const camEcef = geodeticToEcef(51.47, -0.45, 300);
    const shallow = scored(10, 51.47, -0.45, camEcef, 1);
    const deep = scored(16, 51.47, -0.45, camEcef, 1);

    expect(shallow.screenError).toBeGreaterThan(deep.screenError);
    expect(priorityOf(shallow, 1)).toBeLessThan(priorityOf(deep, 1));
  });

  it('puts the deep tile underfoot ahead of the shallow one at the horizon', () => {
    // The inversion this replaced. Ranked by zoom, a z12 tile 150 km away
    // scored 12 000 and the z18 tile under the aircraft scored 18 000, so the
    // whole breadth of the distant view was served first — at every level, for
    // as long as the horizon kept producing work, which it always does.
    const camEcef = geodeticToEcef(51.47, -0.45, 300);
    const near = scored(18, 51.47, -0.45, camEcef, 1);
    const horizon = scored(12, 52.8, -0.45, camEcef, 1);

    expect(priorityOf(near, 1)).toBeLessThan(priorityOf(horizon, 1));
  });

  it('prefers a tile wanted this frame over one merely queued', () => {
    const camEcef = geodeticToEcef(51.47, -0.45, 300);
    const live = scored(14, 51.47, -0.45, camEcef, 42);
    const stale = scored(14, 51.47, -0.45, camEcef, 42, false);

    expect(priorityOf(live, 42)).toBeLessThan(priorityOf(stale, 42));
  });

  it('ranks every off-screen tile behind every on-screen one', () => {
    // The bands must not overlap. A tile the camera turned away from is not
    // urgent however wrong it looks — but an almost-perfect tile still on
    // screen is still worth more than the best off-screen one.
    const camEcef = geodeticToEcef(51.47, -0.45, 300);
    const worstOffScreen = scored(2, 51.47, -0.45, camEcef, 5, false);
    const bestOnScreen = scored(19, 51.47, -0.45, camEcef, 5);

    expect(priorityOf(bestOnScreen, 5)).toBeLessThan(priorityOf(worstOffScreen, 5));
  });

  it('leaves the speculative bands clear', () => {
    // `prefetchDescent` and `prefetchAlongPath` rank themselves at fixed
    // numbers chosen to sit behind anything the quadtree actually wants. If a
    // live tile could reach them, a guess about airspace a minute ahead would
    // be served before the ground being looked at — which is the bug
    // PREFETCH_PRIORITY was introduced to fix, and it would come straight back.
    const camEcef = geodeticToEcef(51.47, -0.45, 300);
    const worst = scored(2, 51.47, -0.45, camEcef, 3, false);

    expect(priorityOf(worst, 3)).toBeLessThan(DESCENT_PRIORITY);
    expect(DESCENT_PRIORITY).toBeLessThan(PREFETCH_PRIORITY);
  });
});

// --- helpers ---------------------------------------------------------------

function tileX(lonDeg: number, z: number): number {
  return Math.floor(((lonDeg + 180) / 360) * (1 << z));
}

function tileY(latDeg: number, z: number): number {
  const rad = (latDeg * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return Math.floor(y * (1 << z));
}

/**
 * The refinement depth a cockpit at cruise actually asks for.
 *
 * `selectTiles` refines while the error exceeds the target, so the level it
 * settles on is the first whose error fits. Reproduced here directly against
 * the metric rather than through `Globe`, which needs WebGL and a worker pool.
 */
function settlingZoom(
  lat: number,
  lon: number,
  heightM: number,
  sseScale: number,
  target: number,
  resolution: number,
): number {
  const cam = geodeticToEcef(lat, lon, heightM);
  const mx = lonToMercatorX(lon);
  const my = latToMercatorY(lat);
  for (let z = 2; z < 22; z++) {
    const n = 1 << z;
    const node = new TileNode(z, Math.floor(mx * n), Math.floor(my * n), null);
    if (screenSpaceError(node, cam, sseScale, resolution) <= target) return z;
  }
  return 22;
}

describe('refinement depth at cruise', () => {
  // A 900 px viewport at the app's 50 degree vertical field of view.
  const SSE_SCALE = 900 / (2 * Math.tan((50 * Math.PI) / 180 / 2));

  it('measures distance to the tile, not to the top of a hypothetical Everest', () => {
    // `boundingRadius` carries the planet's whole terrain envelope so culling
    // never clips a mountain: about 9.5 km. Subtracting that from an 11 km
    // cruise altitude — which is what `distanceTo` used to do — reported
    // every tile below the aircraft as 2 km away, and screen-space error is
    // inversely proportional to distance.
    const n = 1 << 14;
    const node = new TileNode(
      14,
      Math.floor(lonToMercatorX(2.35) * n),
      Math.floor(latToMercatorY(48.85) * n),
      null,
    );
    const cam = geodeticToEcef(48.85, 2.35, 11_000);

    expect(node.boundingRadius).toBeGreaterThan(8000);
    expect(node.lodRadius).toBeLessThan(2000);

    const d = distanceTo(node, cam);
    expect(d).toBeGreaterThan(9000);
    // The old reading, for scale.
    expect(Math.hypot(...cam.map((c, i) => c - node.centerEcef[i])) - node.boundingRadius)
      .toBeLessThan(3000);
  });

  it('stops where the imagery reaches native resolution, not past it', () => {
    const z = settlingZoom(48.85, 2.35, 11_000, SSE_SCALE, 1, REFINE_TEXELS);

    // A z14 tile over Paris is ~1.6 km across and subtends ~160 px from
    // 11 km, so its 256 texels are already about 0.6 px each. Refining
    // further is invisible and costs four times the tiles per level.
    expect(z).toBeGreaterThanOrEqual(13);
    expect(z).toBeLessThanOrEqual(15);
  });

  it('would chase invisible levels if measured against the mesh grid', () => {
    // The regression this guards. Measuring the error against the 32-quad
    // terrain mesh instead of the 256 texels — the old tuning, 2.2 px against
    // `baseResolution` — put the settling depth two levels deeper, which is
    // sixteen times the tiles for a picture the screen renders identically.
    const mesh = settlingZoom(48.85, 2.35, 11_000, SSE_SCALE, 2.2, 32);
    const texels = settlingZoom(48.85, 2.35, 11_000, SSE_SCALE, 1, REFINE_TEXELS);

    expect(mesh).toBeGreaterThanOrEqual(texels + 2);
    // Four children per level, so the tile count is 4^levels.
    expect(4 ** (mesh - texels)).toBeGreaterThanOrEqual(16);
  });

  it('settles within reach of the link on the shipped profiles', () => {
    // The numbers that actually ship, not hand-picked ones. Each level is
    // four times the tiles, so a target that settles two levels deeper than
    // this is one the connection cannot finish before the aircraft has flown
    // off the tiles it asked for.
    for (const grade of ['fast', 'good', 'slow'] as const) {
      const profile = profileFor(grade);
      const z = settlingZoom(
        48.85,
        2.35,
        11_000,
        SSE_SCALE,
        profile.screenSpaceError,
        REFINE_TEXELS,
      );
      expect(z, grade).toBeLessThanOrEqual(15);
      expect(z, grade).toBeGreaterThanOrEqual(12);
      expect(z, grade).toBeLessThanOrEqual(profile.maxZoom);
    }
  });

  it('still refines to full detail from close range', () => {
    // Taxiing. The same target must not cap detail when the camera is metres
    // from the ground rather than kilometres above it.
    const z = settlingZoom(48.85, 2.35, 30, SSE_SCALE, 1, REFINE_TEXELS);
    expect(z).toBeGreaterThanOrEqual(19);
  });
});
