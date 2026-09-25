/**
 * Other aircraft, drawn in the 3D view.
 *
 * One `InstancedMesh` holds every visible aircraft. The alternative — a `Mesh`
 * each — costs a draw call and a matrix upload per aircraft, and with a
 * thousand of them in view that alone misses the frame budget. Here the whole
 * fleet is one draw call and one matrix buffer written in place.
 *
 * Instances are also *scaled with distance*: at 40 km a real 60 m airliner is
 * well under a pixel and would simply vanish. Below a threshold the model is
 * inflated so it stays a readable mark, in the same way a chart symbol is not
 * drawn to scale. Above it, true size takes over and the transition is
 * continuous, so an aircraft you are approaching never visibly changes size.
 */

import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Scene,
  Vector3,
} from 'three';
import { FEET_TO_METRES, geodeticToEcef } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import type { SampledAircraft } from '@/state/traffic';
import { registry } from '@/data/meta/registry';
import {
  colorFor,
  createAircraftMarkerGeometry,
  createRotorcraftMarkerGeometry,
} from './traffic/markers';
import { isSurfaceVehicle, shapeFor } from './aircraft';
import { GROUND_CHECK_CEILING_M, clearanceFor, surfaceAltitudeM } from './ground';
import { aircraftFrame } from './pov';

const MAX_INSTANCES = 2000;

/**
 * Rotorcraft are a small fraction of any traffic picture, and they fly low and
 * slow, so far fewer are ever inside the 120 km range gate at once. A separate,
 * smaller buffer costs a few hundred kB less than mirroring the full capacity.
 */
const MAX_ROTOR_INSTANCES = 256;

/** Beyond this, aircraft are not drawn in 3D at all. */
const MAX_RANGE_M = 120_000;

/**
 * Smallest on-screen length, in pixels, an aircraft is allowed to shrink to.
 * A 60 m airliner at 40 km subtends about 1.5 px at a typical field of view —
 * legible as a dot only by accident. Holding a floor of ~11 px keeps it a
 * readable mark without ever making a nearby aircraft look wrong.
 */
const MIN_SCREEN_PX = 11;

/** What one aircraft looks like: which instance layer, and how long it is. */
interface Airframe {
  rotor: boolean;
  /** Overall length in metres, from the type's own shape. */
  size: number;
  /** How far the model's origin sits above the ground when parked, metres. */
  clearance: number;
}

export interface TrafficRenderStats {
  drawn: number;
  culled: number;
}

/**
 * One instanced mesh and its fill cursor.
 *
 * Two of these, because a helicopter and an airliner cannot share a geometry
 * and `InstancedMesh` cannot switch geometry per instance. The cost is one
 * extra draw call for the entire rotorcraft fleet, which is nothing next to
 * every helicopter on screen reading as a jet.
 */
class InstanceLayer {
  readonly mesh: InstancedMesh;
  count = 0;

  constructor(geometry: BufferGeometry, material: MeshBasicMaterial, capacity: number) {
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  commit(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

export class Traffic3D {
  readonly scene = new Scene();

  private readonly material = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  private readonly fixedWing: InstanceLayer;
  private readonly rotorcraft: InstanceLayer;

  private readonly quaternion = new Quaternion();
  private readonly position = new Vector3();
  private readonly color = new Color();
  private readonly dummy = new Object3D();
  /**
   * Scratch basis, reused. This used to be `new Matrix4()` inside the
   * per-aircraft loop — sixty thousand throwaway matrices a second for the
   * collector to walk. Not a frame-time spike but a periodic multi-millisecond
   * GC pause, which in a first-person view is the stutter that makes the whole
   * thing feel cheap.
   */
  private readonly basis = new Matrix4();

  /** Settled silhouette verdicts, keyed by hex. See `classify`. */
  private readonly airframes = new Map<string, Airframe>();

  private stats: TrafficRenderStats = { drawn: 0, culled: 0 };

  constructor(private readonly origin: FloatingOrigin) {
    this.fixedWing = new InstanceLayer(createAircraftMarkerGeometry(), this.material, MAX_INSTANCES);
    this.rotorcraft = new InstanceLayer(
      createRotorcraftMarkerGeometry(),
      this.material,
      MAX_ROTOR_INSTANCES,
    );

    this.scene.add(this.fixedWing.mesh);
    this.scene.add(this.rotorcraft.mesh);
    this.scene.matrixAutoUpdate = false;
  }

  getStats(): Readonly<TrafficRenderStats> {
    return this.stats;
  }

  /**
   * `cameraEcef` drives range culling and the apparent-size ramp; `excludeHex`
   * drops the aircraft the camera is riding in, which would otherwise fill the
   * cockpit view with its own fuselage. `terrainHeightAt` stops aircraft on the
   * ground being drawn *under* it (see `@/render/ground`), and is optional so
   * the layer still works before the globe exists.
   */
  update(
    samples: readonly SampledAircraft[],
    cameraEcef: Vector3,
    radiansPerPixel: number,
    excludeHex: string | null,
    terrainHeightAt?: (lat: number, lon: number) => number,
  ): void {
    this.fixedWing.count = 0;
    this.rotorcraft.count = 0;
    let culled = 0;

    for (const sample of samples) {
      if (sample.hex === excludeHex) continue;
      // Ground vehicles and fixed obstacles share the feed with the traffic.
      // They are not aircraft and drawing them put a 40 m airliner on every
      // taxiway of every field the camera passed.
      if (isSurfaceVehicle(sample.latest.category)) continue;

      const airframe = this.classify(sample);
      const layer = airframe.rotor ? this.rotorcraft : this.fixedWing;
      if (layer.count >= layer.mesh.instanceMatrix.count) continue;

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

      const distance = this.position.distanceTo(cameraEcef);
      if (distance > MAX_RANGE_M) {
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

      // Apparent-size floor. An object of length L at range d subtends
      // L / d radians, and one pixel is `radiansPerPixel`, so holding
      // MIN_SCREEN_PX pixels needs L >= MIN_SCREEN_PX * radiansPerPixel * d.
      // Taking the max with true size means close aircraft are never inflated,
      // and the two regimes meet continuously — no visible pop as you close in.
      const trueSize = airframe.size;
      const floorSize = MIN_SCREEN_PX * radiansPerPixel * distance;
      const size = Math.max(trueSize, Math.min(floorSize, trueSize * 80));

      this.dummy.scale.setScalar(size);
      this.dummy.updateMatrix();

      layer.mesh.setMatrixAt(layer.count, this.dummy.matrix);
      layer.mesh.setColorAt(layer.count, colorFor(sample, this.color));
      layer.count++;
    }

    this.fixedWing.commit();
    this.rotorcraft.commit();

    this.stats = { drawn: this.fixedWing.count + this.rotorcraft.count, culled };
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
    this.airframes.clear();
    this.fixedWing.dispose();
    this.rotorcraft.dispose();
    this.material.dispose();
  }
}
