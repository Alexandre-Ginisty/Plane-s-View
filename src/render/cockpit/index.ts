/**
 * The cockpit around the camera in the first-person view.
 *
 * ## A pass of its own
 *
 * The cockpit is drawn after the world, into a cleared depth buffer, by a
 * camera of its own at the eye with a near plane of two centimetres. Two
 * things make that the right design rather than putting it in the scene:
 *
 *  - **Depth.** The world's camera has a half-metre near plane and a
 *    logarithmic depth buffer spread over five hundred kilometres. A panel
 *    sixty centimetres away would clip and fight the terrain.
 *  - **Lag.** The cockpit is fixed to the eye, not placed in the world and
 *    chased by the camera. The old first-person symbology was a DOM overlay
 *    refreshed at ten hertz over a sixty-hertz world, and the horizon bar
 *    visibly trailed the horizon. Here the HUD is redrawn every frame from the
 *    same attitude the camera was built from, so the two cannot disagree.
 *
 * The airframe's attitude comes in as the orientation the camera was built on
 * (before the free look), so looking around turns the head inside a cockpit
 * that stays put.
 *
 * ## Which cockpit
 *
 * Chosen from the type: fast jets get the fighter, airliners the flight deck
 * (with an Airbus side stick or a Boeing yoke), helicopters the bubble, piston
 * fighters the long nose and gunsight, everything else the light aircraft.
 *
 * Where a type has a real cockpit — modelled and textured, converted from
 * FlightGear (see `modelled.ts`) — that is drawn instead once it has loaded,
 * and the procedural one shrinks to the live displays laid over its glass.
 */

import {
  BufferGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  type Quaternion,
  Vector3,
  type WebGLRenderer,
} from 'three';

import { prewarm } from '@/render/prewarm';

import type { SceneLight } from '@/render/sky/model';
import type { AirframeShape } from '@/render/aircraft';
import { loadModelById, loadModelFor } from '@/render/aircraft/library';
import { buildCockpit, type BuiltCockpit, type CockpitFit, type CockpitKind, type Screen } from './build';
import { drawEicas, drawHud, drawNd, drawPfd, drawRadar, drawSixPack, drawSystems } from './instruments';
import type { CockpitReadings } from './readings';
import { loadModelledCockpit, type Modelled, type Seat } from './modelled';
import { buildShell, type Shell } from './shell';

export type { CockpitReadings, CockpitContact } from './readings';
export type { Seat } from './modelled';
export { emptyReadings } from './readings';

/** How far about a passenger's head the airframe's skin is cleared, metres. */
const CABIN_CLEAR_M = 1.0;

const _offset = new Vector3();

/** A cockpit with nothing drawn: what stands while the modelled one loads. */
const EMPTY: CockpitFit = { hud: null, screens: [] };

const FIGHTERS = new Set(['F16', 'F15', 'F14', 'F18', 'F18H', 'F18S', 'MIR2', 'GRIF', 'MG29', 'MG21', 'SU25', 'A10', 'EUFI', 'RFAL', 'F35', 'HAWK', 'TOR', 'F4', 'F5', 'T38']);
const WARBIRDS = new Set(['F4U', 'P51', 'SPIT', 'CORS']);

/** The cockpit a type gets. */
export function cockpitKindFor(typeCode: string | null, shape: AirframeShape): CockpitKind {
  const code = (typeCode ?? '').toUpperCase();
  if (FIGHTERS.has(code)) return 'fighter';
  if (WARBIRDS.has(code)) return 'warbird';
  if (shape.kind === 'rotorcraft') return 'heli';
  if (shape.kind === 'jet' && shape.length >= 17) return 'airliner';
  if (shape.kind === 'turboprop' && shape.length >= 17) return 'airliner';
  return 'light';
}

/** Airbus flies with a side stick; nearly everyone else with a yoke. */
const sidestickFor = (typeCode: string | null) => /^A(3\d\d|2\d[N\d]|19N|20N|21N|3[0-9]|22|BL)/.test((typeCode ?? '').toUpperCase());

