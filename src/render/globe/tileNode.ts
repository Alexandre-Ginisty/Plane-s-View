/**
 * One node of the quadtree.
 *
 * Pure state plus the geometry every consumer needs to reason about it: where
 * it is, how big it is, which ancestor's texture it is currently borrowing.
 * It owns no loading logic and knows nothing about the loader — `Globe` drives
 * all of that — so the bookkeeping fields here (request keys, generations,
 * attempt counts) are records of what was done to the node, not behaviour.
 *
 * Kept separate from `Globe` because it is the one part of the quadtree that
 * can be reasoned about, and tested, without a camera or a network.
 */

import { BufferGeometry, Mesh, Texture, Vector4 } from 'three';

import {
  geodeticToEcef,
  tileBounds,
  tileCenterLatLon,
  tileKey,
  type TileBounds,
  type Vec3,
} from '@/core/math/geo';
import { IDENTITY_UV, type TerrainMaterial } from '../terrainMaterial';
import { MAX_TERRAIN_M, MIN_TERRAIN_M, type NodeState } from './constants';

export class TileNode {
  readonly key: string;
  readonly bounds: TileBounds;
  readonly depth: number;

  children: TileNode[] | null = null;

  /** Tile centre in ECEF and a conservative bounding radius about it. */
  readonly centerEcef: Vec3;
  readonly boundingRadius: number;
  /**
   * Radius used to measure *distance* to the tile, as opposed to culling it.
   *
   * `boundingRadius` has to contain Everest and the Dead Sea, because a volume
   * that clips real terrain culls tiles that are on screen. That envelope is
   * 9.5 km tall, which is fine for a yes/no test and ruinous for a distance:
   * `distanceTo` subtracts the radius, so from a cockpit at 11 km every tile
   * below reported itself 2 km away — five times too close, and screen-space
   * error is inversely proportional to distance. The quadtree was refining two
   * and a half extra levels over the whole visible world.
   *
   * This one spans the footprint at sea level only. It errs towards *more*
   * distance and less refinement, which is the safe direction: the cost of
   * being wrong is a moment of blur, not a stall.
   */
  readonly lodRadius: number;
  /** Ground span of the tile, metres — the basis of its geometric error. */
  readonly spanMetres: number;

  geometry: BufferGeometry | null = null;
  heights: Float32Array | null = null;
  gridWidth = 0;
  mesh: Mesh | null = null;
  material: TerrainMaterial | null = null;

  /** This tile's own imagery, once it has arrived. */
  texture: Texture | null = null;
  textureState: NodeState = 'idle';
  /** 0 = showing the inherited ancestor texture, 1 = showing its own. */
  textureBlend = 0;

  geometryState: NodeState = 'idle';

  /**
   * Loader keys currently outstanding for this node.
   *
   * Held so the request can be *withdrawn* when the node is abandoned.
   * Aborting `this.abort` only stops our own continuation — the loader has its
   * own controller and keeps the fetch, and its concurrency slot, alive.
   */
  geometryRequestKey: string | null = null;
  textureRequestKey: string | null = null;

  /**
   * Generation counters.
   *
   * A load whose node was abandoned mid-flight resumes later and would write
   * its stale outcome over the state of the load that replaced it, which ends
   * in two loads racing and a third being started on top. Each load captures
   * the generation it began in and writes nothing if it has been superseded.
   */
  geometryGen = 0;
  textureGen = 0;

  geometryAttempts = 0;
  textureAttempts = 0;
  /** Frame from which a failed load may be tried again. */
  geometryRetryFrame = 0;
  textureRetryFrame = 0;

  /**
   * Screen-space error recorded the last time selection looked at this node.
   *
   * Stored rather than recomputed because it has two consumers a frame apart:
   * selection decides whether to refine with it, and the loader ranks its
   * queue by it — including on later frames, when the node is still waiting
   * on the network and the camera has moved. See `priorityOf`.
   */
  screenError = 0;

  /**
   * Loader priority for this node's outstanding requests.
   *
   * Written by selection, read when a request is issued and every frame it is
   * still queued. A request whose priority is fixed at issue time is ranked by
   * where the camera was when the tile was first wanted, which under a moving
   * aircraft is wrong within a second or two.
   */
  priority = 0;

