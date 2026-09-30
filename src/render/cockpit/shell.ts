/**
 * The aeroplane around the cockpit: the real model, seen from the seat.
 *
 * A cockpit alone floats. Look left from a panel with nothing round it and
 * there is sky where the canopy rail, the intake, the wing and the tail should
 * be — the "sitting in the void" that makes a first-person view read as a
 * camera with a dashboard stuck to it. So the type's own model is drawn about
 * the eye, in the cockpit pass, fixed to the same attitude as the panel: the
 * nose ahead, the wing root and the wing under the elbow, the fins behind.
 *
 * ## Where the eye is
 *
 * Every model is unit length, nose +Y, up +Z, centred on its bounding box —
 * which says nothing about where a pilot sits. The eye is measured per model
 * from its canopy: about a metre and a half behind the windscreen's base and a
 * third of a metre under the glass (see `EYES`). Only models with a measured
 * eye get a shell; a guessed one puts the eye inside the skin, and from inside
 * a two-sided hull there is nothing to see at all.
 *
 * ## What is left out
 *
 *  - The canopy: every triangle in the volume over the sills about the head
 *    (`CLEARANCE`). Source models tint the glass anything from invisible to
 *    three quarters opaque, some paint it on opaque quads meant for an alpha
 *    channel the converter does not carry, and some merge the aft fairing
 *    into the intake — seen from the seat, all of it is a white wall a
 *    hand's breadth from the eye. The cockpit supplies its own glass, rails
 *    and bow, so the cut is never seen as a cut.
 *  - The interior near the eye: the model's own pilot (whose head is where
 *    the camera is), seat, stick and panel, anything wholly inside the cockpit
 *    volume. The cockpit is drawn over what remains in any case — see
 *    `Cockpit` — so a model interior shows only in gaps, as the dark tub it
 *    is.
 *  - Moving parts: gear (under the floor), propellers and rotors, whose
 *    animation belongs to the outside model.
 *
 * ## Around a modelled cockpit
 *
 * A real cockpit converted from the same FlightGear aircraft (see
 * `modelled.ts`) brings its own eye, in this model's frame, and fits inside
 * the airframe as it does in the simulator. Then nothing is cut but the glass:
 * the cuts above exist to make room for a generic cockpit that was never
 * shaped to this fuselage.
 *
 * ## Around a cabin
 *
 * From a window seat the fuselage's skin is a hand's breadth from the head,
 * painted with the very window being looked through. The cabin's sidewall has
 * the opening; the skin behind it is cleared by the shader within `clearM` of
 * the eye, so what the window shows is the wing, the engine and the sky. The
 * fuselage being convex, nothing else of it could be seen from there anyway.
 *
 * Geometry and materials are the shared, cached model's: nothing here is
 * disposed except the meshes' wrappers — and, about a cabin, the cleared
 * copies of the materials.
 */

import { Box3, BufferAttribute, BufferGeometry, Group, Mesh, Vector3, type Material } from 'three';

import type { LoadedModel } from '@/render/aircraft/pvm';

/** The design eye, as a fraction of length: `y` forward of centre, `z` above it. */
interface Eye {
  /** Right of the centreline: only a modelled cockpit's (a pilot's seat) is off it. */
  x?: number;
  y: number;
  z: number;
  /** Parts to leave out beyond the glass, by name. */
  drop?: RegExp;
}

/**
 * Measured from each model's canopy (glass extents, windscreen base) and
 * checked from the seat. See the module comment for the rule.
 */
const EYES: Record<string, Eye> = {
  f16: { y: 0.175, z: 0.001 },
  f18: { y: 0.245, z: 0.031, drop: /HUD/ },
  f15: { y: 0.245, z: 0.034 },
  f14: { y: 0.242, z: 0.049, drop: /^Canopy_\d|Inside/ },
  m2k: { y: 0.198, z: 0.0105, drop: /verriere/i },
  jas39: { y: 0.165, z: 0.0052, drop: /verriere/i },
  mig21: { y: 0.155, z: 0.019 },
  a10: { y: 0.31, z: 0.056, drop: /CPT|Inner/ },
  su25: { y: 0.213, z: 0.014 },
  ah64: { y: 0.265, z: 0.02 },
  f4u: { y: 0.01, z: 0.11, drop: /^canopy$/ },
  p51: { y: 0.11, z: 0.09 },
};

/**
 * The canopy volume about the eye, metres, model axes, cleared of the model's
 * geometry. From just over the sills up, from behind the seat's bow to the
 * windscreen's base.
 */
const CLEARANCE: Record<'fighter' | 'warbird' | 'heli', Box3> = {
  fighter: new Box3(new Vector3(-0.42, -0.62, -0.19), new Vector3(0.42, 1.8, 0.9)),
  warbird: new Box3(new Vector3(-0.4, -0.5, -0.12), new Vector3(0.4, 1.0, 0.8)),
  heli: new Box3(new Vector3(-0.62, -0.55, -0.3), new Vector3(0.62, 1.1, 0.9)),
};

const GLASS = /glass|verri|windsh|windscr|canopy(back)?(in|out)side|transp/i;
const CREW = /pilot|helmet|visor|head|body|arm|hand|leg|seat|stick|pedal/i;

/** The cockpit volume about the eye, metres, in the model's axes (x right, y forward, z up). */
const INSIDE = new Box3(new Vector3(-0.55, -1.1, -1.2), new Vector3(0.55, 1.0, 0.45));

const NEAR = new Box3(new Vector3(-1.8, -2, -1.6), new Vector3(1.8, 2, 1.2));