export class Cockpit {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(60, 1, 0.02, 60);
  /** Drawn this frame; the engine skips the pass when false. */
  visible = false;

  private built: BuiltCockpit | null = null;
  private builtKey = '';
  /** The type's model about the cockpit, when it has one. */
  private shell: Shell | null = null;
  private shellKey = '';
  /** The type's real, modelled cockpit once it has loaded; the procedural one stands in until then. */
  private modelled: Modelled | null = null;
  private modelledKey = '';
  private modelledFailed = false;
  /** Drawn between the shell and the cockpit: clears the depth the shell wrote. */
  private readonly depthReset: Mesh;
  private readonly sun = new DirectionalLight(0xfff4e0, 3.6);
  private readonly sky = new HemisphereLight(0xb4c8de, 0x6a625a, 2.4);
  private light: SceneLight | null = null;
  private seat: Seat = 'cockpit';
  /**
   * The renderer, to get an interior onto the GPU before it is shown. Without
   * it the first frame an interior is drawn in uploads and compiles it, and
   * the picture freezes for a quarter of a second at every change of view.
   */
  renderer: WebGLRenderer | null = null;
  /** Interiors and the airframes about them, loaded and warmed, by seat. */
  private readonly modelledCache = new Map<string, Promise<Modelled | null>>();
  private readonly shellCache = new Map<string, Promise<Shell | null>>();
  private prefetchKey = '';
  private maxKt = 200;

