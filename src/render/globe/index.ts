/**
 * Quadtree globe.
 *
 * ## The rules that remove the loading feeling
 *
 * 1. **A tile is never blank.** Until its own imagery arrives it samples the
 *    nearest loaded ancestor's texture through a UV transform, so it shows the
 *    right place at lower detail rather than a hole or a placeholder colour.
 * 2. **Detail sharpens, it does not snap.** When a tile's own imagery lands,
 *    the shader cross-fades from inherited to own over a few hundred ms.
 * 3. **A parent is only replaced once all four children are built.** Refining
 *    into a partially loaded quad is what produces the classic flickering
 *    checkerboard. Waiting costs a moment of blur and buys continuity.
 * 4. **The parent stays drawn underneath while children fade in**, so there is
 *    no frame in which the globe is see-through — at cold start only. Once any
 *    ancestor has a texture, a new child is drawn opaque immediately and shows
 *    that texture through `uvA`. Two coplanar meshes cross-fading is not
 *    continuity: they are built from different heightmap levels and z-fight.
 * 5. **Requests are re-ranked every frame** against where the camera is now,
 *    by how wrong each tile currently looks. A priority fixed when the tile was
 *    first wanted is, under a moving aircraft, an ordering for a view that no
 *    longer exists — see `priorityOf`.
 * 6. **Visible tiles are never evicted**, whatever the memory pressure.
 * 7. **The camera's own path is prefetched** ahead of the aircraft, so tiles
 *    are already resident by the time they matter.
 * 8. **Detail follows the connection.** `applyProfile` lowers the zoom ceiling
 *    and relaxes the error target on a weak link, because a complete coarse
 *    picture beats an incomplete sharp one — see `@/net/quality`.
 *
 * ## Structure
 *
 * Roots are the sixteen zoom-2 tiles. Web Mercator stops at +/-85.05 degrees
 * and so does the globe: every XYZ source in this project is Mercator, so
 * beyond that latitude there is nothing to draw. Nothing this app follows
 * flies there, and inventing a polar cap would mean inventing its texture too.
 *
 * ## Where the rest of it lives
 *
 * `constants.ts` holds every tuning number, `tileNode.ts` the per-tile state,
 * `metrics.ts` the pure geometry (visibility, screen-space error, priority).
 * What is left here is the part that is genuinely stateful: selection,
 * loading, scene synchronisation and eviction.
 */

import {
  Color,
  Frustum,
  Matrix4,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
} from 'three';

import {
  DEG2RAD,
  ecefToGeodetic,
  latToMercatorY,
  lonToMercatorX,
  tileKey,
  type Vec3,
} from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import type { StreamingProfile } from '@/net/quality';
import { DEFAULT_IMAGERY, type ImagerySource } from '@/tiles/sources';
import {
  DESCENT_TRIGGER_M,
  REFINE_TEXELS,
  RELIEF,
  ROOT_ZOOM,
  type GlobeOptions,
  type ReliefDetail,
} from './constants';
import { evictDistantTiles, type TileMap } from './eviction';
import { SceneSynchroniser } from './sceneSync';
import { selectTiles, type SelectionContext } from './selection';
import { TileStreamer, type LoadFrontier } from './streaming';
import { aimPoint, prefetchAlongPath, prefetchDescent, sampleTerrainHeight } from './terrainQuery';
import { TileNode } from './tileNode';

export type { GlobeOptions, ReliefDetail } from './constants';

export interface GlobeStats {
  residentTiles: number;
  renderedTiles: number;
  loadingTiles: number;
  queuedRequests: number;
  inFlightRequests: number;
  triangles: number;
  deepestZoom: number;
}

export class Globe {
  readonly scene = new Scene();

  private readonly nodes: TileMap = new Map<string, TileNode>();
  private readonly roots: TileNode[] = [];

  /** Owns the loader, the workers, and every tile's load state machine. */
  private readonly streamer: TileStreamer;
  /** Owns the Three.js side: meshes, materials, fades. */
  private readonly sync: SceneSynchroniser;
  private relief: ReliefDetail = 'standard';

  private imagery: ImagerySource = DEFAULT_IMAGERY;
  private options: Required<GlobeOptions>;
  /**
   * Ceiling the caller asked for, kept separate from the live value.
   *
   * The connection profile lowers `options.maxZoom` on a weak link and raises
   * it again on recovery — but only ever back to what the caller originally
   * permitted. Without this the two limits would fight: every recovery would
   * push the zoom one notch past the app's own ceiling.
   */
  private readonly requestedMaxZoom: number;
  private readonly requestedSse: number;
  /** Largest anisotropic sample count the renderer supports. */
  private maxAnisotropy = 8;

