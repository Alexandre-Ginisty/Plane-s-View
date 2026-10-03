/**
 * 3D buildings around the camera, from OpenStreetMap.
 *
 * ## Source
 *
 * OpenFreeMap's vector tiles (OpenMapTiles schema): every building mapped in
 * OpenStreetMap, with its height where it is known and a sensible one where
 * it is not. Free, keyless, and free for commercial use — the data is ODbL
 * and wants its credit, which the status panel and the 3D view's credit line
 * carry. The tile URL is read from the service's TileJSON, which names the
 * current weekly build.
 *
 * ## Two rings
 *
 * The world is walked at zoom 13 (tiles about 3 km across in Europe):
 *
 *  - **Near** — within a few kilometres, more as the camera climbs — a z13
 *    tile is replaced by its four z14 children, with every building, pitched
 *    roofs and facades.
 *  - **Far** — out to fifteen kilometres and more — the z13 tile itself,
 *    keeping only what stands above 7 m: the skyline, which is what the
 *    eye finds on the horizon. A bungalow at twelve kilometres is a pixel.
 *
 * A z13 tile stays drawn until all four of its children are ready, so the
 * switch never leaves a hole, and the children never overlap their parent.
 *
 * ## On the ground
 *
 * The worker returns each building with its own ground at zero; it is
 * placed here on the terrain as drawn, and placed again when the ground
 * under the tile is refined, so a town does not float above a hillside that
 * has just sharpened.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  Vector3,
  type PerspectiveCamera,
} from 'three';

import type { FloatingOrigin } from '@/core/frame';
import { ecefToGeodetic, enuBasis, geodeticToEcef } from '@/core/math/geo/ellipsoid';
import { latToMercatorY, lonToMercatorX, mercatorYToLat } from '@/core/math/geo/mercator';
import { haversineMetres } from '@/core/math/geo/sphere';
import type { Vec3 } from '@/core/math/geo';
import type { BuildingRequest, BuildingResponse } from '@/workers/buildings.worker';
import type { BuiltBuildings } from '@/workers/buildings/extrude';
import { BuildingMaterial } from './material';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const TILE_HOST = 'tiles.openfreemap.org';

const WALK_ZOOM = 13;
/** Far-ring buildings lower than this are left out. */
const FAR_MIN_HEIGHT_M = 7;
/** Above this, no new tiles are asked for: from cruise a city is its imagery. */
const MAX_AGL_M = 9000;
/** Above this, what is loaded is not drawn either. */
const HIDE_AGL_M = 14000;
const APPEAR_S = 0.9;
const IN_FLIGHT = 4;
/** A tile nobody wants is kept this long, for a camera that turns back. */
const LINGER_MS = 20_000;
const R = 6_371_000;

type State = 'loading' | 'ready' | 'empty' | 'failed';

interface Tile {
  key: string;
  z: number;
  x: number;
  y: number;
  minHeight: number;
  state: State;
  lat: number;
  lon: number;
  mesh: Mesh<BufferGeometry, BuildingMaterial> | null;
  /** Vertex z from each building's own ground, kept to place again. */
  rel: Float32Array | null;
  ranges: Uint32Array | null;
  anchors: Float64Array | null;
  placedZoom: number;
  wantedAt: number;
  retryAt: number;
}

const keyOf = (z: number, x: number, y: number): string => `${z}/${x}/${y}`;

interface Terrain {
  sampleHeight(lat: number, lon: number): number;
  terrainZoom(lat: number, lon: number): number;
}

export class Buildings {
  readonly scene = new Group();
  private readonly tiles = new Map<string, Tile>();
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Tile>();
  private nextId = 1;
  private nextWorker = 0;
  private template: string | null = null;
  private templateLoading = false;
  private clock = 0;
  private placeClock = 0;
  private readonly coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  private readonly cam = new Vector3();
  private readonly m = new Matrix4();
  private enabled = true;
  private terrain: Terrain | null = null;