  constructor() {
    this.scene.matrixAutoUpdate = true;
    this.scene.add(this.sun, this.sun.target, this.sky);
    // Shadows of the frame, the HUD posts and the canopy bow falling across the
    // panel as the aircraft turns under the sun: cheap at this size, and the
    // single thing that most makes a cockpit look lit rather than drawn.
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 0.1;
    this.sun.shadow.camera.far = 8;
    this.sun.shadow.camera.left = -1.6;
    this.sun.shadow.camera.right = 1.6;
    this.sun.shadow.camera.top = 1.6;
    this.sun.shadow.camera.bottom = -1.6;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.01;

    // A single degenerate triangle that draws nothing, placed in the opaque
    // order after the shell (−10) and before everything else (0).
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    this.depthReset = new Mesh(g, new MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
    this.depthReset.renderOrder = -1;
    this.depthReset.frustumCulled = false;
    this.depthReset.onBeforeRender = (renderer) => renderer.clearDepth();
    this.depthReset.visible = false;
    this.scene.add(this.depthReset);
  }

  get kind(): CockpitKind | null {
    return this.built?.kind ?? null;
  }

  /** Where the view from this seat rests, once its model is in: radians, yaw left of the nose. */
  get look(): { yaw: number; pitch: number } | null {
    return this.modelled?.look ?? null;
  }

  /**
   * Build the interior for a type, if it is not the one already built: the
   * flight deck, or the cabin from a window seat (a freighter's hold).
   */
  setAirframe(typeCode: string | null, shape: AirframeShape, seat: Seat = 'cockpit', freighter = false): void {
    const typeKind = cockpitKindFor(typeCode, shape);
    if (seat !== this.seat) {
      this.seat = seat;
      if (this.light) this.setLight(this.light);
    }
    this.ensureModelled(typeCode, shape, typeKind, seat, freighter);
    const m = this.modelled;
    const kind = m?.kind ?? typeKind;
    const sidestick = kind === 'airliner' && sidestickFor(typeCode);
    // Fast aircraft get a faster airspeed dial.
    this.maxKt = kind === 'warbird' ? 500 : shape.length > 12 ? 300 : 200;
    /*
     * The modelled cockpit's live displays once it is in; nothing at all while
     * it loads — a second of sky is better than a drawn panel floating over
     * the ground — and the drawn one only if it cannot be had.
     */
    const fit = m ? m.fit : this.modelledFailed ? null : EMPTY;
    const key = `${kind}|${sidestick}|${seat}|${m ? m.aircraft : this.modelledFailed ? 'drawn' : 'loading'}`;
    if (key !== this.builtKey) {
      this.disposeBuilt();
      // From a cabin there is no panel to draw, modelled or not.
      this.built = buildCockpit(kind, sidestick, seat === 'cabin' && !m ? EMPTY : fit);
      this.builtKey = key;
      this.scene.add(this.built.group);
    }
    this.ensureShell(typeCode, shape, kind);
  }

  /**
   * Get both interiors of a type ready — the flight deck and the cabin (or the
   * hold) — while the view is elsewhere, so switching to either is immediate.
   */
  prefetch(typeCode: string | null, shape: AirframeShape, freighter = false): void {
    const key = `${(typeCode ?? '').toUpperCase()}|${shape.length}|${freighter}`;
    if (key === this.prefetchKey) return;
    this.prefetchKey = key;
    const kind = cockpitKindFor(typeCode, shape);
    for (const seat of ['cockpit', 'cabin'] as const) {
      void this.modelledFor(typeCode, kind, seat, freighter).then((m) => m && this.shellFor(m, typeCode, shape, m.kind));
    }
  }

  private modelledFor(typeCode: string | null, kind: CockpitKind, seat: Seat, freighter: boolean): Promise<Modelled | null> {
    const key = `${(typeCode ?? '').toUpperCase()}|${kind}|${seat}|${freighter}`;
    let pending = this.modelledCache.get(key);
    if (!pending) {
      pending = loadModelledCockpit(typeCode, kind, seat, freighter).then(async (m) => {
        if (m && this.renderer) await prewarm(this.renderer, m.group, this.scene);
        return m;
      });
      this.modelledCache.set(key, pending);
      // A long session flies many types; the oldest go. Their geometry is the model cache's.
      if (this.modelledCache.size > 8) this.modelledCache.delete(this.modelledCache.keys().next().value!);
    }
    return pending;
  }

  private ensureModelled(typeCode: string | null, shape: AirframeShape, kind: CockpitKind, seat: Seat, freighter: boolean): void {
    const key = `${(typeCode ?? '').toUpperCase()}|${kind}|${seat}|${freighter}`;
    if (key === this.modelledKey) return;
    this.modelledKey = key;
    this.dropModelled();
    this.modelledFailed = false;
    void this.modelledFor(typeCode, kind, seat, freighter).then((m) => {
      if (this.modelledKey !== key) return;
      if (m) {
        this.modelled = m;
        this.scene.add(m.group);
      } else {
        this.modelledFailed = true;
      }
      // Rebuild about it: the displays onto its glass, the airframe about its eye.
      this.setAirframe(typeCode, shape, seat, freighter);
    });
  }

  private dropModelled(): void {
    // Geometry and materials are the model cache's.
    if (this.modelled) this.scene.remove(this.modelled.group);
    this.modelled = null;
  }

  /** The airframe about an interior (or about a measured eye), built and warmed once. */
  private shellFor(m: Modelled | null, typeCode: string | null, shape: AirframeShape, kind: CockpitKind): Promise<Shell | null> {
    const key = m ? `modelled|${m.aircraft}|${m.shellEye}|${m.offset}|${m.seat}|${m.kind}` : `${typeCode ?? ''}|${shape.length}|${kind}`;
    let pending = this.shellCache.get(key);
    if (pending) return pending;
    const load = m ? loadModelById(m.aircraft) : loadModelFor(typeCode);
    pending = load.then(async (model) => {
      if (!model) return null;
      let shell: Shell | null;
      if (m) {
        // The seat's eye in the airframe: the file's, moved by the seat's
        // offset (cockpit axes, metres) into the model's normalised frame.
        const [dx, dy, dz] = m.offset;
        const L = model.lengthM;
        const eye = m.shellEye ? ([m.shellEye[0] + dx / L, m.shellEye[1] - dz / L, m.shellEye[2] + dy / L] as const) : null;
        // From a cabin the fuselage's skin is between the eye and the window:
        // cleared about the head, so the wing and the engines show through.
        const clearM = m.seat === 'cabin' && m.kind === 'airliner' ? CABIN_CLEAR_M : 0;
        shell = buildShell(model, L, kind, eye, clearM);
      } else {
        shell = buildShell(model, shape.length, kind);
      }
      if (shell && this.renderer) await prewarm(this.renderer, shell.group, this.scene);
      return shell;
    });
    this.shellCache.set(key, pending);
    if (this.shellCache.size > 8) {
      const [oldest, gone] = this.shellCache.entries().next().value!;
      this.shellCache.delete(oldest);
      void gone.then((old) => old && old !== this.shell && old.dispose());
    }
    return pending;
  }

  private ensureShell(typeCode: string | null, shape: AirframeShape, kind: CockpitKind): void {
    const m = this.modelled;
    // About the modelled cockpit, the airframe it was built in, at that
    // airframe's own length; otherwise the type's, about a measured eye.
    const key = m ? `modelled|${m.aircraft}|${m.shellEye}|${m.offset}|${m.seat}` : `${typeCode ?? ''}|${shape.length}`;
    if (key === this.shellKey) return;
    this.shellKey = key;
    this.dropShell();
    if (!m && (kind === 'airliner' || kind === 'light')) return;
    void this.shellFor(m, typeCode, shape, kind).then((shell) => {
      if (!shell || this.shellKey !== key) return;
      this.shell = shell;
      this.scene.add(shell.group);
      this.depthReset.visible = true;
    });
  }

  private dropShell(): void {
    // Kept in the cache for the next time this seat is taken; disposed on eviction.
    if (this.shell) this.scene.remove(this.shell.group);
    this.shell = null;
    this.depthReset.visible = false;
  }

  /** Colour and strength of sun and sky, from the atmosphere (1 = noon). */
  setLight(light: SceneLight): void {
    this.light = light;
    this.sun.color.setRGB(Math.min(1.2, light.sunColor[0] * 1.1), Math.min(1.2, light.sunColor[1] * 1.12), Math.min(1.2, light.sunColor[2] * 1.2));
    if (this.seat === 'cabin') {
      /*
       * A cabin is lit by its own lamps, evenly, day and night; the sun only
       * comes in at the windows, as patches — and a sunlit roof seen from
       * below would be light through the skin, so it is kept soft.
       */
      this.sun.intensity = 1.4 * light.sunStrength;
      this.sky.color.setRGB(1, 0.97, 0.9);
      this.sky.groundColor.setRGB(0.55, 0.52, 0.48);
      this.sky.intensity = 1.5 + 0.6 * light.skyStrength;
      return;
    }
    this.sun.intensity = 3.6 * light.sunStrength;
    this.sky.color.setHex(0xb4c8de);
    this.sky.groundColor.setHex(0x6a625a);
    // Never pitch dark: the panel lighting keeps it legible at night.
    this.sky.intensity = Math.max(0.5, 2.4 * light.skyStrength);
  }

  /**
   * One frame. `body` is the airframe's attitude in render axes, in the
   * camera's convention (−Z forward); `eye` the world camera, whose rotation
   * (including the free look) and lens this pass copies; `sunDir` towards the
   * sun, render axes.
   */
  update(eye: PerspectiveCamera, body: Quaternion, sunDir: Vector3, r: CockpitReadings, dt: number): void {
    const b = this.built;
    if (!b || !this.visible) return;

    this.camera.quaternion.copy(eye.quaternion);
    this.camera.position.set(0, 0, 0);
    if (this.camera.fov !== eye.fov || this.camera.aspect !== eye.aspect) {
      this.camera.fov = eye.fov;
      this.camera.aspect = eye.aspect;
      this.camera.updateProjectionMatrix();
    }
    b.group.quaternion.copy(body);
    this.modelled?.group.quaternion.copy(body);
    this.shell?.group.quaternion.copy(body);
    // Another seat than the file's eye: everything moves the other way.
    const m = this.modelled;
    const off = m ? m.offset : null;
    if (off && (off[0] || off[1] || off[2])) {
      _offset.set(-off[0], -off[1], -off[2]).applyQuaternion(body);
      b.group.position.copy(_offset);
      m!.group.position.copy(_offset);
    } else {
      b.group.position.set(0, 0, 0);
      m?.group.position.set(0, 0, 0);
    }

    // The sun, placed about the cockpit.
    this.sun.position.copy(sunDir).normalize().multiplyScalar(4);
    this.sun.target.position.set(0, 0, 0);

    this.moveControls(b, r);
    for (const s of b.screens) this.redraw(b, s, r, dt);
  }

  private moveControls(b: BuiltCockpit, r: CockpitReadings): void {
    const sx = Math.max(-1, Math.min(1, r.stickX));
    const sy = Math.max(-1, Math.min(1, r.stickY));
    if (b.stick) b.stick.rotation.set(-sy * 0.22, 0, -sx * 0.22);
    for (const y of b.yokes) {
      const z0 = (y.userData['z0'] as number | undefined) ?? (y.userData['z0'] = y.position.z);
      y.rotation.z = -sx * 0.9;
      // Pulled back towards the pilot for nose up.
      y.position.z = z0 + sy * 0.07;
    }
    if (b.throttle) {
      const z0 = (b.throttle.userData['z0'] as number | undefined) ?? (b.throttle.userData['z0'] = b.throttle.position.z);
      const t = r.throttle ?? 0.6;
      // Forward is more power, on every kind of lever.
      const travel = b.kind === 'fighter' ? 0.12 : b.kind === 'airliner' ? 0.14 : 0.07;
      b.throttle.position.z = z0 + (0.5 - t) * travel;
      if (b.kind === 'airliner') b.throttle.rotation.x = (0.5 - t) * 0.9;
    }
  }

  private redraw(b: BuiltCockpit, s: Screen, r: CockpitReadings, dt: number): void {
    s.since += dt;
    if (s.since < 1 / s.hz) return;
    s.since = 0;
    const { ctx, canvas } = s;
    const w = canvas.width;
    const h = canvas.height;
    switch (s.id) {
      case 'hud':
        if (b.hud) drawHud(ctx, w, h, r, b.hud);
        break;
      case 'radar':
        drawRadar(ctx, w, h, r);
        break;
      case 'systems':
        drawSystems(ctx, w, h, r);
        break;
      case 'pfd':
        drawPfd(ctx, w, h, r);
        break;
      case 'nd':
        drawNd(ctx, w, h, r);
        break;
      case 'eicas':
        drawEicas(ctx, w, h, r);
        break;
      case 'sixpack':
        drawSixPack(ctx, w, h, r, this.maxKt);
        break;
    }
    s.texture.needsUpdate = true;
  }

  private disposeBuilt(): void {
    const b = this.built;
    if (!b) return;
    this.scene.remove(b.group);
    b.group.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && !b.disposables.includes(m.geometry)) m.geometry.dispose();
    });
    for (const d of b.disposables) d.dispose();
    this.built = null;
    this.builtKey = '';
  }

  dispose(): void {
    this.disposeBuilt();
    // The shell's and the modelled cockpit's geometry and materials are the
    // model cache's, not ours.
    this.dropShell();
    this.shellKey = '';
    for (const pending of this.shellCache.values()) void pending.then((shell) => shell?.dispose());
    this.shellCache.clear();
    this.dropModelled();
    this.modelledKey = '';
    this.modelledCache.clear();
  }
}
