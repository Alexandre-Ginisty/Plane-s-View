/**
 * The aircraft the camera is riding in.
 *
 * Kept separate from `Traffic3D` because the two have opposite requirements.
 * Surrounding traffic is drawn by the thousand, at range, and is inflated to
 * stay visible — correctness of shape barely matters. This one is a few tens
 * of metres from the camera, is the subject of the shot, and must be at true
 * scale with a recognisable silhouette for its actual type.
 *
 * It is hidden in cockpit view (the camera is inside it) and shown in every
 * external view. Rebuilt only when the type changes, which is once per flight.
 */

import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshLambertMaterial,
  Scene,
  Vector3,
} from 'three';
import { FEET_TO_METRES, geodeticToEcef } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import type { SampledAircraft } from '@/state/traffic';
import { buildAircraftModel, type AirframeShape } from './aircraft';
import { aircraftFrame } from './pov';

export class OwnAircraft {
  readonly scene = new Scene();
  private readonly group = new Group();
  private mesh: Mesh | null = null;
  private geometry: BufferGeometry | null = null;

  private readonly material = new MeshLambertMaterial({
    color: 0xdfe6ee,
    emissive: new Color(0x0a1420),
  });

  /** Type the current geometry was built for, so it is not rebuilt per frame. */
  private builtFor: string | null = null;
  private shape: AirframeShape | null = null;

  /** Sun, carried in this scene so the model is lit like the terrain. */
  private readonly sun = new DirectionalLight(0xfff4e0, 2.1);
  private readonly ambient = new AmbientLight(0x8ea8c4, 1.1);

  constructor(private readonly origin: FloatingOrigin) {
    this.scene.add(this.group);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.scene.add(this.ambient);
    this.scene.matrixAutoUpdate = false;
    this.group.matrixAutoUpdate = false;
  }

  /** Overall length of the current model, metres. Used to frame the camera. */
  get lengthMetres(): number {
    return this.shape?.length ?? 40;
  }

  private ensureModel(typeCode: string | null, category: string | null): void {
    const key = `${typeCode ?? ''}|${category ?? ''}`;
    if (this.builtFor === key && this.mesh) return;

    if (this.mesh) {
      this.group.remove(this.mesh);
      this.geometry?.dispose();
    }

    const { geometry, shape } = buildAircraftModel(typeCode, category, 'high');
    this.geometry = geometry;
    this.shape = shape;

    const mesh = new Mesh(geometry, this.material);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    // The model is normalised to length 1; scale to the real airframe.
    mesh.scale.setScalar(shape.length);
    mesh.updateMatrix();

    this.group.add(mesh);
    this.mesh = mesh;
    this.builtFor = key;
  }

  /**
   * Place the model for this frame.
   *
   * `visible` is false in cockpit view: drawing the fuselage the camera sits
   * inside fills the screen with the inside of a hull.
   */
  update(
    sample: SampledAircraft,
    typeCode: string | null,
    visible: boolean,
  ): void {
    this.scene.visible = visible;
    if (!visible) return;

    this.ensureModel(typeCode, sample.latest.category);

    const frame = aircraftFrame(sample);
    const altM = sample.altFt * FEET_TO_METRES;
    const ecef = geodeticToEcef(sample.lat, sample.lon, altM);

    this.group.position.set(
      ecef[0] - this.origin.current[0],
      ecef[1] - this.origin.current[1],
      ecef[2] - this.origin.current[2],
    );

    // Model axes are starboard/nose/up, matching the body frame directly.
    this.group.matrix.makeBasis(frame.right, frame.forward, frame.up);
    this.group.matrix.setPosition(this.group.position);
    this.group.matrixWorldNeedsUpdate = true;
  }

  /**
   * Point the model's key light along the real sun vector.
   *
   * The light rides with the aircraft rather than sitting at a fixed world
   * position: at planetary scale a "far away" light placed once would drift
   * out of alignment as the floating origin moves.
   */
  setSun(direction: Vector3): void {
    this.sun.position.copy(this.group.position).addScaledVector(direction, 4000);
    this.sun.target.position.copy(this.group.position);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material.dispose();
  }
}