  private frame = 0;
  /** Ground tile last seeded by `prefetchDescent`, so it runs on change only. */
  private descentKey: string | null = null;
  /** Camera forward direction, reused each frame. */
  private readonly forward = new Vector3();
  private readonly frustum = new Frustum();
  private readonly viewProjection = new Matrix4();
  private readonly sphere = new Sphere();

  private readonly renderSet: TileNode[] = [];
  /** Refinement candidates gathered this frame, spent by the streamer. */
  private readonly loadFrontier: LoadFrontier = [];

  private stats: GlobeStats = {
    residentTiles: 0,
    renderedTiles: 0,
    loadingTiles: 0,
    queuedRequests: 0,
    inFlightRequests: 0,
    triangles: 0,
    deepestZoom: 0,
  };

  constructor(
    private readonly origin: FloatingOrigin,
    options: GlobeOptions = {},
  ) {
    // `maxScreenSpaceError` is now screen pixels per imagery texel, so 1 is
    // "refine until the texture is at native resolution and not one level
    // further". Below 1 buys detail the display cannot show, at four times
    // the tiles per level — see `REFINE_TEXELS`.
    this.options = {
      maxScreenSpaceError: options.maxScreenSpaceError ?? 1,
      maxZoom: options.maxZoom ?? 18,
      baseResolution: options.baseResolution ?? 32,
      nearResolution: options.nearResolution ?? 64,
      exaggeration: options.exaggeration ?? 1,
      maxResidentTiles: options.maxResidentTiles ?? 6000,
    };
    this.requestedMaxZoom = this.options.maxZoom;
    this.requestedSse = this.options.maxScreenSpaceError;

    this.streamer = new TileStreamer(this.imagery, this.options);
    this.sync = new SceneSynchroniser(this.scene, this.nodes, this.renderSet, this.origin);

    this.scene.matrixAutoUpdate = false;

    const n = 1 << ROOT_ZOOM;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const node = new TileNode(ROOT_ZOOM, x, y, null);
        this.nodes.set(node.key, node);
        this.roots.push(node);
      }
    }

    this.origin.addListener({
      onOriginChanged: () => this.sync.repositionAll(),
    });
  }

  getStats(): Readonly<GlobeStats> {
    return this.stats;
  }

  get imagerySource(): ImagerySource {
    return this.imagery;
  }

  /**
   * Geometry is untouched — only the textures are dropped, so the globe
   * re-skins without a moment of missing terrain.
   */
  setImagery(source: ImagerySource): void {
    if (source.id === this.imagery.id) return;
    this.imagery = source;
    this.streamer.setImagery(source);

    for (const node of this.nodes.values()) {
      // Supersede any load in flight for the old layer, and clear the retry
      // bookkeeping — a tile the previous provider had given up on deserves a
      // clean start with the new one.
      this.streamer.cancelTexture(node);
      node.texture?.dispose();
      node.texture = null;
      node.textureState = 'idle';
      node.textureAttempts = 0;
      node.textureRetryFrame = 0;
      node.textureBlend = 0;
      this.streamer.settle(node);
    }
    this.streamer.flushQueue();
  }

  /**
   * See `RELIEF`. Every resident tile is rebuilt, because mesh density and
   * vertical exaggeration are baked into the geometry the worker produced —
   * letting the quadtree replace tiles on its own would leave the world half in
   * one relief and half in the other, with a visible step where they met.
   * Textures are kept: nothing about them changed.
   */
  setRelief(detail: ReliefDetail): void {
    if (this.relief === detail) return;
    this.relief = detail;

    const settings = RELIEF[detail];
    this.options = {
      ...this.options,
      baseResolution: settings.baseResolution,
      nearResolution: settings.nearResolution,
      exaggeration: settings.exaggeration,
    };
    this.streamer.setOptions(this.options);
    this.sync.setAmbient(settings.ambient);

    for (const node of this.nodes.values()) {
      this.streamer.cancelGeometry(node);
      if (node.mesh) {
        this.scene.remove(node.mesh);
        node.mesh = null;
        node.attached = false;
      }
      node.geometry?.dispose();
      node.geometry = null;
      /*
       * The heights stay. `sampleHeight` reads them, and it decides where an
       * aircraft on the ground sits and how far the camera is lifted to clear
       * a hillside. Clearing them alongside the mesh makes every tile answer
       * "sea level" until its replacement lands — toggling the setting over
       * the Alps dropped the camera two kilometres into the mountain. One
       * rebuild out of date is invisible; zero is not.
       */
      node.geometryState = 'idle';
      node.geometryAttempts = 0;
      node.geometryRetryFrame = 0;
      this.streamer.settle(node);
    }
    this.streamer.flushQueue();
  }

  get reliefDetail(): ReliefDetail {
    return this.relief;
  }

  applyProfile(profile: StreamingProfile): void {
    this.options = {
      ...this.options,
      maxZoom: Math.min(this.requestedMaxZoom, profile.maxZoom),
      maxScreenSpaceError: Math.max(this.requestedSse, profile.screenSpaceError),
    };
    this.streamer.setOptions(this.options);
    this.streamer.retune();
  }

  /** Current detail settings, for the diagnostics panel. */
  get quality(): { maxZoom: number; screenSpaceError: number } {
    return {
      maxZoom: this.effectiveMaxZoom(),
      screenSpaceError: this.options.maxScreenSpaceError,
    };
  }

  /**
   * Terrain is viewed at grazing angles almost all of the time — that is what
   * a cockpit view *is* — and that is exactly where trilinear filtering
   * collapses the ground into a smeared band a few hundred metres ahead.
   * Anisotropic filtering is the cheapest improvement available to the
   * ground's appearance, and the renderer's own maximum is the right value
   * because the cost is per-texel, not per-frame.
   */
  setAnisotropy(max: number): void {
    this.maxAnisotropy = Math.max(1, Math.floor(max));
    this.streamer.setAnisotropy(this.maxAnisotropy);
    for (const node of this.nodes.values()) {
      if (!node.texture) continue;
      node.texture.anisotropy = this.maxAnisotropy;
      node.texture.needsUpdate = true;
    }
  }

  setSun(direction: Vector3): void {
    this.sync.setSun(direction);
  }

  setAtmosphere(color: Color, density: number): void {
    this.sync.setAtmosphere(color, density);
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(camera: PerspectiveCamera, dt: number, viewportHeight: number): void {
    this.frame++;

    camera.updateMatrixWorld();
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection);

    // Camera position in ECEF; the render frame is ECEF minus the origin.
    const camEcef: Vec3 = [
      camera.position.x + this.origin.current[0],
      camera.position.y + this.origin.current[1],
      camera.position.z + this.origin.current[2],
    ];

    // Screen-space error scale: pixels per metre of geometric error at 1 m.
    const fovRad = camera.fov * DEG2RAD;
    const sseScale = viewportHeight / (2 * Math.tan(fovRad / 2));

    this.renderSet.length = 0;
    this.loadFrontier.length = 0;
    this.streamer.beginFrame(this.frame);

    const selection: SelectionContext = {
      nodes: this.nodes,
      streamer: this.streamer,
      frustum: this.frustum,
      origin: this.origin,
      scratchSphere: this.sphere,
      frame: this.frame,
      maxZoom: this.effectiveMaxZoom(),
      maxScreenSpaceError: this.options.maxScreenSpaceError,
      refineResolution: REFINE_TEXELS,
      renderSet: this.renderSet,
      frontier: this.loadFrontier,
    };
    for (const root of this.roots) {
      selectTiles(root, camEcef, sseScale, selection);
    }

    // Order matters and is not arbitrary. Selection has to finish before the
    // frontier is spent, or the budget goes to whichever quad happened to be
    // visited first rather than to the worst one on screen; and eviction has
    // to run after the render set exists, or it cannot know what is protected.
    this.streamer.flush(this.loadFrontier);
    // After `flush`, so tiles that just entered the frontier are included, and
    // before `abandonStale`, which is about withdrawal rather than ordering.
    this.streamer.reprioritise();
    this.streamer.abandonStale();

    const drawn = this.sync.applyRenderSet(dt);
    this.stats.renderedTiles = drawn.rendered;
    this.stats.triangles = drawn.triangles;
    this.stats.deepestZoom = drawn.deepestZoom;

    // The scene carries no rotation (the floating origin is a pure
    // translation), so the camera's world-space forward vector is already an
    // ECEF direction and needs no transform.
    camera.getWorldDirection(this.forward);
    this.maybeSeedDescent(camEcef, this.forward, drawn.deepestZoom);

    evictDistantTiles({
      nodes: this.nodes,
      renderSet: this.renderSet,
      camEcef,
      maxResidentTiles: this.options.maxResidentTiles,
      onEvict: (node) => this.releaseNode(node),
    });
    this.updateStats();
  }

  /**
   * Three owners have to be told, which is why eviction takes a callback rather
   * than reaching into them: the scene holds the mesh, the streamer holds the
   * loader requests and the place in the frontier, and the node holds GPU
   * resources. Missing any one of the three was a leak.
   */
  private releaseNode(node: TileNode): void {
    if (node.attached && node.mesh) this.scene.remove(node.mesh);
    this.streamer.withdraw(node);
    this.streamer.forget(node);
  }

  /**
   * The minimum of what the app allows and what the active imagery layer
   * serves. Refining past the layer's maximum produces tiles that can never get
   * their own texture and inherit for ever — sharper geometry under blurrier
   * imagery, which is worse than not refining.
   */
  private effectiveMaxZoom(): number {
    return Math.min(this.options.maxZoom, this.imagery.maxZoom);
  }
  // -------------------------------------------------------------------------
  private updateStats(): void {
    const loaderStats = this.streamer.loaderStats;
    this.stats.residentTiles = this.nodes.size;
    this.stats.loadingTiles = this.streamer.loadingCount;
    this.stats.queuedRequests = loaderStats.queued;
    this.stats.inFlightRequests = loaderStats.inFlight;
  }

  /**
   * Collapse the level-by-level descent when the camera is near the ground.
   *
   * Only fires when it can help: close to the terrain, and with the drawn
   * detail more than a couple of levels short of what this view allows. Both
   * matter — near the ground the screen-space error genuinely demands the
   * maximum zoom, so targeting it is not a guess; and if the tree is nearly
   * there the ordinary walk finishes on its own and seeding only competes.
   *
   * Re-seeded when the ground tile underneath changes, which keeps it from
   * re-issuing the same burst every frame. See `prefetchDescent`.
   */
  private maybeSeedDescent(camEcef: Vec3, forward: Vector3, deepestDrawn: number): void {
    const eye = ecefToGeodetic(camEcef[0], camEcef[1], camEcef[2]);
    const ground = this.sampleHeight(eye.lat, eye.lon);
    const agl = eye.height - ground;
    if (agl > DESCENT_TRIGGER_M) {
      this.descentKey = null;
      return;
    }

    const target = this.effectiveMaxZoom();
    if (deepestDrawn >= target - 2) return;

    // Keyed on a mid-level tile: a zoom-19 tile is about 24 m across, so
    // keying on it re-seeds on almost every frame of an approach. Five levels
    // up is roughly 800 m, the distance at which the chain really is
    // somewhere new.
    const keyZoom = Math.max(ROOT_ZOOM, target - 5);
    const n = 1 << keyZoom;
    const x = Math.floor(lonToMercatorX(eye.lon) * n);
    const y = Math.floor(latToMercatorY(eye.lat) * n);
    const key = tileKey(keyZoom, x, y);
    if (key === this.descentKey) return;
    this.descentKey = key;

    prefetchDescent(this.streamer, this.nodes, eye.lat, eye.lon, target);

    // And again where the camera is *pointing*. Seeding only the column
    // underneath is right for a descent and wrong for everything else near the
    // ground: from a cockpit at 50 m on final the tile under the wheels is a
    // handful of pixels at the bottom of the screen, so the one column that got
    // the parallel treatment was the one nobody was looking at.
    const aim = aimPoint(camEcef, forward, agl);
    if (aim) prefetchDescent(this.streamer, this.nodes, aim.lat, aim.lon, target);
  }

  /** Terrain height at a position, from the deepest resident tile. */
  sampleHeight(latDeg: number, lonDeg: number): number {
    return sampleTerrainHeight(this.nodes, this.options.maxZoom, latDeg, lonDeg);
  }

  /** Warm the cache along a predicted path. See `prefetchAlongPath`. */
  prefetchAlong(
    latDeg: number,
    lonDeg: number,
    headingDeg: number,
    groundSpeedMs: number,
    secondsAhead = 60,
    zoom = 12,
  ): void {
    prefetchAlongPath(
      this.streamer,
      this.effectiveMaxZoom(),
      latDeg,
      lonDeg,
      headingDeg,
      groundSpeedMs,
      secondsAhead,
      zoom,
    );
  }

  // -------------------------------------------------------------------------
  dispose(): void {
    for (const node of this.nodes.values()) node.dispose();
    this.nodes.clear();
    this.roots.length = 0;
    this.streamer.dispose();
  }
}
