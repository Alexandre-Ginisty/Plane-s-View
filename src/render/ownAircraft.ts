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
 *
 * The undercarriage and the spinning surfaces are conditional rather than
 * static, and neither is decoration: a turboprop with static propellers is the
 * first thing anyone who likes aeroplanes will notice, and an airliner cruising
 * with its gear down is the second.
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  Scene,
  Vector3,
} from 'three';
import { FEET_TO_METRES, geodeticToEcef } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import type { SampledAircraft } from '@/state/traffic';
import { flightRegime } from '@/state/regime';
import {
  bladeOpacity,
  buildAircraftModel,
  disposeAircraftModel,
  propellerRpm,
  rotorRpm,
  visibleSpinRate,
  type AircraftModel,
  type AirframeShape,
  type Spinner,
} from './aircraft';
import { loadModelFor, operatorOf } from './aircraft/library';
import type { LoadedModel } from './aircraft/pvm';
import { GROUND_CHECK_CEILING_M, clearanceFor, surfaceAltitudeM } from './ground';
import { aircraftFrame } from './pov';

/**
 * Height above ground at which the gear comes down, metres.
 *
 * 750 m is about 2500 ft, which is where a jet on an ILS is configured and
 * comfortably above circuit height for everything else. Being early is free;
 * being late means an aircraft touching down on its belly.
 */
const GEAR_DOWN_AGL_M = 750;

const MODEL_AXIS = new Vector3(0, 1, 0);
const _axis = new Vector3();
const _base = new Quaternion();
const _spin = new Quaternion();

/** A spinner's meshes and the state needed to drive them. */
interface SpinnerNode {
  drive: Spinner['drive'];
  axis: readonly [number, number, number];
  direction: 1 | -1;
  blades: Mesh;
  /** Blur disc, where the source provides one. */
  disc: Mesh | null;
  bladeMaterial: { opacity: number };
  discMaterial: { opacity: number } | null;
  angle: number;
}

export class OwnAircraft {
  readonly scene = new Scene();
  private readonly group = new Group();
  /** Scaled to the real airframe; every part of the model hangs off it. */
  private readonly model = new Group();

  private built: AircraftModel | null = null;
  private gearMeshes: Mesh[] = [];
  private spinners: SpinnerNode[] = [];
  /** Materials this instance created and must dispose. Library ones are shared. */
  private owned: { dispose(): void }[] = [];

  /** Bare metal and paint. */
  private readonly hullMaterial = new MeshLambertMaterial({
    color: 0xdfe6ee,
    emissive: new Color(0x0a1420),
  });

  /**
   * Glass and shadow.
   *
   * Nearly black with a cold emissive floor, so the windows stay readable as
   * *windows* on the night side instead of vanishing into the fuselage.
   */
  private readonly trimMaterial = new MeshLambertMaterial({
    color: 0x10161d,
    emissive: new Color(0x0a1626),
  });

  private readonly gearMaterial = new MeshLambertMaterial({
    color: 0x2a2f36,
    emissive: new Color(0x05080c),
  });

  /** Type the current geometry was built for, so it is not rebuilt per frame. */
  private builtFor: string | null = null;
  private shape: AirframeShape | null = null;

  /** Sun, carried in this scene so the model is lit like the terrain. */
  private readonly sun = new DirectionalLight(0xfff4e0, 2.1);
  private readonly ambient = new AmbientLight(0x8ea8c4, 1.1);

