/**
 * Other aircraft, drawn in the 3D view — and mostly not drawn at all.
 *
 * ## Why almost nothing is drawn
 *
 * This used to draw every aircraft within 120 km, inflating anything below
 * eleven screen pixels so it stayed visible. That is the right rule for a
 * chart and the wrong one for a window: the inflated marks are a crude
 * twenty-triangle silhouette held at a size the real aircraft does not have,
 * scattered across a photographic sky. Reported, accurately, as flies on the
 * windscreen.
 *
 * So the rule is now the one a window obeys. Aircraft are drawn at **true
 * scale**, never inflated, and only within a range at which true scale is
 * worth drawing. Past that they are simply absent — which is also what you see
 * out of a real aeroplane, where the traffic a mile away is a speck you notice
 * once and most of it you never see at all.
 *
 * ## Why the few that are drawn are real airframes
 *
 * Once nothing is inflated, everything still on screen is genuinely close, and
 * at that range a marker geometry is indefensible. These use the converted
 * FlightGear airframes — the same assets the aircraft you are riding uses.
 *
 * One model stands in for every fixed-wing type, and one for every rotorcraft.
 * That is a real compromise and it is the right one: the alternative is a
 * separate instanced buffer per type, which is a draw call per type on screen,
 * to distinguish airframes that are a few pixels apart in outline at the only
 * ranges this draws at.
 *
 * ## How a multi-part model is instanced
 *
 * A converted model is several parts with different materials, and an
 * `InstancedMesh` holds one geometry. So there is one `InstancedMesh` per
 * part, and all of them are written with the same matrices — the fleet costs
 * a draw call per part rather than per aircraft.
 *
 * ## …except the nearest few, which are exactly what they are
 *
 * The stand-in is right for a crowded terminal area and wrong for the handful
 * of aircraft close enough to actually look at. The nearest `DETAIL_COUNT`
 * with a known type are drawn with their own airframe and their operator's
 * livery — the same model and paint `OwnAircraft` would give them — as
 * ordinary meshes sharing the library's cached geometry. A dozen extra draw
 * calls at most, spent only where the difference can be seen.
 *
 * ## Reachable — when it can actually be seen
 *
 * An aircraft gets a target designator, and can be clicked to step across
 * into, only when it is on screen as an aircraft: drawn (inside the drawing
 * range), a few pixels long at least, and not behind a hill. The first version
 * labelled everything within 60 km, three times the range anything is drawn
 * at, so the designator regularly framed an empty patch of sky. A label that
 * points at nothing is worse than no label.
 */

