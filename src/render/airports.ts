/**
 * Real airport buildings, brought in as the aircraft comes near.
 *
 * Terminals, piers, towers, hangars and jetways modelled by the FlightGear
 * community, converted once by `tools/airports/build.mjs` into one pack per
 * airport (`models/airports/<ICAO>.pvm`, its credits beside it). The list of
 * airports is fetched the first time an aircraft is followed; a pack only when
 * the aircraft is within reach of that airport and low enough for its
 * buildings to be more than a smudge, and it is let go again once the aircraft
 * has left. Two at most are held: the one being left and the one ahead.
 *
 * ## Standing on the ground
 *
 * A pack is in metres east, north and up about the airport's reference point,
 * and each building's height is from the ground under it — the simulator's
 * ground, not this one's. So every building is stood on the terrain this
 * globe has streamed at its own position (`instances`, one height per
 * building), less the curvature of the Earth over its distance from the
 * reference point, sunk a hand's breadth so a slope never shows daylight under
 * a wall. The terrain sharpens as tiles arrive; the heights are taken again
 * every few seconds until they stop moving.
 *
 * ## Night
 *
 * The simulator swaps a façade to its lit-window half of the sheet at dusk
 * (a texture translation driven by the sun); the pack keeps that shift per
 * part (`night`). Here the same sheet, shifted, is both the picture and the
 * glow after dark.
 */

import { Group, Matrix4, Mesh, RepeatWrapping, Vector3, type BufferAttribute, type MeshLambertMaterial, type Texture } from 'three';

import type { FloatingOrigin } from '@/core/frame';
import { enuBasis, geodeticToEcef } from '@/core/math/geo';
import { fetchModel } from '@/render/aircraft/library';
import { deviceBudget } from '@/render/deviceBudget';
import type { LoadedModel } from '@/render/aircraft/pvm';

interface AirportRow {
  icao: string;
  lat: number;
  lon: number;
  radiusKm: number;
  bytes: number;
}

/** Fetch an airport's buildings within this distance of it, km… */
const LOAD_KM = 28;
/** …below this altitude: from higher, a terminal is a few pixels. */
const LOAD_BELOW_FT = 18_000;
/** Let them go beyond this distance, km. */
const DROP_KM = 45;
/**
 * How many airports are held at once, by what the device can afford: the one
 * being left and the one ahead on a desktop, one on a phone, none on the
 * lightest — a big hub is a hundred thousand triangles and its sheets.
 */
const MAX_LOADED: Record<string, number> = { high: 2, mid: 2, low: 1, minimal: 0 };
/** How often the choice of airports is made, seconds. */
const CHOOSE_EVERY_S = 1;
/** How often the ground under the buildings is measured again, seconds. */
const RESAMPLE_EVERY_S = 2;
/** A height change smaller than this is not worth rewriting the buildings for, metres. */
const RESAMPLE_EPS_M = 0.25;
/** How far each building is sunk into the ground, metres. */
const SINK_M = 0.4;
/** How long the buildings take to fade in, seconds. */
const FADE_S = 2.5;
const EARTH_RADIUS_M = 6_371_000;
/** The glow of lit windows at full night. */
const NIGHT_GLOW = 0.85;

type HeightAt = (lat: number, lon: number) => number;

interface Piece {
  mesh: Mesh;
  material: MeshLambertMaterial;
  /** Heights as converted: each vertex's from its own building's ground. */
  baseZ: Float32Array;
  inst: Uint16Array;
  day: Texture | null;
  night: Texture | null;
}

interface Loaded {
  row: AirportRow;
  model: LoadedModel;
  group: Group;
  pieces: Piece[];
  /** The reference point's ground, and each building's ground about it (curvature and sink included). */
  h0: number;
  heights: Float32Array;
  /** Building offsets from the reference point, metres east and north. */
  east: Float32Array;
  north: Float32Array;
  resampleIn: number;
  fade: number;
  lit: boolean | null;
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const k = Math.PI / 180;
  const dLat = (lat2 - lat1) * k;
  const dLon = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  return Math.hypot(dLat, dLon) * (EARTH_RADIUS_M / 1000);
}

const _m = new Matrix4();
const _e = new Vector3();
const _n = new Vector3();
const _u = new Vector3();

