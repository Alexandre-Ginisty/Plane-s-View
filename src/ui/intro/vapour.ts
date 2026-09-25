/**
 * Wingtip vapour, for the front page.
 *
 * ## Why this is a ribbon and not a line
 *
 * Three versions were tried. A single line is a wire. Five parallel lines is
 * five wires. Eleven lines widening with distance is eleven wires fanning out —
 * each one resolvable, none of them smoke, because a line primitive is exactly
 * one pixel wide however far away it is and no number of them adds up to a
 * surface.
 *
 * What vapour needs is *area* with a soft edge, so this is a ribbon: a strip of
 * triangles down the trail, rebuilt each frame to face the camera, with the
 * alpha falling to nothing at both edges. Turned edge-on a fixed ribbon
 * disappears, which is why it is rebuilt rather than placed once — the cost is
 * a few dozen vertices a frame.
 *
 * ## What it is a picture of
 *
 * The white trails off a wing in humid air are the cores of the wingtip
 * vortices condensing. They leave *at* the tip, roll inboard and sink behind
 * the aircraft, and spread as the vortex decays. Two straight lines is the
 * version that looks wrong without anyone being able to say why.
 *
 * ## Why the tips are measured rather than looked up
 *
 * The first version took the half-span from the procedural shape table, which
 * describes the *type* rather than the model being drawn. The two do not agree:
 * the table is a hand-entered ratio and the converted airframe is normalised by
 * its own bounding box, so the trails left the wing somewhere inboard of the
 * tip and hung in the air beside it. On a page whose whole claim is that these
 * aircraft are real, a detached contrail is the detail that gives it away.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Vector3,
  type Camera,
  type Object3D,
} from 'three';

/**
 * Wingtip vapour.
 *
 * ## Why this is a ribbon and not a line
 *
 * Three versions were tried. A single line is a wire. Five parallel lines is
 * five wires. Eleven lines widening with distance is eleven wires fanning out —
 * each one resolvable, none of them smoke, because a line primitive is exactly
 * one pixel wide however far away it is and no number of them adds up to a
 * surface.
 *
 * What vapour needs is *area* with a soft edge, so this is a ribbon: a strip of
 * triangles down the trail, rebuilt each frame to face the camera, with the
 * alpha falling to nothing at both edges. Turned edge-on a fixed ribbon
 * disappears, which is why it is rebuilt rather than placed once — the cost is
 * a few dozen vertices a frame.
 *
 * ## What it is a picture of
 *
 * The white trails off a wing in humid air are the cores of the wingtip
 * vortices condensing. They leave *at* the tip, roll inboard and sink behind
 * the aircraft, and spread as the vortex decays. Two straight lines is the
 * version that looks wrong without anyone being able to say why.
 */
const VAPOUR = {
  /** Stations along each trail. Only the ribbon's smoothness depends on it. */
  stations: 72,
  /** How far back the trail persists, in model lengths. */
  length: 11,
  /** Radius of the vortex curl at the far end. */
  curl: 0.2,
  /** Turns of curl over the whole trail. */
  curlTurns: 2.4,
  /** How much the pair drifts together behind the aircraft. */
  convergence: 0.12,
  /** How far the cores sink over the whole trail. */
  sink: 0.5,
  /** Ribbon half-width at the tip, and at the far end as it disperses. */
  widthNear: 0.012,
  widthFar: 0.16,
} as const;

/**
 * How the vapour is drawn, per theme.
 *
 * Additive blending only ever brightens, which is exactly right against a
 * black sky and useless against a white page — adding white to white is
 * nothing, and what survives is the geometry's own edge, which reads as a grey
 * smear. On a light background the trail has to be *darker* than what is
 * behind it, so it is drawn normally in a soft blue-grey, the colour a contrail
 * actually is when it is between you and a bright sky.
 */
const VAPOUR_STYLE = {
  dark: { blending: AdditiveBlending, colour: 0xffffff, opacity: 0.8 },
  light: { blending: NormalBlending, colour: 0x8ba6bd, opacity: 0.5 },
} as const;

