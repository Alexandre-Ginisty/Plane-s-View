/**
 * The cockpits, built from primitives around the pilot's eye.
 *
 * ## Frame
 *
 * The eye is the origin; +X is right, +Y up, −Z forward — the camera's own
 * convention, so the cockpit group takes the airframe's attitude directly.
 * Metres. Nothing here knows how long the aircraft is: a cockpit is sized for
 * a person, whatever it is bolted into.
 *
 * ## Five of them
 *
 * A fighter (the F-16's layout: HUD on the glareshield, two screens, side
 * stick, throttle on the left console, frameless canopy with its bow behind
 * the head), an airliner flight deck (glareshield with the autopilot panel,
 * the glass in front of each pilot, window posts, overhead panel, yokes or an
 * Airbus side stick, the pedestal with the thrust levers), a light aircraft
 * (round gauges, yoke, windshield pillars), a helicopter (low panel, thin
 * frames, a big bubble to see through) and a propeller fighter (a long nose
 * in front of the windscreen, a reflector gunsight).
 *
 * Everything static in one material is merged into one mesh; what moves (the
 * stick, the throttle, the yoke) is a group of its own.
 *
 * Original work under the project licence; the layout follows the tatertots
 * cockpits (MIT, see `@/fx/LICENSE`) in spirit, not in code.
 */

import {
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  AdditiveBlending,
  type Material,
  type Object3D,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { HudGeometry } from './instruments';

export type CockpitKind = 'fighter' | 'airliner' | 'light' | 'heli' | 'warbird';

/** A display in the cockpit: a canvas, the texture it feeds, and how often it is redrawn. */
export interface Screen {
  id: 'hud' | 'radar' | 'systems' | 'pfd' | 'nd' | 'eicas' | 'sixpack';
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
  /** Redraws per second. */
  hz: number;
  since: number;
}

export interface BuiltCockpit {
  kind: CockpitKind;
  group: Group;
  screens: Screen[];
  /** Present on a fighter: where the boresight falls on the HUD canvas. */
  hud: HudGeometry | null;
  /** Moving controls, positioned by the cockpit each frame. */
  stick: Object3D | null;
  throttle: Object3D | null;
  yokes: Object3D[];
  /** Materials and geometries to dispose. */
  disposables: { dispose(): void }[];
}

const V = (x: number, y: number, z: number) => new Vector3(x, y, z);

/** A rounded box of w × h × d, turned by (rx, ry, rz) and centred on (x, y, z). */
function rbox(w: number, h: number, d: number, r: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): BufferGeometry {
  const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2) * 0.999);
  return place(g, x, y, z, rx, ry, rz);
}

function place(g: BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): BufferGeometry {
  g.applyMatrix4(new Matrix4().compose(V(x, y, z), new Quaternion().setFromEuler(new Euler(rx, ry, rz)), V(1, 1, 1)));
  return g;
}

/** A cylinder between two points. */
function rod(a: Vector3, b: Vector3, r: number, segs = 10): BufferGeometry {
  const d = b.clone().sub(a);
  const g = new CylinderGeometry(r, r, d.length(), segs);
  g.translate(0, d.length() / 2, 0);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

/** A tube along a smooth curve through points. */
function bow(points: Vector3[], r: number): BufferGeometry {
  return new TubeGeometry(new CatmullRomCurve3(points), 48, r, 10, false);
}

function merged(parts: BufferGeometry[]): BufferGeometry {
  const clean = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') n.deleteAttribute(name);
    if (!n.getAttribute('uv')) n.setAttribute('uv', n.getAttribute('position').clone());
    return n;
  });
  const out = mergeGeometries(clean, false);
  if (!out) throw new Error('cockpit geometry did not merge');
  return out;
}

function makeScreen(id: Screen['id'], w: number, h: number, hz: number): Screen {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return { id, canvas, ctx, texture, hz, since: Infinity };
}

interface Kit {
  group: Group;
  disposables: { dispose(): void }[];
  mats: {
    panel: MeshStandardMaterial;
    dark: MeshStandardMaterial;
    frame: MeshStandardMaterial;
    metal: MeshStandardMaterial;
    grip: MeshStandardMaterial;
    trim: MeshStandardMaterial;
    glass: MeshStandardMaterial;
    seat: MeshStandardMaterial;
  };
  add(geometry: BufferGeometry[], material: Material, name: string): Mesh;
  screen(s: Screen, w: number, h: number, x: number, y: number, z: number, tiltX?: number, yaw?: number): Mesh;
  /** Transparent panes: the canopy, the windshield. Not merged with the rest, never shadowing. */
  glaze(geometry: BufferGeometry[], name: string): Mesh;
}

/**
 * Glass: nearly clear looking straight through it, brighter and more
 * reflective at a grazing angle — which is what shows a canopy is there at all.
 * A plain transparent material of one opacity reads either as fog or as
 * nothing.
 */
function glassMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color: 0xd6e6f2,
    roughness: 0.06,
    metalness: 0.0,
    transparent: true,
    opacity: 0.045,
    depthWrite: false,
    side: DoubleSide,
  });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float pvFacing = abs(dot(normalize(normal), normalize(vViewPosition)));
      diffuseColor.a = clamp(diffuseColor.a + pow(1.0 - pvFacing, 4.0) * 0.5, 0.0, 0.6);
      #include <opaque_fragment>`,
    );
  };
  return m;
}

function kit(frameColor: number, panelColor: number): Kit {
  const group = new Group();
  group.name = 'cockpit';
  const disposables: { dispose(): void }[] = [];
  const std = (color: number, roughness: number, metalness: number) => {
    const m = new MeshStandardMaterial({ color, roughness, metalness });
    disposables.push(m);
    return m;
  };
  const mats = {
    panel: std(panelColor, 0.82, 0.12),
    dark: std(0x3d4147, 0.88, 0.05),
    frame: std(frameColor, 0.55, 0.35),
    metal: std(0x9ea3a8, 0.32, 0.85),
    grip: std(0x2a2b2d, 0.7, 0.05),
    trim: std(0x3c4148, 0.6, 0.25),
    glass: glassMaterial(),
    seat: std(0x59604f, 0.9, 0.02),
  };
  disposables.push(mats.glass);
  const add = (geometry: BufferGeometry[], material: Material, name: string) => {
    const g = merged(geometry);
    disposables.push(g);
    const mesh = new Mesh(g, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const screen = (s: Screen, w: number, h: number, x: number, y: number, z: number, tiltX = 0, yaw = 0) => {
    // Unlit and outside the tone mapping: a display emits its own light and
    // keeps its colours at any time of day.
    const material = new MeshBasicMaterial({ map: s.texture, toneMapped: false });
    const geometry = new PlaneGeometry(w, h);
    disposables.push(material, geometry, s.texture);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(tiltX, yaw, 0, 'YXZ');
    mesh.receiveShadow = false;
    mesh.name = `screen-${s.id}`;
    group.add(mesh);
    return mesh;
  };
  const glaze = (geometry: BufferGeometry[], name: string) => {
    const g = merged(geometry);
    disposables.push(g);
    const mesh = new Mesh(g, mats.glass);
    mesh.name = name;
    mesh.renderOrder = 5;
    group.add(mesh);
    return mesh;
  };
  return { group, disposables, mats, add, screen, glaze };
}

/** A flat pane between a bottom edge and a top edge, both spanning x0..x1. */
function pane(x0: number, x1: number, yb: number, zb: number, yt: number, zt: number): BufferGeometry {
  const h = Math.hypot(yt - yb, zt - zb);
  const g = new PlaneGeometry(Math.abs(x1 - x0), h);
  // Leaning back: the top nearer the eye (+Z) than the bottom.
  return place(g, (x0 + x1) / 2, (yb + yt) / 2, (zb + zt) / 2, Math.atan2(zt - zb, yt - yb));
}

/** Half an ellipsoid over the sill: a bubble canopy. */
function bubble(rx: number, ry: number, rz: number, y: number, z: number): BufferGeometry {
  const g = new SphereGeometry(1, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  g.scale(rx, ry, rz);
  g.translate(0, y, z);
  return g;
}

/** A display bezel with its row of buttons, behind a screen of w × h. */
function bezelParts(w: number, h: number, x: number, y: number, z: number, tiltX: number, buttons: boolean): BufferGeometry[] {
  const parts: BufferGeometry[] = [rbox(w + 0.045, h + 0.045, 0.02, 0.006, 0, 0, -0.011)];
  if (buttons) {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) / n - 0.5) * w * 0.9;
      parts.push(rbox(0.016, 0.011, 0.008, 0.002, u, h / 2 + 0.013, 0.002));
      parts.push(rbox(0.016, 0.011, 0.008, 0.002, u, -h / 2 - 0.013, 0.002));
      parts.push(rbox(0.011, 0.016, 0.008, 0.002, -w / 2 - 0.013, u * (h / w), 0.002));
      parts.push(rbox(0.011, 0.016, 0.008, 0.002, w / 2 + 0.013, u * (h / w), 0.002));
    }
  }
  const m = new Matrix4().compose(V(x, y, z), new Quaternion().setFromEuler(new Euler(tiltX, 0, 0)), V(1, 1, 1));
  for (const p of parts) p.applyMatrix4(m);
  return parts;
}

// ---------------------------------------------------------------------------
// Fighter
// ---------------------------------------------------------------------------

/** HUD combiner: distance from the eye, size, and where its centre sits. */
const HUD = { z: -0.6, y: 0.0, w: 0.25, h: 0.22 };

type HudRect = typeof HUD;

/**
 * The HUD's symbology on a plane square to the boresight, `rect` about the
 * eye, and — over glass of our own — the glass's faint tint.
 */