/**
 * The model placed about the eye: a group in the cockpit's frame (+X right,
 * +Y up, −Z forward, eye at the origin), `lengthM` long.
 */
export function buildShell(
  model: LoadedModel,
  lengthM: number,
  kind: string,
  /** The eye a modelled cockpit was built about, which wins over the measured one. */
  eyeAt?: readonly [number, number, number] | null,
  /** Metres about the eye within which nothing is drawn: the skin by a window seat. */
  clearM = 0,
): Shell | null {
  const measured = EYES[model.id];
  const eye: Eye | undefined = eyeAt ? { x: eyeAt[0], y: eyeAt[1], z: eyeAt[2], drop: measured?.drop } : measured;
  if (!eye) return null;
  const clear = CLEARANCE[kind as keyof typeof CLEARANCE] ?? CLEARANCE.fighter;
  const owned: BufferGeometry[] = [];
  const cleared = new Map<Material, Material>();
  const materialFor = (m: Material): Material => {
    if (!clearM) return m;
    let c = cleared.get(m);
    if (!c) {
      c = m.clone();
      c.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>\n\tif (dot(vViewPosition, vViewPosition) < ${(clearM * clearM).toFixed(4)}) discard;`,
        );
      };
      c.customProgramCacheKey = () => `shell-clear-${clearM}`;
      cleared.set(m, c);
    }
    return c;
  };

  const inner = new Group();
  inner.name = 'shell-model';
  // Model axes to the cockpit's: forward +Y becomes −Z, up +Z becomes +Y.
  inner.rotation.x = -Math.PI / 2;
  inner.scale.setScalar(lengthM);
  // After that rotation a model point (x, y, z) lands at (x, z, −y), so the
  // eye's (x, y, z) is at (x, z, −y): move it to the origin.
  const ex = eye.x ?? 0;
  inner.position.set(-ex * lengthM, -eye.z * lengthM, eye.y * lengthM);

  const box = new Box3();
  const eyeM = new Vector3(ex * lengthM, eye.y * lengthM, eye.z * lengthM);
  for (const part of model.parts) {
    if (part.role !== 'hull') continue;
    if (part.material.opacity < 0.999 || GLASS.test(part.name) || eye.drop?.test(part.name)) continue;
    const g = part.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    box.copy(g.boundingBox!);
    box.min.multiplyScalar(lengthM).sub(eyeM);
    box.max.multiplyScalar(lengthM).sub(eyeM);
    let geometry: BufferGeometry | null = g;
    // A modelled cockpit was built for this very airframe and fits inside it
    // as it does in the simulator: nothing needs cutting away but the glass.
    if (eyeAt) {
      // Keep all of it.
    } else if (INSIDE.containsBox(box) || (CREW.test(part.name) && box.intersectsBox(INSIDE))) {
      // Wholly inside the cockpit: the model's own interior, crew, and gear.
      continue;
    } else if (box.intersectsBox(clear)) {
      geometry = withoutCanopy(g, lengthM, eyeM, clear);
      if (!geometry) continue;
      if (geometry !== g) owned.push(geometry);
    }

    const mesh = new Mesh(geometry, materialFor(part.material));
    mesh.name = part.name;
    // Only what is near enough to shade the panel goes into the shadow map:
    // the canopy rails and the fuselage about the cockpit, not the tail.
    mesh.castShadow = box.intersectsBox(NEAR);
    mesh.receiveShadow = false;
    // Behind the cockpit: drawn first, then the depth is cleared for the
    // panel (see `Cockpit`).
    mesh.renderOrder = -10;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    inner.add(mesh);
  }

  const group = new Group();
  group.name = 'shell';
  group.add(inner);
  return {
    group,
    dispose: () => {
      owned.forEach((o) => o.dispose());
      cleared.forEach((m) => m.dispose());
    },
  };
}

export interface Shell {
  group: Group;
  /** The trimmed geometries made for this shell; the rest is the cache's. */
  dispose(): void;
}

const _a = new Vector3();

function inside(pos: BufferGeometry['attributes'][string], i: number, lengthM: number, eyeM: Vector3, clear: Box3): boolean {
  _a.set(pos.getX(i), pos.getY(i), pos.getZ(i)).multiplyScalar(lengthM).sub(eyeM);
  return clear.containsPoint(_a);
}

/**
 * The part without the triangles touching the clearance: the
 * same vertex buffers, a new index. Null when nothing is left, the original
 * when nothing was inside.
 */
function withoutCanopy(g: BufferGeometry, lengthM: number, eyeM: Vector3, clear: Box3): BufferGeometry | null {
  const index = g.getIndex();
  const pos = g.getAttribute('position');
  if (!index) return g;
  const src = index.array;
  const kept = new Uint32Array(src.length);
  let n = 0;
  for (let t = 0; t < src.length; t += 3) {
    const i0 = src[t]!, i1 = src[t + 1]!, i2 = src[t + 2]!;
    // Any corner inside, not the centre: a long triangle from the canopy to
    // the tail has its centre far outside and still walls off the view.
    if (inside(pos, i0, lengthM, eyeM, clear) || inside(pos, i1, lengthM, eyeM, clear) || inside(pos, i2, lengthM, eyeM, clear)) continue;
    kept[n++] = i0;
    kept[n++] = i1;
    kept[n++] = i2;
  }
  if (n === src.length) return g;
  if (n === 0) return null;
  const out = new BufferGeometry();
  for (const name of Object.keys(g.attributes)) out.setAttribute(name, g.getAttribute(name));
  out.setIndex(new BufferAttribute(kept.slice(0, n), 1));
  out.boundingSphere = g.boundingSphere;
  return out;
}
