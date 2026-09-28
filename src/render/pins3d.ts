/**
 * The user's pins, seen from the aircraft.
 *
 * A pin on the 2D map is a promise: "show me this place from up there". From
 * cruise that place is a few pixels of photograph among millions, so each pin
 * becomes a beacon — a column of light standing on the ground, and a dot that
 * holds its size on screen however far away it is — with the name and the
 * distance written beside it.
 *
 * ## Sized by distance, on purpose
 *
 * Unlike the traffic (see `traffic3d.ts`), these are not objects in the world
 * that must look true to scale. They are markers, and a marker that shrinks to
 * nothing at 80 km has failed at the only thing it is for. The beam's width
 * and height follow the distance so it stays a few pixels wide and a clear
 * vertical stroke; the dot is a sprite with size attenuation off.
 *
 * They do test depth, though. A beacon behind a mountain is hidden by the
 * mountain, which is both correct and useful — it says where the place is,
 * not just which way.
 *
 * ## The labels
 *
 * Drawn on a 2D canvas over the WebGL one, projected from the beacon's
 * position every frame — the same approach as the map's place names, and for
 * the same reasons: real text, crisp, and moving in lockstep with the scene.
 */

import {
  BufferAttribute,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector3,
  type PerspectiveCamera,
} from 'three';

import { enuBasis, geodeticToEcef } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import type { Pin } from '@/state/appStore.svelte';
import type { OverlayFrame } from './overlay';

/** Beacon colour. Warm, so it never reads as sky, sea or a cockpit instrument. */
const COLOR = 0xffb347;
/** Past this distance a pin is not drawn, metres. Well beyond the horizon at cruise. */
const MAX_RANGE_M = 450_000;
/** Beam height as a fraction of the distance to it, and its limits, metres. */
const BEAM_HEIGHT_RATIO = 0.05;
const BEAM_MIN_M = 300;
const BEAM_MAX_M = 9_000;
/** Beam width on screen, pixels. */
const BEAM_WIDTH_PX = 4;

interface Beacon {
  group: Group;
  beam: Mesh;
  dot: Sprite;
  /** Last good terrain height under the pin; NaN until one is known. */
  groundM: number;
  /** Where the label goes, in the scene's floating frame. */
  anchor: Vector3;
  distanceM: number;
  visible: boolean;
  name: string;
}

const _ecef = new Vector3();
const _up = new Vector3();
const _p = new Vector3();

/** A soft round dot, for the sprite. */
function dotTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.22, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.3)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
}

export class Pins3D {
  readonly scene = new Scene();
  private readonly beacons = new Map<string, Beacon>();