  /** Fade-in progress once selected for rendering. */
  opacity = 0;
  /** Set each frame the node is selected; drives eviction. */
  lastUsedFrame = -1;
  /**
   * Last frame this node actually passed the visibility test.
   *
   * Distinct from `lastUsedFrame`, which a parent also stamps on children it
   * merely wants loaded. Only a child that is genuinely on screen can hold its
   * parent in the render set.
   */
  onScreenFrame = -1;
  /** True while the node is attached to the scene. */
  attached = false;

  abort: AbortController | null = null;

  constructor(
    readonly z: number,
    readonly x: number,
    readonly y: number,
    readonly parent: TileNode | null,
  ) {
    this.key = tileKey(z, x, y);
    this.depth = z;
    this.bounds = tileBounds(z, x, y);

    // Must match the origin the worker builds vertices around, or the mesh
    // is drawn offset from where it was computed. See `tileCenterLatLon`.
    const center = tileCenterLatLon(z, x, y);
    this.centerEcef = geodeticToEcef(center.lat, center.lon, 0);

    // Conservative bounds: the corners at the highest and lowest terrain the
    // planet offers. Computed now because screen-space error and frustum
    // culling are needed long before the geometry exists.
    let maxSq = 0;
    for (const lat of [this.bounds.north, this.bounds.south]) {
      for (const lon of [this.bounds.west, this.bounds.east]) {
        for (const h of [MIN_TERRAIN_M, MAX_TERRAIN_M]) {
          const c = geodeticToEcef(lat, lon, h);
          const dx = c[0] - this.centerEcef[0];
          const dy = c[1] - this.centerEcef[1];
          const dz = c[2] - this.centerEcef[2];
          maxSq = Math.max(maxSq, dx * dx + dy * dy + dz * dz);
        }
      }
    }
    this.boundingRadius = Math.sqrt(maxSq);

    const nw = geodeticToEcef(this.bounds.north, this.bounds.west, 0);
    const se = geodeticToEcef(this.bounds.south, this.bounds.east, 0);
    this.spanMetres = Math.hypot(nw[0] - se[0], nw[1] - se[1], nw[2] - se[2]);

    // The footprint alone, no terrain envelope. See `lodRadius`.
    let flatSq = 0;
    for (const lat of [this.bounds.north, this.bounds.south]) {
      for (const lon of [this.bounds.west, this.bounds.east]) {
        const c = geodeticToEcef(lat, lon, 0);
        const dx = c[0] - this.centerEcef[0];
        const dy = c[1] - this.centerEcef[1];
        const dz = c[2] - this.centerEcef[2];
        flatSq = Math.max(flatSq, dx * dx + dy * dy + dz * dz);
      }
    }
    this.lodRadius = Math.sqrt(flatSq);
  }

  get contentReady(): boolean {
    return this.geometry !== null;
  }

  /** Nearest ancestor (or self) holding a real texture. */
  textureAncestor(): TileNode | null {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let node: TileNode | null = this;
    while (node) {
      if (node.texture) return node;
      node = node.parent;
    }
    return null;
  }

  /**
   * UV offset/scale mapping this tile's [0,1] UVs into `ancestor`'s texture.
   *
   * UVs run east in u and **north** in v, while tile Y runs south, so the v
   * offset is measured from the ancestor's southern edge. Getting this
   * backwards mirrors the terrain vertically, which looks almost right at a
   * glance and is deeply wrong.
   */
  uvInto(ancestor: TileNode, out: Vector4): Vector4 {
    if (ancestor === this) return out.copy(IDENTITY_UV);

    const f = 1 << (this.z - ancestor.z);
    const scale = 1 / f;
    const offsetU = this.x / f - ancestor.x;
    const offsetV = 1 - (this.y / f + scale - ancestor.y);
    return out.set(offsetU, offsetV, scale, scale);
  }

  dispose(): void {
    this.abort?.abort();
    this.abort = null;
    this.geometry?.dispose();
    this.geometry = null;
    this.material?.dispose();
    this.material = null;
    this.texture?.dispose();
    this.texture = null;
    this.mesh = null;
    this.heights = null;
  }
}