  constructor(private readonly origin: FloatingOrigin) {
    this.scene.matrixAutoUpdate = false;
    const count = this.coarse ? 1 : 2;
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('../../workers/buildings.worker.ts', import.meta.url), { type: 'module', name: `planesview-buildings-${i}` });
      w.onmessage = (e: MessageEvent<BuildingResponse>) => this.receive(e.data);
      this.workers.push(w);
    }
    origin.addListener({ onOriginChanged: () => this.repositionAll() });
  }

  /** Off: nothing more is fetched and nothing is drawn. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.scene.visible = on;
  }

  update(camera: PerspectiveCamera, dt: number, terrain: Terrain): void {
    if (!this.enabled) return;
    this.terrain = terrain;
    for (const t of this.tiles.values()) {
      const mat = t.mesh?.material;
      if (mat && mat.appear < 1) mat.appear = Math.min(1, mat.appear + dt / APPEAR_S);
    }

    this.clock += dt;
    this.placeClock += dt;
    if (this.placeClock > 1) {
      this.placeClock = 0;
      for (const t of this.tiles.values()) if (t.state === 'ready') this.placeIfRefined(t, terrain);
    }
    if (this.clock < 0.5) return;
    this.clock = 0;

    const o = this.origin.current;
    this.cam.copy(camera.position);
    const eye = ecefToGeodetic(this.cam.x + o[0], this.cam.y + o[1], this.cam.z + o[2]);
    const groundHere = terrain.sampleHeight(eye.lat, eye.lon);
    const agl = eye.height - (Number.isFinite(groundHere) ? groundHere : 0);
    this.scene.visible = agl < HIDE_AGL_M;
    if (agl > MAX_AGL_M) {
      this.select([], new Set());
      return;
    }

    const scale = this.coarse ? 0.6 : 1;
    const near = Math.min(6000, Math.max(2600, 2600 + agl * 0.8)) * scale;
    const far = Math.min(18_000, Math.max(7000, 5000 + agl * 2.5)) * (this.coarse ? 0.5 : 1);

    // Walk the z13 tiles within the far radius.
    const n = 2 ** WALK_ZOOM;
    const cx = lonToMercatorX(eye.lon) * n;
    const cy = latToMercatorY(eye.lat) * n;
    const tileM = (2 * Math.PI * R * Math.cos((eye.lat * Math.PI) / 180)) / n;
    const span = Math.ceil(far / tileM) + 1;
    const wanted: { z: number; x: number; y: number; minHeight: number; d: number; parent: string | null }[] = [];
    const nearParents = new Set<string>();
    for (let ty = Math.floor(cy) - span; ty <= Math.floor(cy) + span; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx0 = Math.floor(cx) - span; tx0 <= Math.floor(cx) + span; tx0++) {
        const tx = ((tx0 % n) + n) % n;
        const lat = mercatorYToLat((ty + 0.5) / n);
        const lon = ((tx + 0.5) / n) * 360 - 180;
        const d = Math.max(0, haversineMetres(eye.lat, eye.lon, lat, lon) - tileM * 0.7);
        if (d > far) continue;
        if (d <= near) {
          const parent = keyOf(WALK_ZOOM, tx, ty);
          nearParents.add(parent);
          for (let k = 0; k < 4; k++) {
            const x = tx * 2 + (k & 1);
            const y = ty * 2 + (k >> 1);
            const clat = mercatorYToLat((y + 0.5) / (n * 2));
            const clon = ((x + 0.5) / (n * 2)) * 360 - 180;
            wanted.push({ z: WALK_ZOOM + 1, x, y, minHeight: 0, d: haversineMetres(eye.lat, eye.lon, clat, clon), parent });
          }
          // The parent too, as the stand-in while its children load.
          wanted.push({ z: WALK_ZOOM, x: tx, y: ty, minHeight: FAR_MIN_HEIGHT_M, d: d + 1e6, parent: null });
        } else {
          wanted.push({ z: WALK_ZOOM, x: tx, y: ty, minHeight: FAR_MIN_HEIGHT_M, d, parent: null });
        }
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    this.select(wanted, nearParents);
  }

  private select(
    wanted: readonly { z: number; x: number; y: number; minHeight: number; d: number; parent: string | null }[],
    nearParents: ReadonlySet<string>,
  ): void {
    const now = performance.now();
    for (const w of wanted) {
      const key = keyOf(w.z, w.x, w.y);
      let t = this.tiles.get(key);
      if (!t) {
        const n = 2 ** w.z;
        t = {
          key, z: w.z, x: w.x, y: w.y, minHeight: w.minHeight, state: 'failed',
          lat: mercatorYToLat((w.y + 0.5) / n), lon: ((w.x + 0.5) / n) * 360 - 180,
          mesh: null, rel: null, ranges: null, anchors: null, placedZoom: -2, wantedAt: now, retryAt: 0,
        };
        this.tiles.set(key, t);
      }
      t.wantedAt = now;
    }

    // Ask for what is missing, nearest first. Parents of near tiles only if
    // nothing better is coming soon: they are queued last by their distance.
    let inFlight = this.pending.size;
    if (this.template) {
      for (const w of wanted) {
        if (inFlight >= IN_FLIGHT) break;
        const t = this.tiles.get(keyOf(w.z, w.x, w.y))!;
        if (t.state === 'failed' && now >= t.retryAt) {
          this.request(t);
          inFlight++;
        }
      }
    } else {
      void this.loadTemplate();
    }

    // What to draw. Parents first: a near parent only while one of its
    // children is not ready; then each child only when its parent is not.
    const placed = (t: Tile | undefined): boolean => !!t && (t.state === 'empty' || (t.state === 'ready' && t.placedZoom >= 0));
    for (const pass of [WALK_ZOOM, WALK_ZOOM + 1]) {
      for (const t of this.tiles.values()) {
        if (t.z !== pass || !t.mesh) continue;
        let show = now - t.wantedAt < 1500 && t.placedZoom >= 0;
        if (show && pass === WALK_ZOOM && nearParents.has(t.key)) {
          let ready = 0;
          for (let k = 0; k < 4; k++) if (placed(this.tiles.get(keyOf(t.z + 1, t.x * 2 + (k & 1), t.y * 2 + (k >> 1))))) ready++;
          show = ready < 4;
        }
        if (show && pass === WALK_ZOOM + 1 && this.tiles.get(keyOf(WALK_ZOOM, t.x >> 1, t.y >> 1))?.mesh?.visible) show = false;
        t.mesh.visible = show;
      }
    }

    // Forget what has not been wanted for a while.
    for (const [key, t] of this.tiles) {
      if (t.state === 'loading' || now - t.wantedAt < LINGER_MS) continue;
      this.drop(t);
      this.tiles.delete(key);
    }
  }

  private async loadTemplate(): Promise<void> {
    if (this.templateLoading) return;
    this.templateLoading = true;
    try {
      const res = await fetch(TILEJSON, { credentials: 'omit' });
      const json = (await res.json()) as { tiles?: unknown };
      const url = Array.isArray(json.tiles) ? json.tiles[0] : null;
      if (typeof url === 'string') {
        const parsed = new URL(url.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'));
        if (parsed.protocol === 'https:' && parsed.hostname === TILE_HOST) this.template = url;
      }
    } catch {
      // Offline or refused: try again on a later update.
    } finally {
      this.templateLoading = false;
    }
  }

  private request(t: Tile): void {
    const template = this.template;
    if (!template) return;
    t.state = 'loading';
    const id = this.nextId++;
    this.pending.set(id, t);
    const url = template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
    const message: BuildingRequest = { id, url, z: t.z, x: t.x, y: t.y, minHeight: t.minHeight };
    this.workers[this.nextWorker++ % this.workers.length]!.postMessage(message);
  }

  private receive(r: BuildingResponse): void {
    const t = this.pending.get(r.id);
    this.pending.delete(r.id);
    if (!t || this.tiles.get(t.key) !== t) return;
    if (!r.ok) {
      // 404 is the sea: nothing there, ever. Anything else, later.
      t.state = r.status === 404 || r.status === 204 ? 'empty' : 'failed';
      t.retryAt = performance.now() + 15_000;
      return;
    }
    if (r.built.indices.length === 0) {
      t.state = 'empty';
      return;
    }
    this.build(t, r.built);
    t.state = 'ready';
    if (this.terrain) this.placeIfRefined(t, this.terrain);
  }

  private build(t: Tile, b: BuiltBuildings): void {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(b.positions, 3));
    g.setAttribute('normal', new BufferAttribute(b.normals, 3, true));
    g.setAttribute('facade', new BufferAttribute(b.facade, 4));
    g.setAttribute('color', new BufferAttribute(b.colors, 4, true));
    g.setIndex(new BufferAttribute(b.indices, 1));
    const rel = new Float32Array(b.positions.length / 3);
    for (let i = 0; i < rel.length; i++) rel[i] = b.positions[i * 3 + 2]!;
    t.rel = rel;
    t.ranges = b.ranges;
    t.anchors = b.anchors;

    const basis = enuBasis(t.lat, t.lon);
    const mesh = new Mesh(g, new BuildingMaterial(new Vector3(...basis.up)));
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = true;
    mesh.visible = false;
    t.mesh = mesh;
    this.position(t);
    this.scene.add(mesh);
  }

  /** Put each building on the ground as it is drawn now. */
  private placeIfRefined(t: Tile, terrain: Terrain): void {
    const zoom = terrain.terrainZoom(t.lat, t.lon);
    if (zoom <= t.placedZoom || !t.mesh || !t.rel || !t.ranges || !t.anchors) return;
    const centre = terrain.sampleHeight(t.lat, t.lon);
    if (!Number.isFinite(centre)) return;
    const pos = t.mesh.geometry.getAttribute('position') as BufferAttribute;
    const arr = pos.array as Float32Array;
    const rel = t.rel;
    const ranges = t.ranges;
    const anchors = t.anchors;
    for (let b = 0; b < ranges.length / 2; b++) {
      const first = ranges[b * 2]!;
      const count = ranges[b * 2 + 1]!;
      let ground = terrain.sampleHeight(anchors[b * 2 + 1]!, anchors[b * 2]!);
      if (!Number.isFinite(ground)) ground = centre;
      // The tangent plane falls away from the ellipsoid with distance.
      const ex = arr[first * 3]!;
      const ny = arr[first * 3 + 1]!;
      const drop = (ex * ex + ny * ny) / (2 * R);
      const lift = ground - drop;
      for (let i = first; i < first + count; i++) arr[i * 3 + 2] = rel[i]! + lift;
    }
    pos.needsUpdate = true;
    t.mesh.geometry.computeBoundingSphere();
    t.placedZoom = zoom;
  }

  private position(t: Tile): void {
    if (!t.mesh) return;
    const o = this.origin.current;
    const c: Vec3 = geodeticToEcef(t.lat, t.lon, 0);
    const { east: e, north: nn, up: u } = enuBasis(t.lat, t.lon);
    this.m.set(
      e[0], nn[0], u[0], c[0] - o[0],
      e[1], nn[1], u[1], c[1] - o[1],
      e[2], nn[2], u[2], c[2] - o[2],
      0, 0, 0, 1,
    );
    t.mesh.matrix.copy(this.m);
    t.mesh.matrixWorld.copy(this.m);
  }

  private repositionAll(): void {
    for (const t of this.tiles.values()) this.position(t);
  }

  private drop(t: Tile): void {
    if (t.mesh) {
      this.scene.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
      t.mesh = null;
    }
    t.rel = null;
    t.ranges = null;
    t.anchors = null;
  }

  get stats(): { tiles: number; drawn: number; triangles: number } {
    let drawn = 0;
    let triangles = 0;
    for (const t of this.tiles.values()) {
      if (t.mesh?.visible) {
        drawn++;
        triangles += (t.mesh.geometry.index?.count ?? 0) / 3;
      }
    }
    return { tiles: this.tiles.size, drawn, triangles };
  }

  dispose(): void {
    for (const t of this.tiles.values()) this.drop(t);
    this.tiles.clear();
    for (const w of this.workers) w.terminate();
  }
}