function addHud(k: Kit, rect: HudRect, tinted: boolean): { screen: Screen; geometry: HudGeometry } {
  const screen = makeScreen('hud', 1024, Math.round((1024 * rect.h) / rect.w), 60);
  const hudMat = new MeshBasicMaterial({
    map: screen.texture,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const hudGeo = new PlaneGeometry(rect.w, rect.h);
  const hudMesh = new Mesh(hudGeo, hudMat);
  hudMesh.position.set(0, rect.y, rect.z);
  hudMesh.renderOrder = 10;
  hudMesh.name = 'hud';
  k.group.add(hudMesh);
  k.disposables.push(hudMat, hudGeo, screen.texture);
  if (tinted) {
    const tintMat = new MeshBasicMaterial({ color: 0x9fe8c0, transparent: true, opacity: 0.06, depthWrite: false, side: DoubleSide });
    const tint = new Mesh(new PlaneGeometry(rect.w, rect.h), tintMat);
    tint.position.set(0, rect.y, rect.z + 0.002);
    tint.renderOrder = 9;
    k.group.add(tint);
    k.disposables.push(tintMat, tint.geometry);
  }
  const pxPerTan = (screen.canvas.width / rect.w) * Math.abs(rect.z);
  return { screen, geometry: { pxPerTan, cx: screen.canvas.width / 2, cy: screen.canvas.height / 2 + (rect.y / rect.h) * screen.canvas.height } };
}

/**
 * Where a real, modelled cockpit keeps its displays, so the live ones can be
 * laid over its glass: the HUD's rectangle about the eye, and each screen's
 * face — centre, size and tilt (positive leans the top towards the eye).
 */
export interface CockpitFit {
  hud: HudRect | null;
  /** `yaw` turns a face towards the pilot, positive to the left. */
  screens: { id: Screen['id']; w: number; h: number; x: number; y: number; z: number; tilt: number; yaw?: number }[];
}

/** Only the live displays, for a modelled cockpit that supplies everything else. */
function fitted(kind: CockpitKind, fit: CockpitFit): BuiltCockpit {
  const k = kit(0, 0);
  const hud = fit.hud ? addHud(k, fit.hud, false) : null;
  const screens = fit.screens.map((f) => {
    const s = makeScreen(f.id, 512, Math.round((512 * f.h) / f.w), f.id === 'radar' || f.id === 'pfd' ? 20 : 12);
    // Just proud of the model's glass, so the two never fight for depth.
    const yaw = f.yaw ?? 0;
    const normal = new Vector3(0, -Math.sin(f.tilt), Math.cos(f.tilt)).applyAxisAngle(new Vector3(0, 1, 0), yaw);
    const at = new Vector3(f.x, f.y, f.z).addScaledVector(normal, 0.002);
    k.screen(s, f.w, f.h, at.x, at.y, at.z, f.tilt, yaw);
    return s;
  });
  return {
    kind,
    group: k.group,
    screens: hud ? [hud.screen, ...screens] : screens,
    hud: hud?.geometry ?? null,
    stick: null,
    throttle: null,
    yokes: [],
    disposables: k.disposables,
  };
}

function fighter(): BuiltCockpit {
  const k = kit(0x6a7079, 0x5f656d);
  const { mats } = k;
  const panelTilt = 0.32;

  // Glareshield: the padded coaming the HUD stands on, wrapping forward.
  k.add(
    [
      rbox(0.62, 0.05, 0.3, 0.02, 0, -0.135, -0.66),
      rbox(0.2, 0.07, 0.16, 0.015, 0, -0.16, -0.56),
      // The up-front controller under the HUD: keypad and small display housing.
      rbox(0.22, 0.09, 0.05, 0.01, 0, -0.2, -0.555, panelTilt),
    ],
    mats.dark,
    'glareshield',
  );
  // Main panel, tilted back to face the pilot, and the knee-height lower panel.
  k.add(
    [
      rbox(0.64, 0.3, 0.03, 0.01, 0, -0.31, -0.6, panelTilt),
      rbox(0.52, 0.16, 0.03, 0.01, 0, -0.5, -0.52, 0.9),
      ...bezelParts(0.15, 0.15, -0.19, -0.3, -0.585, panelTilt, true),
      ...bezelParts(0.15, 0.15, 0.19, -0.3, -0.585, panelTilt, true),
      // Standby gauges between the screens.
      ...bezelParts(0.1, 0.06, 0, -0.36, -0.585, panelTilt, false),
    ],
    mats.panel,
    'panel',
  );
  // Keypad buttons on the up-front controller.
  const keys: BufferGeometry[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) keys.push(rbox(0.024, 0.016, 0.01, 0.003, -0.055 + c * 0.036, -0.185 - r * 0.02, -0.528, panelTilt));
  k.add(keys, mats.trim, 'keypad');

  // Side consoles, the canopy sills over them, and the canopy bow behind the head.
  k.add(
    [
      rbox(0.13, 0.1, 0.95, 0.02, -0.3, -0.5, -0.12),
      rbox(0.13, 0.1, 0.95, 0.02, 0.3, -0.5, -0.12),
    ],
    mats.panel,
    'consoles',
  );
  k.add(
    [
      rbox(0.06, 0.06, 1.4, 0.02, -0.35, -0.22, -0.05),
      rbox(0.06, 0.06, 1.4, 0.02, 0.35, -0.22, -0.05),
      bow([V(-0.35, -0.2, 0.46), V(-0.3, 0.18, 0.44), V(0, 0.4, 0.42), V(0.3, 0.18, 0.44), V(0.35, -0.2, 0.46)], 0.026),
      // HUD frame: two posts and the top bar that carry the combiner glass.
      rod(V(-HUD.w / 2 - 0.012, -0.13, HUD.z - 0.01), V(-HUD.w / 2 - 0.012, HUD.y + HUD.h / 2 + 0.01, HUD.z + 0.01), 0.009),
      rod(V(HUD.w / 2 + 0.012, -0.13, HUD.z - 0.01), V(HUD.w / 2 + 0.012, HUD.y + HUD.h / 2 + 0.01, HUD.z + 0.01), 0.009),
      rbox(HUD.w + 0.04, 0.018, 0.03, 0.006, 0, HUD.y + HUD.h / 2 + 0.012, HUD.z + 0.008),
    ],
    mats.frame,
    'frame',
  );

  // The tub: walls from the floor to the canopy sills, the floor, the footwell
  // bulkhead under the panel, and the ejection seat behind — what is seen
  // looking down and to the sides instead of the ground through the floor.
  k.add(
    [
      rbox(0.035, 0.76, 1.6, 0.012, -0.385, -0.6, -0.12),
      rbox(0.035, 0.76, 1.6, 0.012, 0.385, -0.6, -0.12),
      rbox(0.8, 0.03, 1.6, 0.01, 0, -0.97, -0.12),
      rbox(0.76, 0.46, 0.03, 0.01, 0, -0.74, -0.86),
      // Rear bulkhead behind the seat, up to the canopy rail.
      rbox(0.8, 0.76, 0.04, 0.01, 0, -0.6, 0.62),
      // Ribs along the walls under the sills.
      ...[-0.6, -0.3, 0.0, 0.3].flatMap((z) => [rbox(0.03, 0.2, 0.035, 0.008, -0.365, -0.34, z), rbox(0.03, 0.2, 0.035, 0.008, 0.365, -0.34, z)]),
    ],
    mats.dark,
    'tub',
  );
  k.add(
    [
      // Seat back, headrest (the drogue container) and the side rails.
      rbox(0.44, 0.62, 0.1, 0.03, 0, -0.52, 0.36),
      rbox(0.3, 0.3, 0.16, 0.03, 0, 0.0, 0.37),
      rbox(0.04, 0.95, 0.06, 0.012, -0.25, -0.4, 0.4),
      rbox(0.04, 0.95, 0.06, 0.012, 0.25, -0.4, 0.4),
      rbox(0.44, 0.1, 0.46, 0.03, 0, -0.8, 0.12),
    ],
    k.mats.seat,
    'seat',
  );
  // The ejection handle between the knees, in its black and yellow.
  k.add([rbox(0.08, 0.025, 0.03, 0.01, 0, -0.74, -0.2)], k.mats.trim, 'handle');
  // The bubble: one piece from the windscreen to behind the seat.
  k.glaze([bubble(0.36, 0.66, 1.1, -0.22, -0.1)], 'canopy');

  const hud = addHud(k, HUD, true);

  const radar = makeScreen('radar', 512, 512, 20);
  const systems = makeScreen('systems', 512, 512, 12);
  k.screen(radar, 0.15, 0.15, -0.19, -0.3, -0.574, panelTilt);
  k.screen(systems, 0.15, 0.15, 0.19, -0.3, -0.574, panelTilt);
  const standby = makeScreen('sixpack', 512, 300, 15);
  k.screen(standby, 0.1, 0.06, 0, -0.36, -0.574, panelTilt);

  // Side stick on the right console, throttle on the left.
  const stick = new Group();
  stick.position.set(0.28, -0.45, -0.25);
  stick.add(
    new Mesh(
      merged([
        rod(V(0, 0, 0), V(0, 0.07, -0.01), 0.012),
        rbox(0.038, 0.1, 0.045, 0.016, 0, 0.11, -0.012, -0.25),
        rbox(0.012, 0.012, 0.012, 0.004, 0, 0.165, -0.03),
      ]),
      mats.grip,
    ),
  );
  k.group.add(stick);
  const throttle = new Group();
  throttle.position.set(-0.28, -0.43, -0.12);
  throttle.add(new Mesh(merged([rbox(0.05, 0.075, 0.09, 0.02, 0, 0.03, 0), rod(V(0, -0.03, 0.02), V(0, 0, 0), 0.01)]), mats.grip));
  k.group.add(throttle);
  for (const o of [stick, throttle]) o.traverse((c) => ((c as Mesh).isMesh ? ((c as Mesh).castShadow = true) : null));

  return {
    kind: 'fighter',
    group: k.group,
    screens: [hud.screen, radar, systems, standby],
    hud: hud.geometry,
    stick,
    throttle,
    yokes: [],
    disposables: k.disposables,
  };
}

// ---------------------------------------------------------------------------
// Airliner
// ---------------------------------------------------------------------------

function airliner(sidestick: boolean): BuiltCockpit {
  const k = kit(0x5c636b, sidestick ? 0x55667a : 0x565c64);
  const { mats } = k;
  const tilt = 0.18;
  // The captain sits left of the centreline: the pedestal is at +0.48.
  const cxm = 0.48;
  k.add(
    [
      // Glareshield and its padded lip.
      rbox(2.0, 0.06, 0.26, 0.02, cxm, -0.14, -0.86),
      // Autopilot panel housing on the glareshield face.
      rbox(1.1, 0.075, 0.05, 0.01, cxm, -0.19, -0.73),
    ],
    mats.dark,
    'glareshield',
  );
  const panel: BufferGeometry[] = [
    rbox(2.0, 0.42, 0.04, 0.01, cxm, -0.43, -0.85, tilt),
    // Knee panel and the pedestal running back between the seats.
    rbox(2.0, 0.14, 0.04, 0.01, cxm, -0.68, -0.76, 0.8),
    rbox(0.36, 0.16, 0.85, 0.02, cxm, -0.64, -0.42),
    // Side consoles by the windows.
    rbox(0.2, 0.12, 0.9, 0.02, -0.6, -0.55, -0.35),
    rbox(0.2, 0.12, 0.9, 0.02, cxm * 2 + 0.6, -0.55, -0.35),
  ];
  // Display bezels: captain PFD and ND, the engine page in the middle, the
  // first officer's pair mirrored across.
  const displays: [number, Screen['id']][] = [
    [-0.08, 'pfd'],
    [0.18, 'nd'],
    [cxm, 'eicas'],
    [cxm * 2 - 0.18, 'nd'],
    [cxm * 2 + 0.08, 'pfd'],
  ];
  for (const [x] of displays) panel.push(...bezelParts(0.22, 0.22, x, -0.4, -0.83, tilt, false));
  k.add(panel, mats.panel, 'panel');

  // Window frame: the windshield posts leaning back with the glass, the header
  // beam, the side window's sills and rear post, and the overhead panel.
  const post = (xb: number, xt: number) => rod(V(xb, -0.11, -0.95), V(xt, 0.36, -0.56), 0.032);
  k.add(
    [
      post(-0.62, -0.56),
      post(cxm, cxm),
      post(cxm * 2 + 0.62, cxm * 2 + 0.56),
      rbox(2.3, 0.07, 0.09, 0.02, cxm, 0.37, -0.55),
      rod(V(-0.62, -0.11, -0.95), V(-0.74, -0.11, -0.1), 0.03),
      rod(V(-0.56, 0.36, -0.56), V(-0.66, 0.36, 0.0), 0.03),
      rod(V(-0.74, -0.11, -0.1), V(-0.66, 0.36, 0.0), 0.034),
    ],
    mats.frame,
    'frame',
  );
  // The first officer's side window frame, mirrored across the pedestal.
  const mx = (x: number) => cxm * 2 - x;
  k.add(
    [
      rod(V(mx(-0.62), -0.11, -0.95), V(mx(-0.74), -0.11, -0.1), 0.03),
      rod(V(mx(-0.56), 0.36, -0.56), V(mx(-0.66), 0.36, 0.0), 0.03),
      rod(V(mx(-0.74), -0.11, -0.1), V(mx(-0.66), 0.36, 0.0), 0.034),
      // The post between the sliding window and the fixed one, both sides.
      rod(V(-0.68, -0.11, -0.52), V(-0.61, 0.36, -0.28), 0.022),
      rod(V(mx(-0.68), -0.11, -0.52), V(mx(-0.61), 0.36, -0.28), 0.022),
    ],
    mats.frame,
    'frame-fo',
  );
  // The flight deck's shell: side walls under and behind the windows, the
  // ceiling, the floor, the rear wall with its door, and the two seats.
  const wall = (x: number): BufferGeometry[] => [
    rbox(0.05, 1.0, 1.9, 0.015, x, -0.62, -0.1),
    rbox(0.05, 0.7, 0.95, 0.015, x * 0.985 + (x > 0 ? 0.01 : -0.01), 0.18, 0.5),
    // The sill ledge with the tiller and the oxygen mask box on it.
    rbox(0.16, 0.05, 1.1, 0.012, x + (x > 0 ? -0.07 : 0.07), -0.13, -0.4),
  ];
  k.add(
    [
      ...wall(-0.78),
      ...wall(mx(-0.78)),
      rbox(2.6, 0.04, 1.55, 0.01, cxm, 0.53, 0.25),
      rbox(2.6, 0.04, 1.9, 0.01, cxm, -1.12, -0.1),
      rbox(2.6, 1.7, 0.05, 0.01, cxm, -0.28, 0.98),
    ],
    mats.panel,
    'walls',
  );
  k.add([rbox(0.7, 1.45, 0.02, 0.01, cxm, -0.38, 0.95), rbox(0.03, 0.03, 0.06, 0.01, cxm + 0.28, -0.4, 0.93)], mats.trim, 'door');
  const seat = (x: number): BufferGeometry[] => [
    rbox(0.52, 0.72, 0.12, 0.04, x, -0.5, 0.36),
    rbox(0.32, 0.22, 0.1, 0.04, x, 0.02, 0.38),
    rbox(0.52, 0.12, 0.5, 0.04, x, -0.86, 0.12),
    rbox(0.07, 0.06, 0.4, 0.02, x - 0.29, -0.55, 0.1),
    rbox(0.07, 0.06, 0.4, 0.02, x + 0.29, -0.55, 0.1),
  ];
  k.add([...seat(0), ...seat(cxm * 2)], mats.grip, 'seats');
  // The windshield, two panes meeting at the centre post, and the side windows.
  k.glaze(
    [
      pane(-0.62, cxm, -0.11, -0.95, 0.36, -0.56),
      pane(cxm, cxm * 2 + 0.62, -0.11, -0.95, 0.36, -0.56),
    ],
    'windshield',
  );

  // The roof shades the flight deck in life, but a shadow map this coarse
  // turns the whole panel black under it: it does not cast.
  k.add([rbox(1.4, 0.1, 0.9, 0.02, cxm, 0.46, -0.08)], mats.panel, 'overhead').castShadow = false;

  const pfd = makeScreen('pfd', 512, 512, 30);
  const nd = makeScreen('nd', 512, 512, 15);
  const eicas = makeScreen('eicas', 512, 512, 10);
  const byId = { pfd, nd, eicas } as Record<string, Screen>;
  for (const [x, id] of displays) k.screen(byId[id]!, 0.22, 0.22, x, -0.4, -0.818, tilt);
  // The autopilot panel face: a strip of the engine page's colours would lie;
  // it is drawn once, as knobs and windows, from the PFD canvas's corner.
  const yokes: Object3D[] = [];
  let throttle: Object3D | null = null;
  let stick: Object3D | null = null;
  if (sidestick) {
    stick = new Group();
    stick.position.set(-0.55, -0.48, -0.3);
    stick.add(new Mesh(merged([rod(V(0, 0, 0), V(0, 0.06, 0), 0.012), rbox(0.04, 0.1, 0.05, 0.018, 0, 0.1, 0, -0.2)]), mats.grip));
    k.group.add(stick);
  } else {
    for (const x of [0, cxm * 2]) {
      const y = new Group();
      y.position.set(x, -0.42, -0.5);
      const wheel = merged([
        rbox(0.34, 0.035, 0.035, 0.015, 0, 0, 0),
        rbox(0.035, 0.12, 0.035, 0.015, -0.17, 0.04, 0),
        rbox(0.035, 0.12, 0.035, 0.015, 0.17, 0.04, 0),
        rbox(0.08, 0.05, 0.05, 0.01, 0, -0.01, 0.01),
        rod(V(0, -0.01, -0.25), V(0, -0.01, 0), 0.02),
      ]);
      y.add(new Mesh(wheel, mats.grip));
      k.group.add(y);
      yokes.push(y);
    }
  }
  // Thrust levers on the pedestal.
  throttle = new Group();
  throttle.position.set(cxm, -0.53, -0.55);
  throttle.add(
    new Mesh(
      merged([
        rod(V(-0.05, 0, 0), V(-0.05, 0.1, -0.02), 0.008),
        rod(V(0.05, 0, 0), V(0.05, 0.1, -0.02), 0.008),
        rbox(0.16, 0.025, 0.04, 0.01, 0, 0.11, -0.02),
      ]),
      mats.metal,
    ),
  );
  k.group.add(throttle);
  return { kind: 'airliner', group: k.group, screens: [pfd, nd, eicas], hud: null, stick, throttle, yokes, disposables: k.disposables };
}

// ---------------------------------------------------------------------------
// Light aircraft, helicopter, warbird: the round-gauge cockpits
// ---------------------------------------------------------------------------

function roundGauge(kind: 'light' | 'heli' | 'warbird'): BuiltCockpit {
  const warbird = kind === 'warbird';
  const heli = kind === 'heli';
  const k = kit(warbird ? 0x34465f : 0x71767d, warbird ? 0x26292c : 0x4a4f55);
  const { mats } = k;
  const panelY = heli ? -0.33 : -0.3;
  const panelZ = heli ? -0.68 : -0.72;
  const cx = warbird ? 0 : 0.22;
  const pw = warbird ? 0.62 : 1.1;
  const ph = 0.34;
  k.add(
    [
      rbox(pw, ph, 0.04, 0.01, cx, panelY, panelZ, heli ? 0.35 : 0.08),
      // Glareshield over the panel.
      rbox(pw + 0.06, 0.04, 0.2, 0.02, cx, panelY + ph / 2 + 0.01, panelZ - 0.06),
    ],
    mats.panel,
    'panel',
  );
  const sixpack = makeScreen('sixpack', 1536, 480, 30);
  const sw = warbird ? pw * 0.96 : pw * 0.94;
  // On the panel's face, measured along its tilted normal: offset along world
  // z instead, the tilt leaves the screen a millimetre behind the face.
  const tilt = heli ? 0.35 : 0.08;
  const off = 0.026;
  k.screen(sixpack, sw, sw * (480 / 1536), cx, panelY - Math.sin(tilt) * off, panelZ + Math.cos(tilt) * off, tilt);

  const frame: BufferGeometry[] = [];
  if (warbird) {
    // Windscreen frame just ahead, rails along the sides, the canopy bow behind.
    frame.push(
      rod(V(-0.3, -0.12, -0.64), V(-0.21, 0.19, -0.5), 0.011),
      rod(V(0.3, -0.12, -0.64), V(0.21, 0.19, -0.5), 0.011),
      rod(V(-0.21, 0.19, -0.5), V(0.21, 0.19, -0.5), 0.011),
      rbox(0.06, 0.05, 1.2, 0.015, -0.34, -0.14, -0.05),
      rbox(0.06, 0.05, 1.2, 0.015, 0.34, -0.14, -0.05),
      bow([V(-0.34, -0.12, 0.3), V(-0.26, 0.16, 0.28), V(0, 0.27, 0.27), V(0.26, 0.16, 0.28), V(0.34, -0.12, 0.3)], 0.02),
    );
    // The long nose: the engine cowling filling the bottom of the windscreen.
    const nose = new CylinderGeometry(0.55, 0.62, 3.6, 28, 1, true);
    nose.rotateX(Math.PI / 2);
    nose.translate(0, -0.6, -2.6);
    k.add([nose], k.mats.frame, 'nose');
    // Reflector gunsight on the glareshield.
    const sightMat = new MeshBasicMaterial({ color: 0xffa050, transparent: true, opacity: 0.22, depthWrite: false, side: DoubleSide });
    const sight = new Mesh(new PlaneGeometry(0.09, 0.08), sightMat);
    sight.position.set(0, -0.02, -0.55);
    sight.rotation.x = -0.35;
    k.group.add(sight);
    const reticle = new Mesh(new TorusGeometry(0.018, 0.0012, 6, 40), new MeshBasicMaterial({ color: 0xff8c3a, toneMapped: false }));
    reticle.position.set(0, -0.02, -0.548);
    k.group.add(reticle);
    k.disposables.push(sightMat, sight.geometry, reticle.geometry, reticle.material as Material);
  } else if (heli) {
    // Thin bubble frames: the whole point of a helicopter's cockpit is to see out.
    frame.push(
      bow([V(-0.62, -0.5, -0.4), V(-0.5, 0.05, -0.75), V(-0.3, 0.4, -0.5), V(-0.2, 0.55, 0.1)], 0.018),
      bow([V(0.95, -0.5, -0.4), V(0.85, 0.05, -0.8), V(0.7, 0.4, -0.5), V(0.62, 0.55, 0.1)], 0.018),
      bow([V(0.2, -0.45, -0.85), V(0.2, 0.1, -0.95), V(0.2, 0.45, -0.55), V(0.2, 0.58, 0)], 0.014),
      rbox(1.3, 0.05, 0.6, 0.02, 0.2, 0.6, 0.15),
    );
  } else {
    // Windshield pillars, the centre strip with the compass, the header.
    frame.push(
      rod(V(-0.42, panelY + ph / 2, -0.8), V(-0.5, 0.32, -0.32), 0.03),
      rod(V(0.86, panelY + ph / 2, -0.8), V(0.94, 0.32, -0.32), 0.03),
      rod(V(0.22, panelY + ph / 2 + 0.02, -0.82), V(0.22, 0.33, -0.36), 0.012),
      rbox(1.5, 0.07, 0.14, 0.02, 0.22, 0.34, -0.3),
      rbox(0.06, 0.045, 0.05, 0.01, 0.22, 0.3, -0.38),
    );
  }
  k.add(frame, mats.frame, 'frame');

  // The cabin about the seat.
  if (warbird) {
    k.add(
      [
        rbox(0.035, 0.72, 1.4, 0.012, -0.375, -0.5, -0.05),
        rbox(0.035, 0.72, 1.4, 0.012, 0.375, -0.5, -0.05),
        rbox(0.78, 0.03, 1.4, 0.01, 0, -0.86, -0.05),
        rbox(0.78, 0.8, 0.04, 0.01, 0, -0.46, 0.55),
      ],
      mats.dark,
      'tub',
    );
    // Seat and the armour plate behind the head.
    k.add([rbox(0.42, 0.5, 0.08, 0.02, 0, -0.5, 0.34), rbox(0.36, 0.42, 0.03, 0.01, 0, -0.02, 0.36), rbox(0.42, 0.08, 0.42, 0.02, 0, -0.74, 0.12)], mats.seat, 'seat');
    k.glaze([bubble(0.37, 0.43, 0.64, -0.14, -0.02)], 'canopy');
  } else if (heli) {
    const door = (x: number): BufferGeometry[] => [
      rbox(0.04, 0.46, 1.0, 0.015, x, -0.72, -0.1),
      rbox(0.04, 1.5, 0.5, 0.015, x, -0.2, 0.62),
    ];
    k.add(
      [
        ...door(-0.64),
        ...door(0.98),
        rbox(1.66, 0.03, 1.1, 0.01, 0.17, -0.96, 0.15),
        rbox(1.66, 1.6, 0.04, 0.01, 0.17, -0.2, 0.86),
      ],
      mats.panel,
      'cabin',
    );
    k.add(
      [
        rod(V(-0.64, -0.5, 0.38), V(-0.42, 0.6, 0.36), 0.02),
        rod(V(0.98, -0.5, 0.38), V(0.76, 0.6, 0.36), 0.02),
      ],
      mats.frame,
      'posts',
    );
    k.add([rbox(0.46, 0.7, 0.1, 0.03, 0, -0.5, 0.4), rbox(0.46, 0.7, 0.1, 0.03, 0.8, -0.5, 0.4), rbox(0.46, 0.1, 0.46, 0.03, 0, -0.84, 0.16), rbox(0.46, 0.1, 0.46, 0.03, 0.8, -0.84, 0.16)], mats.grip, 'seats');
  } else {
    // Doors with their armrests, the B-pillars behind the seats, the roof
    // lining, the floor and the back of the cabin.
    const side = (x: number, s: number): BufferGeometry[] => [
      rbox(0.045, 0.74, 1.3, 0.015, x, -0.53, -0.1),
      rbox(0.08, 0.05, 0.55, 0.015, x - s * 0.05, -0.3, 0.0),
      rbox(0.045, 1.24, 0.9, 0.015, x, -0.27, 0.9),
    ];
    k.add(
      [...side(-0.53, -1), ...side(0.97, 1), rbox(1.54, 0.035, 1.5, 0.01, 0.22, 0.37, 0.28), rbox(1.54, 0.03, 1.7, 0.01, 0.22, -0.9, 0.05), rbox(1.54, 1.3, 0.04, 0.01, 0.22, -0.27, 1.32)],
      mats.panel,
      'cabin',
    );
    k.add(
      [
        rod(V(-0.53, -0.16, 0.45), V(-0.51, 0.36, 0.42), 0.028),
        rod(V(0.97, -0.16, 0.45), V(0.95, 0.36, 0.42), 0.028),
        rod(V(-0.52, -0.16, -0.78), V(-0.53, -0.16, 0.45), 0.02),
        rod(V(0.96, -0.16, -0.78), V(0.97, -0.16, 0.45), 0.02),
        rod(V(-0.5, 0.33, -0.32), V(-0.51, 0.36, 0.45), 0.02),
        rod(V(0.94, 0.33, -0.32), V(0.95, 0.36, 0.45), 0.02),
      ],
      mats.frame,
      'doorframes',
    );
    const seat = (x: number): BufferGeometry[] => [rbox(0.44, 0.62, 0.1, 0.04, x, -0.48, 0.38), rbox(0.44, 0.1, 0.46, 0.04, x, -0.78, 0.14)];
    k.add([...seat(0), ...seat(0.44)], mats.grip, 'seats');
    k.glaze([pane(-0.46, 0.9, panelY + ph / 2, -0.8, 0.32, -0.33)], 'windshield');
  }

  const yokes: Object3D[] = [];
  let stick: Object3D | null = null;
  if (warbird || heli) {
    stick = new Group();
    stick.position.set(0, -0.62, -0.28);
    stick.add(new Mesh(merged([rod(V(0, 0, 0), V(0, 0.22, -0.02), 0.012), rbox(0.035, 0.09, 0.04, 0.015, 0, 0.26, -0.03)]), mats.grip));
    k.group.add(stick);
  } else {
    const y = new Group();
    y.position.set(0, -0.36, -0.52);
    y.add(
      new Mesh(
        merged([
          rbox(0.28, 0.03, 0.03, 0.014, 0, 0, 0),
          rbox(0.032, 0.1, 0.035, 0.014, -0.14, 0.035, 0),
          rbox(0.032, 0.1, 0.035, 0.014, 0.14, 0.035, 0),
          rod(V(0, 0, -0.22), V(0, 0, 0), 0.012),
        ]),
        mats.grip,
      ),
    );
    k.group.add(y);
    yokes.push(y);
  }
  const throttle = new Group();
  throttle.position.set(warbird || heli ? -0.3 : cx, warbird || heli ? -0.45 : panelY - ph / 2 + 0.03, warbird || heli ? -0.3 : panelZ + 0.03);
  throttle.add(new Mesh(merged([rod(V(0, 0, -0.06), V(0, 0, 0.04), 0.005), rbox(0.035, 0.035, 0.03, 0.012, 0, 0, 0.05)]), mats.grip));
  k.group.add(throttle);
  return { kind, group: k.group, screens: [sixpack], hud: null, stick, throttle, yokes, disposables: k.disposables };
}

export function buildCockpit(kind: CockpitKind, sidestick: boolean, fit?: CockpitFit | null): BuiltCockpit {
  if (fit) return fitted(kind, fit);
  switch (kind) {
    case 'fighter':
      return fighter();
    case 'airliner':
      return airliner(sidestick);
    default:
      return roundGauge(kind);
  }
}