  constructor(private readonly origin: FloatingOrigin) {
    this.scene.add(this.group);
    this.group.add(this.model);
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

  /**
   * Two sources, in order. The procedural model is built synchronously and
   * shown at once; the real airframe, if the library has one, replaces it when
   * its megabyte arrives. Waiting for the download would put a hole in the
   * middle of the screen at the moment the user stepped inside.
   *
   * Deliberately *not* gated on the detail preference: a megabyte once per
   * type, then cached, against the tens of megabytes of terrain behind it in
   * the same minute — and this is the subject of the shot.
   */
  private ensureModel(
    typeCode: string | null,
    category: string | null,
    operator: string | null,
  ): void {
    // The operator is part of the key, because it decides the livery. Without
    // it, stepping from an Air France 777 into a British Airways one kept the
    // first aircraft's paint.
    const key = `${typeCode ?? ''}|${category ?? ''}|${operator ?? ''}`;
    if (this.builtFor === key) return;

    this.teardown();
    this.builtFor = key;

    const model = buildAircraftModel(typeCode, category, 'high');
    this.built = model;
    this.shape = model.shape;
    this.applyProcedural(model);

    void loadModelFor(typeCode, operator, category).then((loaded) => {
      // The user may have moved on while it was downloading.
      if (!loaded || this.builtFor !== key) return;
      this.applyLoaded(loaded);
    });
  }

  private attach(mesh: Mesh): Mesh {
    mesh.frustumCulled = false;
    this.model.add(mesh);
    return mesh;
  }

  private applyProcedural(model: AircraftModel): void {
    const still = (mesh: Mesh): Mesh => {
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      return this.attach(mesh);
    };

    still(new Mesh(model.hull, this.hullMaterial));
    if (model.trim) still(new Mesh(model.trim, this.trimMaterial));
    if (model.gear) this.gearMeshes.push(still(new Mesh(model.gear, this.gearMaterial)));

    for (const spec of model.spinners) {
      // Own materials per spinner: the opacity cross-fade is per-spinner state
      // and sharing one material would make every propeller fade together.
      const bladeMaterial = new MeshLambertMaterial({
        color: 0x1d2228,
        emissive: new Color(0x080c10),
        transparent: true,
      });
      const discMaterial = new MeshBasicMaterial({
        color: 0xb9c6d4,
        transparent: true,
        opacity: 0,
        // Written into the depth buffer, a translucent disc hides everything
        // drawn after it — including the terrain seen through it.
        depthWrite: false,
        side: DoubleSide,
      });
      this.owned.push(bladeMaterial, discMaterial);

      const blades = this.attach(new Mesh(spec.geometry, bladeMaterial));
      const disc = this.attach(new Mesh(spec.disc, discMaterial));
      for (const mesh of [blades, disc]) {
        mesh.position.set(spec.origin[0], spec.origin[1], spec.origin[2]);
      }
      disc.renderOrder = 2;

      this.spinners.push({
        drive: spec.drive,
        axis: spec.axis,
        direction: spec.direction,
        blades,
        disc,
        bladeMaterial,
        discMaterial,
        angle: 0,
      });
    }

    this.finishModel();
  }

  /**
   * The procedural model is torn down first rather than hidden: the two would
   * otherwise occupy the same space and z-fight, which is a far worse artefact
   * than either model on its own.
   */
  private applyLoaded(loaded: LoadedModel): void {
    this.clearMeshes();

    const discs = new Map<string, Mesh>();
    const pending: { part: (typeof loaded.parts)[number]; mesh: Mesh }[] = [];

    for (const part of loaded.parts) {
      const mesh = this.attach(new Mesh(part.geometry, part.material));
      const spins = part.role !== 'hull' && part.role !== 'gear';
      if (spins) mesh.position.set(part.origin[0], part.origin[1], part.origin[2]);
      else {
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
      }

      if (part.role === 'gear') this.gearMeshes.push(mesh);
      else if (part.role === 'disc') {
        mesh.renderOrder = 2;
        // `propdiscL` belongs to `propL`. Matching by name is what the source
        // models make available, and it is what the converter preserves.
        discs.set(part.name.replace(/disc/i, '').toLowerCase(), mesh);
      } else if (spins) pending.push({ part, mesh });
    }

    for (const { part, mesh } of pending) {
      const disc = discs.get(part.name.toLowerCase()) ?? null;
      this.spinners.push({
        drive:
          part.role === 'mainRotor'
            ? 'mainRotor'
            : part.role === 'tailRotor'
              ? 'tailRotor'
              : 'propeller',
        axis: part.axis,
        direction: 1,
        blades: mesh,
        disc,
        bladeMaterial: part.material,
        discMaterial: disc ? (disc.material as MeshBasicMaterial) : null,
        angle: 0,
      });
      // The blur disc is only ever shown against the blades, so it starts off.
      // `transparent` is already set by the parser — see the note there on why
      // a consumer must not flip it on a shared material.
      if (disc) {
        (disc.material as MeshBasicMaterial).opacity = 0;
        disc.visible = false;
      }
    }

    this.finishModel();
  }

  private finishModel(): void {
    // The models are normalised to length 1; scale to the real airframe.
    this.model.scale.setScalar(this.shape?.length ?? 40);
    this.model.updateMatrix();
  }

  /**
   * `visible` is false in cockpit view: drawing the fuselage the camera sits
   * inside fills the screen with the inside of a hull. `terrainHeightAt` puts
   * the model on the ground rather than through it when the aircraft is
   * taxiing or parked — see `@/render/ground`.
   */
  update(
    sample: SampledAircraft,
    typeCode: string | null,
    visible: boolean,
    dt: number,
    terrainHeightAt?: (lat: number, lon: number) => number,
  ): void {
    this.scene.visible = visible;
    if (!visible) return;

    this.ensureModel(typeCode, sample.latest.category, operatorOf(sample.latest.callsign));

    let altM = sample.altFt * FEET_TO_METRES;
    const terrainM = terrainHeightAt?.(sample.lat, sample.lon) ?? 0;
    if (this.shape && terrainHeightAt && (sample.latest.onGround || altM < GROUND_CHECK_CEILING_M)) {
      altM = surfaceAltitudeM(altM, sample.latest.onGround, terrainM, clearanceFor(this.shape));
    }

    const frame = aircraftFrame(sample, altM);
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

    const regime = flightRegime(sample);
    const gearDown = regime.onGround || altM - terrainM < GEAR_DOWN_AGL_M;
    for (const mesh of this.gearMeshes) mesh.visible = gearDown;
    this.animateSpinners(dt, regime.power);
  }

  private animateSpinners(dt: number, power: number): void {
    if (this.spinners.length === 0 || !this.shape) return;
    const shape = this.shape;

    for (const node of this.spinners) {
      const rpm = this.rpmFor(node.drive, shape, power);
      node.angle += node.direction * visibleSpinRate(rpm) * Math.PI * 2 * dt;

      _axis.set(node.axis[0], node.axis[1], node.axis[2]).normalize();
      // Geometry is built in the plane normal to +Y, so it is first stood onto
      // its own axis and then turned about it.
      _base.setFromUnitVectors(MODEL_AXIS, _axis);
      _spin.setFromAxisAngle(_axis, node.angle);
      node.blades.quaternion.copy(_spin).multiply(_base);
      node.disc?.quaternion.copy(_base);

      const solid = bladeOpacity(rpm);
      node.bladeMaterial.opacity = solid;
      node.blades.visible = solid > 0.01;
      // The disc is faint even at full blur: a propeller you cannot see
      // through is a dinner plate.
      if (node.disc && node.discMaterial) {
        node.discMaterial.opacity = (1 - solid) * 0.3;
        node.disc.visible = node.discMaterial.opacity > 0.01;
      }
    }
  }

  private rpmFor(drive: Spinner['drive'], shape: AirframeShape, power: number): number {
    switch (drive) {
      case 'mainRotor':
        return rotorRpm(shape);
      case 'tailRotor':
        // Geared off the main rotor, and much faster — which is why it blurs
        // solid while the main disc is still showing individual blades.
        return rotorRpm(shape) * 5.2;
      case 'propeller':
        return propellerRpm(shape.kind === 'turboprop' ? 'turboprop' : 'piston', power);
    }
  }

  /**
   * The light rides with the aircraft rather than sitting at a fixed world
   * position: at planetary scale a "far away" light placed once would drift out
   * of alignment as the floating origin moves.
   */
  setSun(direction: Vector3): void {
    this.sun.position.copy(this.group.position).addScaledVector(direction, 4000);
    this.sun.target.position.copy(this.group.position);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  /**
   * Split from `teardown` because swapping the procedural model for the real
   * one keeps the type and the airframe shape — only the geometry changes.
   */
  private clearMeshes(): void {
    this.model.clear();
    this.gearMeshes = [];
    this.spinners = [];
    for (const material of this.owned) material.dispose();
    this.owned = [];
    // The library's geometries and materials are cached and shared between
    // every aircraft of the type; only the procedurally generated ones belong
    // to this instance.
    if (this.built) disposeAircraftModel(this.built);
    this.built = null;
  }

  private teardown(): void {
    this.clearMeshes();
    this.builtFor = null;
  }

  dispose(): void {
    this.teardown();
    this.hullMaterial.dispose();
    this.trimMaterial.dispose();
    this.gearMaterial.dispose();
  }
}
