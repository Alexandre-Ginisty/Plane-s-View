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
 */

import {
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Object3D,
  Quaternion,
  Scene,
  Vector3,
} from 'three';
import { FEET_TO_METRES, geodeticToEcef } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import type { SampledAircraft } from '@/state/traffic';
import { registry } from '@/data/meta/registry';
import { isSurfaceVehicle, shapeFor } from './aircraft';
import { loadModelFor } from './aircraft/library';
import type { LoadedModel } from './aircraft/pvm';
import { GROUND_CHECK_CEILING_M, clearanceFor, surfaceAltitudeM } from './ground';
import { aircraftFrame } from './pov';

/**
 * How close an aircraft has to be to be drawn at all, metres.
 *
 * Twelve kilometres. At that range a 60 m airliner subtends about 1.2 screen
 * pixels — the point at which it stops being an aeroplane and becomes a mark,
 * and the point this deliberately stops drawing. Inside it the model grows the
 * way a real one does, and a genuine close pass fills the window.
 *
 * It is not a performance number. Drawing to 120 km cost almost nothing; what
 * it cost was the look of the sky.
 */
const MAX_RANGE_M = 12_000;

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

export interface TrafficRenderStats {
  drawn: number;
  culled: number;
}

/** What one aircraft looks like: which layer, how long, and how it sits. */
interface Airframe {
  rotor: boolean;
  size: number;
  clearance: number;
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

  constructor(model: LoadedModel, capacity: number) {
    for (const part of model.parts) {
      // The undercarriage is omitted rather than animated. Nothing within
      // twelve kilometres is on the ground unless you are too, and a shared
      // instance buffer cannot retract one aircraft's gear and not another's.
      if (part.role === 'gear') continue;

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

  private fixedWing: InstancedModel | null = null;
  private rotorcraft: InstancedModel | null = null;
  private disposed = false;

  private readonly dummy = new Object3D();
  private readonly basis = new Matrix4();
  private readonly quaternion = new Quaternion();
  private readonly position = new Vector3();
  private readonly airframes = new Map<string, Airframe>();
  private stats: TrafficRenderStats = { drawn: 0, culled: 0 };

  constructor(private readonly origin: FloatingOrigin) {
    this.scene.matrixAutoUpdate = false;

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
    if (this.fixedWing) this.fixedWing.count = 0;
    if (this.rotorcraft) this.rotorcraft.count = 0;
    let culled = 0;

    for (const sample of samples) {
      if (sample.hex === excludeHex) continue;
      // Ground vehicles and fixed obstacles share the feed with the traffic.
      // They are not aircraft and drawing them put a 40 m airliner on every
      // taxiway of every field the camera passed.
      if (isSurfaceVehicle(sample.latest.category)) continue;

      const airframe = this.classify(sample);
      const layer = airframe.rotor ? this.rotorcraft : this.fixedWing;
      if (!layer || layer.count >= MAX_INSTANCES) continue;

      let altM = sample.altFt * FEET_TO_METRES;
      // Only the aircraft that could possibly be inside the terrain pay for a
      // terrain sample; the quadtree walk is not free and a cruising airliner
      // can never change its own answer.
      if (terrainHeightAt && (sample.latest.onGround || altM < GROUND_CHECK_CEILING_M)) {
        altM = surfaceAltitudeM(
          altM,
          sample.latest.onGround,
          terrainHeightAt(sample.lat, sample.lon),
          airframe.clearance,
        );
      }
      const ecef = geodeticToEcef(sample.lat, sample.lon, altM);

      this.position.set(
        ecef[0] - this.origin.current[0],
        ecef[1] - this.origin.current[1],
        ecef[2] - this.origin.current[2],
      );

      if (this.position.distanceTo(cameraEcef) > MAX_RANGE_M) {
        culled++;
        continue;
      }

      // Orientation from the same body frame the camera uses, so a banking
      // aircraft seen from outside banks correctly.
      const frame = aircraftFrame(sample, altM);
      this.dummy.position.copy(this.position);

      // Model is nose-along-+Y, up-along-+Z: map to forward/up/right.
      this.basis.makeBasis(frame.right, frame.forward, frame.up);
      this.quaternion.setFromRotationMatrix(this.basis);
      this.dummy.quaternion.copy(this.quaternion);

      // True scale, always. The converted models are normalised to unit
      // length, so this is the aircraft's own length in metres and nothing
      // else — no floor, no ramp, no chart symbol.
      this.dummy.scale.setScalar(airframe.size);
      this.dummy.updateMatrix();

      layer.setMatrixAt(layer.count, this.dummy.matrix);
      layer.count++;
    }

    this.fixedWing?.commit();
    this.rotorcraft?.commit();

    this.stats = {
      drawn: (this.fixedWing?.count ?? 0) + (this.rotorcraft?.count ?? 0),
      culled,
    };
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
  private classify(sample: SampledAircraft): Airframe {
    const memo = this.airframes.get(sample.hex);
    if (memo) return memo;

    const type = registry.knownTypeCode(sample.hex);
    const shape = shapeFor(type, sample.latest.category ?? null);
    const airframe: Airframe = {
      rotor: shape.kind === 'rotorcraft',
      size: shape.length,
      clearance: clearanceFor(shape),
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
    this.fixedWing?.dispose();
    this.rotorcraft?.dispose();
  }
}