import {
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  Scene,
  Vector3,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three';
import { prewarm } from './prewarm';
import { FEET_TO_METRES, ecefToGeodetic, geodeticToEcef } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import type { SampledAircraft } from '@/state/traffic';
import { registry } from '@/data/meta/registry';
import { isSurfaceVehicle, rotorRpm, shapeFor, visibleSpinRate, type AirframeShape } from './aircraft';
import { AircraftLights, lightSeed } from './aircraftLights';
import { Contrails } from './contrails';
import { loadModelFor, operatorOf } from './aircraft/library';
import type { LoadedModel } from './aircraft/pvm';
import { lightAnchorsFor, type LightAnchors } from './aircraft/lightAnchors';
import { GROUND_CHECK_CEILING_M, clearanceFor, surfaceAltitudeM } from './ground';
import { aircraftFrame } from './pov';
import type { OverlayFrame, OverlayPalette } from './overlay';

/**
 * How close an aircraft has to be to be drawn at all, metres.
 *
 * At twenty kilometres a 60 m airliner subtends about two screen pixels — the
 * point at which it stops being an aeroplane and becomes a mark, and the point
 * this deliberately stops drawing. Inside it the model grows the way a real
 * one does, and a genuine close pass fills the window.
 *
 * It is not a performance number. Drawing to 120 km cost almost nothing; what
 * it cost was the look of the sky.
 */
const MAX_RANGE_M = 20_000;

/**
 * At night, traffic beyond the drawing range still shows — as its lights.
 * A beacon is visible from much further than this; the limit is what the
 * sky can hold without becoming a starfield of traffic.
 */
const LIGHTS_RANGE_M = 90_000;

/** Height below which the landing lights are on: the rule is ten thousand feet. */
const LANDING_LIGHTS_FT = 10_000;

/** How many of the nearest aircraft get their own airframe and livery. */
const DETAIL_COUNT = 10;
/**
 * A detailed model is dropped only once it falls this far down the ranking,
 * so an aircraft hovering around tenth place does not flip between its own
 * model and the stand-in every other frame.
 */
const DETAIL_KEEP = DETAIL_COUNT + 4;

/** How many designators are shown at once, nearest first. */
const TARGET_COUNT = 10;
/**
 * How long an aircraft must be on screen to be designated, pixels. Under
 * this it is a speck you would not have noticed without the label.
 */
const TARGET_MIN_PX = 3.5;
/** Screen distance within which a click lands on an aircraft, pixels. */
const PICK_RADIUS_PX = 26;
/** Seconds between terrain line-of-sight checks for one aircraft. */
const OCCLUSION_REFRESH_S = 0.3;
/** Samples along the line of sight. */
const OCCLUSION_STEPS = 9;

/** Height above ground below which the undercarriage is drawn down, metres. */
const GEAR_DOWN_AGL_M = 750;

/**
 * Instances each layer can hold.
 *
 * Twelve kilometres of sky over a busy terminal area holds a few dozen
 * aircraft, not a few thousand. The buffer is sized for the worst case anyone
 * will meet rather than for the worst case that exists.
 */
const MAX_INSTANCES = 128;

/** The type whose airframe stands in for every fixed-wing aircraft. */
const FIXED_WING_STANDIN = 'B738';
/** And for every helicopter. */
const ROTORCRAFT_STANDIN = 'EC35';

/** An aircraft inside the drawing range this frame. */
interface Candidate {
  hex: string;
  /** Render-space position. */
  position: Vector3;
  distanceM: number;
  sample: SampledAircraft;
  /** Airframe length, metres. */
  size: number;
  /** Where it is drawn, metres above the ellipsoid. */
  altM: number;
}

/** An aircraft that is on screen and designated. */
export interface TrafficTarget {
  hex: string;
  sample: SampledAircraft;
  /** Render-space position. */
  position: Vector3;
  distanceM: number;
  /** Screen position, CSS pixels. */
  x: number;
  y: number;
}

/** A designator's animation, kept across frames so it can fade and lock on. */
interface Designator {
  born: number;
  alpha: number;
  x: number;
  y: number;
  r: number;
  seen: boolean;
  callsign: string;
  detail: string;
  hover: number;
}

export interface DesignatorOptions {
  /** The aircraft under the pointer. */
  hoverHex?: string | null;
  /** Altitude of the aircraft being flown, feet, for the relative height. */
  ownAltFt?: number | null;
}

/** One aircraft drawn with its own model. */
interface Detailed {
  group: Group;
  gear: Mesh[];
  /** A helicopter's rotors: turned while it flies. See `spinRotors`. */
  rotors: { mesh: Mesh; axis: Vector3; rpm: number; angle: number }[];
  /** Where its lights are fitted, once loaded. */
  anchors: LightAnchors | null;
  /** Type and operator it was built for; a change rebuilds it. */
  key: string;
  loaded: boolean;
}

export interface TrafficRenderStats {
  drawn: number;
  culled: number;
}

/** What one aircraft looks like: which layer, how long, and how it sits. */
interface Airframe {
  rotor: boolean;
  size: number;
  clearance: number;
  /** Where its lights go. */
  shape: AirframeShape;
}

/**
 * One converted model, instanced.
 *
 * Every part gets its own `InstancedMesh` and they all carry the same matrices,
 * so a fleet is a draw call per part instead of per aircraft. `count` is set
 * once per frame after the fill, because `InstancedMesh.count` is what the
 * renderer draws and leaving it at capacity draws the stale tail of the buffer.
 */
class InstancedModel {
  readonly group = new Group();
  private readonly meshes: InstancedMesh[] = [];
  count = 0;
  /** Where the stand-in's lights are fitted: they must sit on the airframe drawn. */
  readonly anchors: LightAnchors | null;

  constructor(model: LoadedModel, capacity: number) {
    this.anchors = lightAnchorsFor(model);
    for (const part of model.parts) {
      // The undercarriage is omitted rather than animated. Nothing within
      // twelve kilometres is on the ground unless you are too, and a shared
      // instance buffer cannot retract one aircraft's gear and not another's.
      if (part.role === 'gear' && !model.fixedGear) continue;

      const mesh = new InstancedMesh(part.geometry, part.material, capacity);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  setMatrixAt(index: number, matrix: Matrix4): void {
    for (const mesh of this.meshes) mesh.setMatrixAt(index, matrix);
  }

  commit(): void {
    for (const mesh of this.meshes) {
      mesh.count = this.count;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
    // Geometries and materials belong to the shared model cache, which the
    // aircraft you are riding is very likely using as well.
    this.meshes.length = 0;
  }
}

export class Traffic3D {
  readonly scene = new Scene();
  /** Every aircraft's lights, the one being ridden included (see `OwnAircraft`). */
  readonly lights = new AircraftLights();
  /** The trails behind the cruising traffic, the one being ridden included. */
  readonly contrails: Contrails;
  /** To put a detailed airframe on the GPU before it replaces the stand-in (see `prewarm`). */
  warm: { renderer: WebGLRenderer; scene: Scene } | null = null;

  private fixedWing: InstancedModel | null = null;
  private rotorcraft: InstancedModel | null = null;
  /** For turning nearby helicopters' rotors: the last update, and the frame time smoothed. */
  private lastUpdateMs = 0;
  private frameSec = 1 / 60;
  private disposed = false;

  private readonly dummy = new Object3D();
  private readonly basis = new Matrix4();
  private readonly quaternion = new Quaternion();
  private readonly airframes = new Map<string, Airframe>();
  private stats: TrafficRenderStats = { drawn: 0, culled: 0 };

  private readonly detailed = new Map<string, Detailed>();
  /** Everything in drawing range this frame, nearest first. */
  private candidates: Candidate[] = [];
  /** A pool, so the per-frame candidate list does not allocate. */
  private readonly candidatePool: Candidate[] = [];
  /** What was designated on the last drawn frame. `pick` reads this. */
  private visible: TrafficTarget[] = [];
  private readonly designators = new Map<string, Designator>();
  /** Line-of-sight verdicts, refreshed a few times a second each. */
  private readonly occlusion = new Map<string, { at: number; hidden: boolean }>();
  private readonly cameraRender = new Vector3();

  constructor(private readonly origin: FloatingOrigin) {
    this.scene.matrixAutoUpdate = false;
    this.scene.add(this.lights.points);
    this.contrails = new Contrails(origin);
    this.scene.add(this.contrails.mesh);

    /*
     * Nothing is drawn until the airframes arrive, and that is deliberate.
     *
     * The alternative is to draw the procedural model in the meantime, which
     * is exactly the crude silhouette this replaced — shown briefly, at the
     * only ranges where crude is most obvious. An empty sky for a second is
     * the better wrong answer.
     */
    void this.adopt(FIXED_WING_STANDIN, (layer) => (this.fixedWing = layer));
    void this.adopt(ROTORCRAFT_STANDIN, (layer) => (this.rotorcraft = layer));
  }

  private async adopt(typeCode: string, assign: (layer: InstancedModel) => void): Promise<void> {
    const model = await loadModelFor(typeCode);
    if (this.disposed || !model) return;

    const layer = new InstancedModel(model, MAX_INSTANCES);
    assign(layer);
    this.scene.add(layer.group);
  }

  getStats(): Readonly<TrafficRenderStats> {
    return this.stats;
  }

  /**
   * `cameraEcef` drives the range gate; `excludeHex` drops the aircraft the
   * camera is riding in, which would otherwise fill the cockpit view with its
   * own fuselage. `terrainHeightAt` stops aircraft on the ground being drawn
   * *under* it — see `@/render/ground`.
   */
  update(
    samples: readonly SampledAircraft[],
    cameraEcef: Vector3,
    excludeHex: string | null,
    terrainHeightAt?: (lat: number, lon: number) => number,
  ): void {
    this.cameraRender.copy(cameraEcef);
    const nowMs = performance.now();
    const stepSec = this.lastUpdateMs > 0 ? Math.min(0.25, (nowMs - this.lastUpdateMs) / 1000) : 0;
    this.lastUpdateMs = nowMs;
    if (stepSec > 0) this.frameSec += (stepSec - this.frameSec) * 0.05;
    const frameSec = stepSec;
    this.lights.begin();
    const farLightsSq = this.lights.night > 0.05 ? LIGHTS_RANGE_M * LIGHTS_RANGE_M : 0;
    if (this.fixedWing) this.fixedWing.count = 0;
    if (this.rotorcraft) this.rotorcraft.count = 0;
    let culled = 0;

    // First pass: keep what is in range. A cheap squared-distance gate runs
    // before the terrain sample and the frame. A little margin, because the
    // ground clamp below can move an aircraft by a few hundred metres.
    const inRange: Candidate[] = [];
    let pooled = 0;
    const gate = MAX_RANGE_M + 1000;
    const gateSq = gate * gate;

    for (const sample of samples) {
      if (sample.hex === excludeHex) continue;
      // Ground vehicles and fixed obstacles share the feed with the traffic.
      // They are not aircraft and drawing them put a 40 m airliner on every
      // taxiway of every field the camera passed.
      if (isSurfaceVehicle(sample.latest.category)) continue;

      const ecef = geodeticToEcef(sample.lat, sample.lon, sample.altFt * FEET_TO_METRES);
      const dx = ecef[0] - this.origin.current[0] - cameraEcef.x;
      const dy = ecef[1] - this.origin.current[1] - cameraEcef.y;
      const dz = ecef[2] - this.origin.current[2] - cameraEcef.z;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq > gateSq) {
        culled++;
        // Too far to draw, near enough to see its lights by night.
        if (dSq < farLightsSq) this.addFarLights(sample, ecef);
        continue;
      }

      let c = this.candidatePool[pooled];
      if (!c) {
        c = { hex: '', position: new Vector3(), distanceM: 0, sample, size: 0, altM: 0 };
        this.candidatePool.push(c);
      }
      pooled++;
      c.hex = sample.hex;
      c.sample = sample;
      c.distanceM = Math.sqrt(dSq);
      inRange.push(c);
    }

    inRange.sort((p, q) => p.distanceM - q.distanceM);

    // Second pass, nearest first: place, and draw what is close enough.
    const wanted = new Set<string>();
    const drawn: Candidate[] = [];
    let detailRank = 0;
    for (const c of inRange) {
      const sample = c.sample;
      const airframe = this.classify(sample);

      let altM = sample.altFt * FEET_TO_METRES;
      let aglM = Number.POSITIVE_INFINITY;
      // Only the aircraft that could possibly be inside the terrain pay for a
      // terrain sample; the quadtree walk is not free and a cruising airliner
      // can never change its own answer.
      if (terrainHeightAt && (sample.latest.onGround || altM < GROUND_CHECK_CEILING_M)) {
        const ground = terrainHeightAt(sample.lat, sample.lon);
        altM = surfaceAltitudeM(altM, sample.latest.onGround, ground, airframe.clearance);
        if (Number.isFinite(ground)) aglM = altM - ground;
      }
      const ecef = geodeticToEcef(sample.lat, sample.lon, altM);
      c.position.set(
        ecef[0] - this.origin.current[0],
        ecef[1] - this.origin.current[1],
        ecef[2] - this.origin.current[2],
      );
      c.distanceM = c.position.distanceTo(cameraEcef);
      if (c.distanceM > MAX_RANGE_M) continue;
      c.size = airframe.size;
      c.altM = altM;
      drawn.push(c);

      // Orientation from the same body frame the camera uses, so a banking
      // aircraft seen from outside banks correctly.
      const frame = aircraftFrame(sample, altM);
      this.dummy.position.copy(c.position);
      // Model is nose-along-+Y, up-along-+Z: map to forward/up/right.
      this.basis.makeBasis(frame.right, frame.forward, frame.up);
      this.quaternion.setFromRotationMatrix(this.basis);
      this.dummy.quaternion.copy(this.quaternion);
      // True scale, always. The converted models are normalised to unit
      // length, so this is the aircraft's own length in metres and nothing
      // else — no floor, no ramp, no chart symbol.
      this.dummy.scale.setScalar(airframe.size);
      this.dummy.updateMatrix();
      const landing = sample.altFt < LANDING_LIGHTS_FT;
      const layer = airframe.rotor ? this.rotorcraft : this.fixedWing;

      const type = registry.knownTypeCode(sample.hex);
      if (type && detailRank < DETAIL_KEEP) {
        const rank = detailRank++;
        const d = rank < DETAIL_COUNT ? this.ensureDetailed(sample, type) : this.detailed.get(sample.hex);
        if (d) {
          wanted.add(sample.hex);
          if (d.loaded) {
            this.lights.add(this.dummy.matrix, airframe.shape, lightSeed(sample.hex), landing, d.anchors);
            d.group.visible = true;
            d.group.matrix.copy(this.dummy.matrix);
            d.group.matrixWorldNeedsUpdate = true;
            const gearDown = sample.latest.onGround === true || aglM < GEAR_DOWN_AGL_M;
            for (const g of d.gear) g.visible = gearDown;
            // A helicopter on the pad may well be shut down; one in the air never is.
            if (d.rotors.length > 0 && sample.latest.onGround !== true) this.spinRotors(d, frameSec);
            continue;
          }
        }
      }

      if (!layer || layer.count >= MAX_INSTANCES) continue;
      this.lights.add(this.dummy.matrix, airframe.shape, lightSeed(sample.hex), landing, layer.anchors);
      layer.setMatrixAt(layer.count, this.dummy.matrix);
      layer.count++;
    }

    // Detailed models that fell out of the ranking or out of range.
    for (const [hex, d] of this.detailed) {
      if (wanted.has(hex)) continue;
      this.scene.remove(d.group);
      this.detailed.delete(hex);
    }

    this.candidates = drawn;
    this.refreshOcclusion(terrainHeightAt);

    this.fixedWing?.commit();
    this.rotorcraft?.commit();

    let detailedDrawn = 0;
    for (const d of this.detailed.values()) if (d.loaded && d.group.visible) detailedDrawn++;
    this.stats = {
      drawn: (this.fixedWing?.count ?? 0) + (this.rotorcraft?.count ?? 0) + detailedDrawn,
      culled,
    };
  }

  /**
   * The detailed model for an aircraft, created on first request.
   *
   * Returns the entry at once; it draws only once its model has arrived, and
   * until then the stand-in keeps the aircraft on screen. Rebuilt when the
   * type or the operator changes — the registry can fill a type in late.
   */
  private ensureDetailed(sample: SampledAircraft, type: string): Detailed | null {
    const operator = operatorOf(sample.latest.callsign);
    const key = `${type}|${operator ?? ''}`;
    const existing = this.detailed.get(sample.hex);
    if (existing && existing.key === key) return existing;
    if (existing) this.scene.remove(existing.group);

    const group = new Group();
    group.matrixAutoUpdate = false;
    group.visible = false;
    const entry: Detailed = { group, gear: [], rotors: [], anchors: null, key, loaded: false };
    this.detailed.set(sample.hex, entry);
    this.scene.add(group);

    void loadModelFor(type, operator, sample.latest.category).then(async (model) => {
      // Superseded, dropped, or disposed while downloading.
      if (!model || this.disposed || this.detailed.get(sample.hex) !== entry) return;
      entry.anchors = lightAnchorsFor(model);
      for (const part of model.parts) {
        const mesh = new Mesh(part.geometry, part.material);
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;
        if (part.role !== 'hull' && part.role !== 'gear') {
          mesh.position.set(part.origin[0], part.origin[1], part.origin[2]);
          mesh.updateMatrix();
        }
        // Blur discs belong to a spinning propeller; these propellers do not
        // spin, and a translucent disc on a still blade reads as a smudge.
        if (part.role === 'disc') continue;
        if (part.role === 'gear' && !model.fixedGear) entry.gear.push(mesh);
        if (part.role === 'mainRotor' || part.role === 'tailRotor') {
          const main = rotorRpm(shapeFor(type, sample.latest.category));
          entry.rotors.push({
            mesh,
            axis: new Vector3(part.axis[0], part.axis[1], part.axis[2]).normalize(),
            // Geared off the main rotor, as on the aircraft being flown.
            rpm: part.role === 'mainRotor' ? main : main * 5.2,
            angle: Math.random() * Math.PI * 2,
          });
        }
        group.add(mesh);
      }
      // The stand-in keeps the aircraft on screen until its own airframe is
      // on the GPU; a livery arriving is otherwise a frozen frame.
      if (this.warm) await prewarm(this.warm.renderer, group, this.warm.scene);
      entry.loaded = true;
    });
    return entry;
  }

  /**
   * Turn a nearby helicopter's rotors.
   *
   * A stand-in rotorcraft in the instanced layer cannot have its own rotor
   * angle, but the few drawn with their own model can, and those are the ones
   * close enough to see the blades: stationary blades on a helicopter in
   * flight read as an autorotation, or a failure.
   */
  private spinRotors(d: Detailed, stepSec: number): void {
    for (const r of d.rotors) {
      r.angle = (r.angle + visibleSpinRate(r.rpm, this.frameSec) * Math.PI * 2 * stepSec) % (Math.PI * 2);
      r.mesh.quaternion.setFromAxisAngle(r.axis, r.angle);
      r.mesh.updateMatrix();
    }
  }

  /**
   * Decide which aircraft cannot be seen because the ground is in the way.
   *
   * A handful of terrain samples along the line of sight, each a few times a
   * second per aircraft rather than every frame: a hill does not move, and
   * neither aircraft gets far in a third of a second. Unknown terrain never
   * hides anything — a missing tile is not a mountain.
   */
  private refreshOcclusion(heightAt?: (lat: number, lon: number) => number): void {
    const now = performance.now() / 1000;
    const o = this.origin.current;
    const cam = this.cameraRender;
    const live = new Set<string>();
    for (const c of this.candidates) {
      live.add(c.hex);
      if (!heightAt) continue;
      const known = this.occlusion.get(c.hex);
      if (known && now - known.at < OCCLUSION_REFRESH_S) continue;
      let blocked = false;
      for (let i = 1; i < OCCLUSION_STEPS && !blocked; i++) {
        const t = i / OCCLUSION_STEPS;
        const g = ecefToGeodetic(
          cam.x + (c.position.x - cam.x) * t + o[0],
          cam.y + (c.position.y - cam.y) * t + o[1],
          cam.z + (c.position.z - cam.z) * t + o[2],
        );
        const ground = heightAt(g.lat, g.lon);
        if (Number.isFinite(ground) && g.height < ground) blocked = true;
      }
      // Spread the refreshes out, so a dozen aircraft that entered range on
      // the same frame do not all re-check on the same later frame.
      this.occlusion.set(c.hex, { at: now + Math.random() * 0.1, hidden: blocked });
    }
    for (const hex of this.occlusion.keys()) if (!live.has(hex)) this.occlusion.delete(hex);
  }

  /** Everything drawn this frame, nearest first. For the cockpit's radar. */
  get inRange(): readonly { hex: string; position: Vector3; distanceM: number; sample: SampledAircraft }[] {
    return this.candidates;
  }

  /**
   * The designated aircraft nearest a point on screen, or null.
   *
   * Screen space rather than a ray: most targets are a few pixels across, and
   * what someone clicks is the designator and its label, not the fuselage.
   */
  pick(x: number, y: number): string | null {
    let best: string | null = null;
    let bestD = PICK_RADIUS_PX;
    for (const t of this.visible) {
      const d = this.designators.get(t.hex);
      const r = d?.r ?? 10;
      // The label up and to the right of the brackets is part of the target.
      const onLabel = x > t.x + r && x < t.x + r + 170 && y > t.y - r - 30 && y < t.y - r + 12;
      const dist = onLabel ? 0 : Math.max(0, Math.hypot(x - t.x, y - t.y) - r);
      if (dist < bestD) {
        bestD = dist;
        best = t.hex;
      }
    }
    return best;
  }

  /**
   * Target designators on the aircraft that can be seen, over the view.
   *
   * Brackets sized to the aircraft on screen, a leader to a small card with
   * the callsign, type, distance and relative height. Each one locks on when
   * it appears — the brackets close in from wide and turn square — and fades
   * out rather than vanishing. Hovered, it turns amber (the colour of
   * anything actionable) and says what a click will do.
   */
  drawLabels(frame: OverlayFrame, camera: PerspectiveCamera, options: DesignatorOptions = {}): void {
    const { ctx, width, height, palette, time } = frame;
    const radPerPx = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, height);
    const visible: TrafficTarget[] = [];

    for (const d of this.designators.values()) d.seen = false;

    for (const c of this.candidates) {
      if (visible.length >= TARGET_COUNT) break;
      if (this.occlusion.get(c.hex)?.hidden) continue;
      const lengthPx = c.size / Math.max(1, c.distanceM * radPerPx);
      if (lengthPx < TARGET_MIN_PX) continue;
      const p = this.project(c.position, camera, width, height);
      if (!p) continue;

      visible.push({ hex: c.hex, sample: c.sample, position: c.position, distanceM: c.distanceM, x: p.x, y: p.y });

      let d = this.designators.get(c.hex);
      if (!d) {
        d = { born: time, alpha: 0, x: p.x, y: p.y, r: 10, seen: true, callsign: '', detail: '', hover: 0 };
        this.designators.set(c.hex, d);
      }
      d.seen = true;
      d.x = p.x;
      d.y = p.y;
      d.r = Math.min(64, Math.max(10, lengthPx * 0.62));
      d.callsign = c.sample.latest.callsign?.trim() || c.hex.toUpperCase();
      d.detail = this.detailFor(c, options.ownAltFt ?? null);
    }
    this.visible = visible;

    for (const [hex, d] of this.designators) {
      // Fade in fast, out a little slower, so a designator that loses its
      // aircraft behind a ridge does not blink.
      d.alpha = d.seen ? Math.min(1, d.alpha + 0.12) : d.alpha - 0.08;
      const hovering = hex === options.hoverHex && d.seen;
      d.hover += ((hovering ? 1 : 0) - d.hover) * 0.25;
      if (d.alpha <= 0) {
        this.designators.delete(hex);
        continue;
      }
      frame.drew = true;
      this.drawDesignator(ctx, palette, d, time);
    }
    ctx.globalAlpha = 1;
  }

  private detailFor(c: Candidate, ownAltFt: number | null): string {
    const type = registry.knownTypeCode(c.hex);
    const km = c.distanceM / 1000;
    const parts = [type, `${km < 10 ? km.toFixed(1) : Math.round(km)} km`];
    if (ownAltFt !== null) {
      const diff = Math.round((c.sample.altFt - ownAltFt) / 100) * 100;
      if (Math.abs(diff) >= 100) parts.push(`${diff > 0 ? '▲' : '▼'}${Math.abs(diff).toLocaleString('en')} ft`);
      else parts.push('level');
    }
    return parts.filter(Boolean).join(' · ');
  }

  private drawDesignator(
    ctx: CanvasRenderingContext2D,
    palette: OverlayPalette,
    d: Designator,
    time: number,
  ): void {
    const age = time - d.born;
    // Lock-on: close in from twice the size and a quarter turn, with a
    // little overshoot so it lands rather than stops.
    const t = Math.min(1, age / 0.42);
    const settle = 1 - Math.pow(1 - t, 3);
    const back = settle + Math.sin(t * Math.PI) * 0.08;
    const scale = 1 + (1 - back) * 1.3;
    const spin = (1 - settle) * (Math.PI / 4);
    const hover = d.hover;
    const color = hover > 0.5 ? palette.warm : palette.accent;
    const r = d.r * scale * (1 + hover * 0.18);
    const k = Math.max(4, r * 0.42);

    ctx.globalAlpha = d.alpha;
    ctx.save();
    ctx.translate(d.x, d.y);

    // Brackets, with a dark or light underlay so they read on cloud and sea.
    ctx.rotate(spin);
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'square';
    for (const [stroke, width] of [
      [palette.halo, 3.6],
      [color, 1.6 + hover * 0.5],
    ] as const) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        ctx.moveTo(sx * r, sy * (r - k));
        ctx.lineTo(sx * r, sy * r);
        ctx.lineTo(sx * (r - k), sy * r);
      }
      ctx.stroke();
    }
    ctx.rotate(-spin);

    // Hover: a turning dashed ring.
    if (hover > 0.05) {
      ctx.globalAlpha = d.alpha * hover;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 5]);
      ctx.lineDashOffset = -time * 24;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.45, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = d.alpha;
    }

    // Leader and card, up and to the right.
    const lx = r + 4;
    const ly = -r - 4;
    const cardX = lx + 12;
    const cardY = ly - 12;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = d.alpha * 0.85;
    ctx.beginPath();
    ctx.moveTo(r * 0.72, -r * 0.72);
    ctx.lineTo(lx + 8, ly - 8);
    ctx.lineTo(cardX, ly - 8);
    ctx.stroke();
    ctx.globalAlpha = d.alpha;

    ctx.textBaseline = 'middle';
    ctx.font = `700 12px ui-monospace, "SF Mono", Menlo, monospace`;
    const titleW = ctx.measureText(d.callsign).width;
    ctx.font = `500 10px ui-monospace, "SF Mono", Menlo, monospace`;
    const detailW = ctx.measureText(d.detail).width;
    const actionText = 'CLICK TO FLY ›';
    const showAction = hover > 0.05;
    const actionW = showAction ? ctx.measureText(actionText).width : 0;
    const w = Math.max(titleW, detailW, actionW) + 16;
    const h = showAction ? 50 : 34;
    const notch = 6;

    // A small console card: notched corner, accent rule down the left.
    ctx.fillStyle = palette.bg;
    ctx.beginPath();
    ctx.moveTo(cardX, cardY - 5);
    ctx.lineTo(cardX + w - notch, cardY - 5);
    ctx.lineTo(cardX + w, cardY - 5 + notch);
    ctx.lineTo(cardX + w, cardY - 5 + h);
    ctx.lineTo(cardX, cardY - 5 + h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(cardX, cardY - 5, 2, h);

    ctx.font = `700 12px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillStyle = hover > 0.5 ? color : palette.text;
    ctx.fillText(d.callsign, cardX + 9, cardY + 5);
    ctx.font = `500 10px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillStyle = palette.dim;
    ctx.fillText(d.detail, cardX + 9, cardY + 20);
    if (showAction) {
      ctx.globalAlpha = d.alpha * hover;
      ctx.fillStyle = color;
      ctx.fillText(actionText, cardX + 9, cardY + 36);
    }

    ctx.restore();
  }

  private readonly projected = new Vector3();

  private project(
    position: Vector3,
    camera: PerspectiveCamera,
    width: number,
    height: number,
  ): { x: number; y: number } | null {
    const v = this.projected.copy(position).project(camera);
    if (v.z > 1 || v.x < -1.02 || v.x > 1.02 || v.y < -1.02 || v.y > 1.02) return null;
    return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height };
  }

  /**
   * Which silhouette, and how big.
   *
   * Both answers come from `shapeFor`, so a helicopter is never drawn with an
   * airliner's length and this layer cannot disagree with the model
   * `OwnAircraft` builds for the same type. The old code answered the two
   * separately and sized from the emitter category alone, a five-bucket guess:
   * a Phenom 300 and a Cessna 152 are both `A1`.
   *
   * ## What is cached and what is not
   *
   * A verdict from a **type code** is final and memoised: type does not change
   * mid-flight, and a thousand aircraft at 60 fps is otherwise 120 000 registry
   * lookups a second.
   *
   * A verdict from the **category alone** is deliberately *not* cached. The
   * registry fills in asynchronously, so remembering the provisional answer is
   * what froze an aircraft into the wrong shape for the session — a helicopter
   * broadcasting `A1` stayed a jet for ever. Re-deriving costs one allocation
   * for the few per cent with no type code yet, and upgrades the instant the
   * lookup lands.
   */
  /** An aircraft beyond the drawing range: its lights only, at its reported position. */
  private addFarLights(sample: SampledAircraft, ecef: readonly [number, number, number]): void {
    const airframe = this.classify(sample);
    const altM = sample.altFt * FEET_TO_METRES;
    const frame = aircraftFrame(sample, altM);
    this.dummy.position.set(ecef[0] - this.origin.current[0], ecef[1] - this.origin.current[1], ecef[2] - this.origin.current[2]);
    this.basis.makeBasis(frame.right, frame.forward, frame.up);
    this.dummy.quaternion.setFromRotationMatrix(this.basis);
    this.dummy.scale.setScalar(airframe.size);
    this.dummy.updateMatrix();
    const layer = airframe.rotor ? this.rotorcraft : this.fixedWing;
    this.lights.add(this.dummy.matrix, airframe.shape, lightSeed(sample.hex), sample.altFt < LANDING_LIGHTS_FT, layer?.anchors ?? null);
  }

  /** An aircraft's airframe, from its type where known. */
  shapeOf(sample: SampledAircraft): AirframeShape {
    return this.classify(sample).shape;
  }

  private classify(sample: SampledAircraft): Airframe {
    const memo = this.airframes.get(sample.hex);
    if (memo) return memo;

    const type = registry.knownTypeCode(sample.hex);
    const shape = shapeFor(type, sample.latest.category ?? null);
    const airframe: Airframe = {
      rotor: shape.kind === 'rotorcraft',
      size: shape.length,
      clearance: clearanceFor(shape),
      shape,
    };

    if (type) {
      // Traffic churns over a long session and nothing here ever expires, so
      // the map is bounded rather than pruned: re-deriving a few hundred
      // verdicts costs one frame's worth of lookups, once.
      if (this.airframes.size > 20_000) this.airframes.clear();
      this.airframes.set(sample.hex, airframe);
    }
    return airframe;
  }

  dispose(): void {
    this.disposed = true;
    this.airframes.clear();
    this.designators.clear();
    this.occlusion.clear();
    for (const d of this.detailed.values()) this.scene.remove(d.group);
    this.detailed.clear();
    this.fixedWing?.dispose();
    this.rotorcraft?.dispose();
    this.lights.dispose();
    this.contrails.dispose();
  }
}
