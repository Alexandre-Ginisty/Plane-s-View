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
import { isRotorcraftType } from './aircraft';
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
   * Scratch basis, reused.
   *
   * This used to be `new Matrix4()` inside the per-aircraft loop — a thousand
   * throwaway matrices every frame, sixty thousand a second, all of which the
   * garbage collector has to walk. It never showed up as a frame-time spike
   * because it is not one: it shows up as a periodic multi-millisecond GC
   * pause, which in a first-person view is exactly the stutter that makes the
   * whole thing feel cheap.
   */
  private readonly basis = new Matrix4();

  /** Settled rotorcraft verdicts, keyed by hex. See `isRotorcraft`. */
  private readonly rotorcraftByHex = new Map<string, boolean>();

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
   * Rebuild the instance buffers.
   *
   * `cameraEcef` is used for range culling and for the apparent-size ramp;
   * `excludeHex` drops the aircraft the camera is riding in, which would
   * otherwise fill the cockpit view with its own fuselage.
   */
  update(
    samples: readonly SampledAircraft[],
    cameraEcef: Vector3,
    radiansPerPixel: number,
    excludeHex: string | null,
  ): void {
    this.fixedWing.count = 0;
    this.rotorcraft.count = 0;
    let culled = 0;

    for (const sample of samples) {
      if (sample.hex === excludeHex) continue;

      const rotor = this.isRotorcraft(sample);
      const layer = rotor ? this.rotorcraft : this.fixedWing;
      if (layer.count >= layer.mesh.instanceMatrix.count) continue;

      const altM = sample.altFt * FEET_TO_METRES;
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
      const frame = aircraftFrame(sample);
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
      const trueSize = this.sizeOf(sample);
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
   * Helicopter or not.
   *
   * The emitter category leads because the aircraft broadcasts it itself; the
   * type code is a registry lookup that is frequently missing. Neither is
   * always present, which is why both are consulted.
   *
   * Memoised per hex, and only once a verdict can be reached. A thousand
   * aircraft at 60 fps is 120 000 registry lookups a second otherwise — each
   * cheap, all of them pointless, since an airframe does not become a
   * helicopter mid-flight. Caching the *absence* of an answer would be the
   * bug: the registry fills in asynchronously, so a hex looked up before its
   * dossier arrived would stay classified as fixed-wing for the whole session.
   */
  private isRotorcraft(sample: SampledAircraft): boolean {
    const memo = this.rotorcraftByHex.get(sample.hex);
    if (memo !== undefined) return memo;

    if (sample.latest.category === 'A7') {
      this.rotorcraftByHex.set(sample.hex, true);
      return true;
    }

    const type = registry.knownTypeCode(sample.hex);
    if (type) {
      const verdict = isRotorcraftType(type.toUpperCase());
      this.rotorcraftByHex.set(sample.hex, verdict);
      return verdict;
    }

    // Category present and not A7 settles it too; an absent category does not.
    if (sample.latest.category) this.rotorcraftByHex.set(sample.hex, false);
    // Traffic churns over a long session and nothing here ever expires, so the
    // map is bounded rather than pruned: re-deriving a few hundred verdicts
    // costs one frame's worth of map lookups, once.
    if (this.rotorcraftByHex.size > 20_000) this.rotorcraftByHex.clear();
    return false;
  }

  /** Physical length in metres, from the ADS-B emitter category. */
  private sizeOf(sample: SampledAircraft): number {
    switch (sample.latest.category) {
      case 'A1': return 10;
      case 'A2': return 20;
      case 'A3': return 40;
      case 'A4': return 55;
      case 'A5': return 70;
      // Rotorcraft. Read as the rotor diameter rather than the fuselage
      // length, because that is what the silhouette above actually spans.
      case 'A7': return 14;
      case 'B1': return 15;
      case 'B4': return 8;
      case 'B6': return 6;
      default: return 35;
    }
  }

  dispose(): void {
    this.rotorcraftByHex.clear();
    this.fixedWing.dispose();
    this.rotorcraft.dispose();
    this.material.dispose();
  }
}