/**
 * Where the wings actually end, measured from the geometry that is on screen.
 *
 * The widest point of an aircraft is the wingtip — no stabiliser, pod or
 * antenna comes close — so the extreme vertex on each side *is* the tip, and
 * taking its full position rather than just its span puts the trail at the
 * right height and the right distance aft as well.
 */
export function wingtipsOf(geometries: readonly BufferGeometry[]): [Vector3, Vector3] | null {
  const left = new Vector3(Infinity, 0, 0);
  const right = new Vector3(-Infinity, 0, 0);

  for (const geometry of geometries) {
    const position = geometry.getAttribute('position');
    if (!position) continue;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      if (x < left.x) left.set(x, position.getY(i), position.getZ(i));
      if (x > right.x) right.set(x, position.getY(i), position.getZ(i));
    }
  }

  return Number.isFinite(left.x) && Number.isFinite(right.x) ? [left, right] : null;
}

export interface Vapour {
  /** Lay the trails out from a measured pair of wingtips. */
  attachTo(tips: [Vector3, Vector3]): void;
  /** Re-face the ribbon and advance the flow. Call once a frame. */
  update(elapsedSec: number): void;
  setTheme(theme: 'dark' | 'light'): void;
  dispose(): void;
}

/** Build the trails and add them to `parent`, which carries the aircraft. */
export function createVapour(
  camera: Camera,
  parent: Object3D,
  theme: 'dark' | 'light',
): Vapour {
  /*
   * The vapour trails.
   *
   * The centreline is fixed in the aircraft's frame — relative to the
   * aeroplane the trail is a static shape, and it is the aeroplane that
   * moves — so only the ribbon's width direction is recomputed per frame.
   */
  const VAPOUR_SIDES = 2;
  /** Three vertices per station: soft edge, bright core, soft edge. */
  const VAPOUR_ACROSS = 3;
  const vapourVertexCount = VAPOUR_SIDES * VAPOUR.stations * VAPOUR_ACROSS;

  /** Centreline points, in the aircraft frame. Written once per tip change. */
  const vapourSpine = new Float32Array(VAPOUR_SIDES * VAPOUR.stations * 3);
  const vapourPositions = new Float32Array(vapourVertexCount * 3);
  const vapourColours = new Float32Array(vapourVertexCount * 3);

  const vapourIndices: number[] = [];
  for (let side = 0; side < VAPOUR_SIDES; side++) {
    const base = side * VAPOUR.stations * VAPOUR_ACROSS;
    for (let i = 0; i < VAPOUR.stations - 1; i++) {
      const a = base + i * VAPOUR_ACROSS;
      const b = a + VAPOUR_ACROSS;
      // Two quads per station pair: edge-to-core and core-to-edge.
      for (const o of [0, 1]) {
        vapourIndices.push(a + o, b + o, a + o + 1, a + o + 1, b + o, b + o + 1);
      }
    }
  }

  const vapourGeometry = new BufferGeometry();
  vapourGeometry.setAttribute('position', new BufferAttribute(vapourPositions, 3));
  vapourGeometry.setAttribute('color', new BufferAttribute(vapourColours, 3));
  vapourGeometry.setIndex(vapourIndices);

  const vapourMaterial = new MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  function applyVapourStyle(theme: 'dark' | 'light'): void {
    const style = VAPOUR_STYLE[theme];
    vapourMaterial.blending = style.blending;
    vapourMaterial.color.setHex(style.colour);
    vapourMaterial.opacity = style.opacity;
    vapourMaterial.needsUpdate = true;
  }

  applyVapourStyle(theme);
  const vapour = new Mesh(vapourGeometry, vapourMaterial);
  vapour.frustumCulled = false;
  vapour.visible = false;
  parent.add(vapour);

  /** Lay the centreline out from a measured pair of wingtips. */
  function layOutVapour([left, right]: [Vector3, Vector3]): void {
    let cursor = 0;
    for (const tip of [left, right]) {
      // Inboard is towards the centreline, whichever side this tip is on.
      const inboard = tip.x > 0 ? -1 : 1;
      for (let i = 0; i < VAPOUR.stations; i++) {
        const t = i / (VAPOUR.stations - 1);
        const angle = t * VAPOUR.curlTurns * Math.PI * 2;
        const grow = VAPOUR.curl * t;
        vapourSpine[cursor] =
          tip.x + inboard * VAPOUR.convergence * t * t + Math.cos(angle) * grow;
        vapourSpine[cursor + 1] = tip.y - t * VAPOUR.length;
        vapourSpine[cursor + 2] = tip.z + Math.sin(angle) * grow - VAPOUR.sink * t;
        cursor += 3;
      }
    }
    vapour.visible = true;
  }

  const _eye = new Vector3();
  const _point = new Vector3();
  const _next = new Vector3();
  const _tangent = new Vector3();
  const _toEye = new Vector3();
  const _across = new Vector3();

  /**
   * Rebuild the ribbon to face the camera, and fade it along its length.
   *
   * The width direction is the trail's tangent crossed with the direction to
   * the eye, which is the one axis that is always perpendicular to both — so
   * the ribbon presents its full width from wherever it is seen, including
   * while the aeroplane turns underneath it.
   */
  function updateVapour(t: number): void {
    if (!vapour.visible) return;

    // The eye, in the frame the spine is written in.
    _eye.setFromMatrixPosition(camera.matrixWorld);
    vapour.worldToLocal(_eye);

    let vertex = 0;
    for (let side = 0; side < VAPOUR_SIDES; side++) {
      for (let i = 0; i < VAPOUR.stations; i++) {
        const spine = (side * VAPOUR.stations + i) * 3;
        _point.set(vapourSpine[spine]!, vapourSpine[spine + 1]!, vapourSpine[spine + 2]!);

        // Tangent from the neighbouring station; the last one reuses the
        // previous segment rather than reading past the end of the trail.
        const nextIndex = i === VAPOUR.stations - 1 ? i - 1 : i + 1;
        const nextSpine = (side * VAPOUR.stations + nextIndex) * 3;
        _next.set(
          vapourSpine[nextSpine]!,
          vapourSpine[nextSpine + 1]!,
          vapourSpine[nextSpine + 2]!,
        );
        _tangent.subVectors(_next, _point);
        if (i === VAPOUR.stations - 1) _tangent.negate();

        _toEye.subVectors(_eye, _point);
        _across.crossVectors(_tangent, _toEye);
        if (_across.lengthSq() < 1e-12) _across.set(1, 0, 0);
        _across.normalize();

        const u = i / (VAPOUR.stations - 1);
        const halfWidth = VAPOUR.widthNear + (VAPOUR.widthFar - VAPOUR.widthNear) * u;

        // The core takes a moment to condense, then dissolves. The travelling
        // ripple is what sells it as something being left behind.
        const onset = Math.min(1, u / 0.02);
        const decay = Math.pow(1 - u, 1.5);
        const ripple = 0.74 + 0.26 * Math.sin(u * 26 - t * 2.2 + side * 1.7);
        const core = onset * decay * ripple;

        for (let k = 0; k < VAPOUR_ACROSS; k++) {
          const offset = (k - 1) * halfWidth;
          const o = vertex * 3;
          vapourPositions[o] = _point.x + _across.x * offset;
          vapourPositions[o + 1] = _point.y + _across.y * offset;
          vapourPositions[o + 2] = _point.z + _across.z * offset;

          // Zero at both edges, full in the middle: the soft boundary is the
          // whole difference between vapour and a painted stripe.
          const value = k === 1 ? core : 0;
          vapourColours[o] = value;
          vapourColours[o + 1] = value;
          vapourColours[o + 2] = value;
          vertex++;
        }
      }
    }

    vapourGeometry.attributes['position']!.needsUpdate = true;
    vapourGeometry.attributes['color']!.needsUpdate = true;
  }

  return {
    attachTo: layOutVapour,
    update: updateVapour,
    setTheme: applyVapourStyle,
    dispose(): void {
      vapourGeometry.dispose();
      vapourMaterial.dispose();
    },
  };
}