  /**
   * A unit beam: radius 1, height 1, standing on its base, fading out towards
   * the top through a per-vertex alpha — a gradient without a custom shader,
   * so the logarithmic depth buffer keeps working.
   *
   * Ordinary blending, not additive. Additive light is invisible against the
   * thing a beacon is most often seen against — a pale daytime sky near the
   * horizon — where it washed out to a white smudge.
   */
  private readonly beamGeometry = (() => {
    const g = new CylinderGeometry(1, 1, 1, 10, 8, true);
    g.translate(0, 0.5, 0);
    const pos = g.getAttribute('position');
    const colors = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      const t = 1 - pos.getY(i);
      colors[i * 4] = 1;
      colors[i * 4 + 1] = 0.66;
      colors[i * 4 + 2] = 0.2;
      colors[i * 4 + 3] = 0.9 * t ** 1.4;
    }
    g.setAttribute('color', new BufferAttribute(colors, 4));
    return g;
  })();

  private readonly beamMaterial = new MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });

  private readonly dotMaterial = new SpriteMaterial({
    map: dotTexture(),
    color: COLOR,
    transparent: true,
    depthWrite: false,
    sizeAttenuation: false,
  });

  constructor(private readonly origin: FloatingOrigin) {
    this.scene.matrixAutoUpdate = false;
  }

  /**
   * Place every beacon for this frame. `camera` must already be where it will
   * render from; `heightAt` is the terrain the globe has streamed.
   */
  update(
    pins: readonly Pin[],
    camera: PerspectiveCamera,
    viewportHeight: number,
    heightAt: (lat: number, lon: number) => number,
  ): void {
    const keep = new Set<string>();
    const radiansPerPixel = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, viewportHeight);

    for (const pin of pins) {
      keep.add(pin.id);
      let b = this.beacons.get(pin.id);
      if (!b) {
        b = this.create();
        this.beacons.set(pin.id, b);
      }
      b.name = pin.name;

      // Terrain streams in and out; hold the last good answer so the beacon
      // does not drop to the ellipsoid whenever the tile under it is evicted.
      const h = heightAt(pin.lat, pin.lon);
      if (Number.isFinite(h)) b.groundM = h;
      const ground = Number.isFinite(b.groundM) ? b.groundM : 0;

      const e = geodeticToEcef(pin.lat, pin.lon, ground);
      _ecef.set(e[0] - this.origin.current[0], e[1] - this.origin.current[1], e[2] - this.origin.current[2]);
      const distance = _ecef.distanceTo(camera.position);
      b.distanceM = distance;
      b.visible = distance < MAX_RANGE_M;
      b.group.visible = b.visible;
      if (!b.visible) continue;

      const { up } = enuBasis(pin.lat, pin.lon);
      _up.set(up[0], up[1], up[2]);

      const height = Math.min(BEAM_MAX_M, Math.max(BEAM_MIN_M, distance * BEAM_HEIGHT_RATIO));
      const radius = Math.max(4, (distance * radiansPerPixel * BEAM_WIDTH_PX) / 2);

      b.group.position.copy(_ecef);
      b.group.quaternion.setFromUnitVectors(_p.set(0, 1, 0), _up);
      b.beam.scale.set(radius, height, radius);
      // Just off the ground, so the dot does not z-fight the terrain it
      // marks or sink into it where the heightmap is coarse.
      b.dot.position.set(0, Math.max(15, height * 0.02), 0);
      b.group.updateMatrix();
      b.group.updateMatrixWorld(true);

      // The label sits a little above the ground, where the eye finds the
      // beam, rather than at the base where it would sit in the terrain.
      b.anchor.copy(_ecef).addScaledVector(_up, height * 0.25);
    }

    for (const [id, b] of this.beacons) {
      if (keep.has(id)) continue;
      this.scene.remove(b.group);
      this.beacons.delete(id);
    }
  }

  /** Names and distances, over the view. Call after `update`, every frame. */
  drawLabels(frame: OverlayFrame, camera: PerspectiveCamera): void {
    if (this.beacons.size === 0) return;
    const { ctx, width: w, height: h, palette } = frame;

    camera.updateMatrixWorld();
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    for (const b of this.beacons.values()) {
      if (!b.visible) continue;
      _p.copy(b.anchor).project(camera);
      // Behind the camera, or outside the frame.
      if (_p.z > 1 || _p.x < -1.2 || _p.x > 1.2 || _p.y < -1.2 || _p.y > 1.2) continue;
      frame.drew = true;
      const x = (_p.x * 0.5 + 0.5) * w + 10;
      const y = (-_p.y * 0.5 + 0.5) * h;

      const km = b.distanceM / 1000;
      const dist = km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;

      ctx.font = `600 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.strokeStyle = palette.light ? 'rgba(40,22,4,0.75)' : 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 3;
      ctx.strokeText(b.name, x, y - 7);
      ctx.fillStyle = '#ffd9a3';
      ctx.fillText(b.name, x, y - 7);

      ctx.font = `400 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.strokeText(dist, x, y + 8);
      ctx.fillStyle = 'rgba(255,235,210,0.8)';
      ctx.fillText(dist, x, y + 8);
    }
  }

  private create(): Beacon {
    const group = new Group();
    group.matrixAutoUpdate = false;

    const beam = new Mesh(this.beamGeometry, this.beamMaterial);
    beam.frustumCulled = false;
    beam.renderOrder = 3;

    const dot = new Sprite(this.dotMaterial);
    // Fraction of the viewport height, with size attenuation off.
    dot.scale.set(0.035, 0.035, 1);
    dot.renderOrder = 4;
    dot.frustumCulled = false;

    group.add(beam, dot);
    this.scene.add(group);
    return { group, beam, dot, groundM: Number.NaN, anchor: new Vector3(), distanceM: Infinity, visible: false, name: '' };
  }

  dispose(): void {
    for (const b of this.beacons.values()) this.scene.remove(b.group);
    this.beacons.clear();
    this.beamGeometry.dispose();
    this.beamMaterial.dispose();
    this.dotMaterial.map?.dispose();
    this.dotMaterial.dispose();
  }
}