export class AirportModels {
  readonly scene = new Group();
  private index: AirportRow[] | null = null;
  private indexPending: Promise<void> | null = null;
  private readonly loaded = new Map<string, Loaded>();
  private readonly loading = new Set<string>();
  private chooseIn = 0;
  private disposed = false;
  private readonly maxLoaded = MAX_LOADED[deviceBudget().tier] ?? 1;

  constructor(private readonly origin: FloatingOrigin) {
    this.scene.name = 'airports';
  }

  /** Once a frame, with the followed aircraft's position and the night factor (0 day, 1 night). */
  update(lat: number, lon: number, altFt: number, night: number, dt: number, heightAt: HeightAt): void {
    this.chooseIn -= dt;
    if (this.chooseIn <= 0) {
      this.chooseIn = CHOOSE_EVERY_S;
      this.choose(lat, lon, altFt);
    }
    for (const airport of this.loaded.values()) this.tend(airport, night, dt, heightAt);
  }

  private choose(lat: number, lon: number, altFt: number): void {
    if (this.maxLoaded === 0) return;
    if (!this.index) {
      this.indexPending ??= fetch('models/airports/index.json')
        .then((r) => (r.ok ? (r.json() as Promise<AirportRow[]>) : []))
        .catch(() => [])
        .then((rows) => {
          this.index = rows;
        });
      return;
    }
    for (const [icao, airport] of this.loaded) {
      if (distanceKm(lat, lon, airport.row.lat, airport.row.lon) > DROP_KM) this.unload(icao);
    }
    if (altFt > LOAD_BELOW_FT || this.loaded.size + this.loading.size >= this.maxLoaded) return;
    const near = this.index
      .map((row) => ({ row, km: distanceKm(lat, lon, row.lat, row.lon) }))
      .filter(({ row, km }) => km < LOAD_KM && !this.loaded.has(row.icao) && !this.loading.has(row.icao))
      .sort((a, b) => a.km - b.km)[0];
    if (near) void this.load(near.row);
  }

  private async load(row: AirportRow): Promise<void> {
    this.loading.add(row.icao);
    const model = await fetchModel(`airports/${row.icao}`);
    this.loading.delete(row.icao);
    if (!model || this.disposed || this.loaded.has(row.icao)) {
      if (model) disposeModel(model);
      return;
    }

    const group = new Group();
    group.name = `airport ${row.icao}`;
    const [clat, clon] = model.centre ?? [row.lat, row.lon];
    const { east, north, up } = enuBasis(clat, clon);
    group.quaternion.setFromRotationMatrix(_m.makeBasis(_e.fromArray(east), _n.fromArray(north), _u.fromArray(up)));

    const pieces: Piece[] = [];
    for (const part of model.parts) {
      const geometry = part.geometry;
      const position = geometry.getAttribute('position') as BufferAttribute;
      const instAttr = geometry.getAttribute('inst') as BufferAttribute | undefined;
      const baseZ = new Float32Array(position.count);
      for (let i = 0; i < position.count; i++) baseZ[i] = position.getZ(i);
      const inst = instAttr ? (instAttr.array as Uint16Array) : new Uint16Array(position.count);
      // The building index is for this side only; the GPU has no use for it.
      geometry.deleteAttribute('inst');

      const material = part.material;
      material.transparent = true;
      material.opacity = 0;
      const day = material.map;
      let nightMap: Texture | null = null;
      if (day && part.night) {
        nightMap = day.clone();
        nightMap.wrapS = RepeatWrapping;
        nightMap.wrapT = RepeatWrapping;
        nightMap.offset.set(part.night[0], part.night[1]);
        nightMap.needsUpdate = true;
        // Always bound, so night and day share one shader; dark until dusk.
        material.emissiveMap = nightMap;
        material.emissive.setScalar(0);
      }
      const mesh = new Mesh(geometry, material);
      mesh.name = part.name;
      group.add(mesh);
      pieces.push({ mesh, material, baseZ, inst, day, night: nightMap });
    }

    const mPerLat = 111_132;
    const mPerLon = 111_320 * Math.cos((clat * Math.PI) / 180);
    const n = model.instances.length;
    const eastM = new Float32Array(n);
    const northM = new Float32Array(n);
    model.instances.forEach(([blat, blon], i) => {
      eastM[i] = (blon - clon) * mPerLon;
      northM[i] = (blat - clat) * mPerLat;
    });

    const airport: Loaded = {
      row: { ...row, lat: clat, lon: clon },
      model,
      group,
      pieces,
      h0: Number.NaN,
      heights: new Float32Array(n).fill(Number.NaN),
      east: eastM,
      north: northM,
      resampleIn: 0,
      fade: 0,
      lit: null,
    };
    this.loaded.set(row.icao, airport);
    this.scene.add(group);
  }

  private tend(airport: Loaded, night: number, dt: number, heightAt: HeightAt): void {
    airport.resampleIn -= dt;
    if (airport.resampleIn <= 0) {
      airport.resampleIn = RESAMPLE_EVERY_S;
      this.standOnGround(airport, heightAt);
    }

    // Placed about the floating origin each frame: the origin moves under it.
    const o = this.origin.current;
    const c = geodeticToEcef(airport.row.lat, airport.row.lon, airport.h0);
    airport.group.position.set(c[0] - o[0], c[1] - o[1], c[2] - o[2]);

    if (airport.fade < 1) {
      airport.fade = Math.min(1, airport.fade + dt / FADE_S);
      const k = airport.fade * airport.fade * (3 - 2 * airport.fade);
      for (const { material } of airport.pieces) {
        material.opacity = k;
        if (airport.fade === 1) {
          // Opaque again once in: no sorting, depth written as for any building.
          material.transparent = false;
          material.needsUpdate = true;
        }
      }
    }

    const lit = night > 0.5;
    const glow = Math.max(0, Math.min(1, (night - 0.35) / 0.4)) * NIGHT_GLOW;
    for (const piece of airport.pieces) {
      if (!piece.night) continue;
      piece.material.emissive.setScalar(glow);
      if (lit !== airport.lit) piece.material.map = lit ? piece.night : piece.day;
    }
    airport.lit = lit;
  }

  /** Each building on the ground under it, once the terrain there is known. */
  private standOnGround(airport: Loaded, heightAt: HeightAt): void {
    const { row, model } = airport;
    const h0 = heightAt(row.lat, row.lon);
    if (!Number.isFinite(h0)) return;
    const n = model.instances.length;
    let moved = Number.isNaN(airport.h0) || Math.abs(h0 - airport.h0) > RESAMPLE_EPS_M;
    const next = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const [blat, blon] = model.instances[i]!;
      const e = airport.east[i]!;
      const nn = airport.north[i]!;
      const drop = (e * e + nn * nn) / (2 * EARTH_RADIUS_M);
      const h = heightAt(blat, blon);
      next[i] = (Number.isFinite(h) ? h : h0) - h0 - drop - SINK_M;
      if (!moved && Math.abs(next[i]! - airport.heights[i]!) > RESAMPLE_EPS_M) moved = true;
    }
    if (!moved) return;
    airport.h0 = h0;
    airport.heights = next;
    for (const { mesh, baseZ, inst } of airport.pieces) {
      const position = mesh.geometry.getAttribute('position') as BufferAttribute;
      const array = position.array as Float32Array;
      for (let v = 0; v < baseZ.length; v++) array[v * 3 + 2] = baseZ[v]! + (next[inst[v]!] ?? 0);
      position.needsUpdate = true;
      mesh.geometry.computeBoundingSphere();
    }
  }

  private unload(icao: string): void {
    const airport = this.loaded.get(icao);
    if (!airport) return;
    this.loaded.delete(icao);
    this.scene.remove(airport.group);
    for (const piece of airport.pieces) {
      // The day sheet back in its place, so the model's own is what is freed.
      piece.material.map = piece.day;
      piece.material.emissiveMap = null;
      piece.night?.dispose();
    }
    disposeModel(airport.model);
  }

  dispose(): void {
    this.disposed = true;
    for (const icao of [...this.loaded.keys()]) this.unload(icao);
  }
}

/** A pack's GPU resources: it is this module's alone (`fetchModel`, not the shared cache). */
function disposeModel(model: LoadedModel): void {
  const textures = new Set<Texture>();
  for (const part of model.parts) {
    part.geometry.dispose();
    if (part.material.map) textures.add(part.material.map);
    part.material.dispose();
  }
  for (const t of textures) t.dispose();
}
