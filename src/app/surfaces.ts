/**
 * Building the 3D stack.
 *
 * The renderer, the globe, the two aircraft layers and the camera controller,
 * constructed and wired together in dependency order. Gathered here because
 * the *quality ceiling* is set at construction and is the single most
 * consequential decision in the app's appearance — it deserves to be read next
 * to the reasoning rather than found halfway down a boot sequence.
 */

import type { FloatingOrigin } from '@/core/frame';
import { networkMonitor } from '@/net/quality';
import { Engine } from '@/render/engine';
import { Globe } from '@/render/globe';
import { OwnAircraft } from '@/render/ownAircraft';
import { PovController } from '@/render/pov';
import { Traffic3D } from '@/render/traffic3d';

export interface Surfaces {
  engine: Engine;
  globe: Globe;
  traffic3d: Traffic3D;
  ownAircraft: OwnAircraft;
  pov: PovController;
}

export function createSurfaces(canvas: HTMLCanvasElement, origin: FloatingOrigin): Surfaces {
  /*
   * Vertical field of view, degrees.
   *
   * 50, not the 60 this started at. Two reasons, and the second is the one
   * that shows.
   *
   * A wide angle flattens the sense of height: everything is pushed towards
   * the centre and shrunk, so from FL350 the ground reads as further away
   * than it is and the view stops feeling like it is at the altitude the
   * flight card claims. Measured, the eye *was* at 35 158 ft against a
   * reported FL352 — the geometry was never wrong, the framing was.
   *
   * And a narrower cone is less ground. Visible area falls roughly with the
   * square of the angle, so the same tile budget and the same link buy
   * noticeably more detail per pixel, and the quadtree reaches a usable zoom
   * sooner. Detail follows altitude through the screen-space error either
   * way; this just stops the periphery spending it.
   */
  const engine = new Engine(canvas, { fov: 50 });

  /*
   * The ceiling, not the operating point.
   *
   * The connection profile lowers both when it has to (see `@/net/quality`),
   * so what is set here is what the app allows at its best rather than what
   * it settles for at its worst.
   *
   * 1 is screen pixels per imagery texel — refine until the texture is at
   * native resolution, then stop. It reads like a lower quality setting than
   * the 2.2 it replaces and is the opposite: the old number was measured
   * against the 32-cell terrain mesh rather than the 256 texels, so it asked
   * for three levels past anything the screen can resolve and the ground
   * never arrived at all. See `REFINE_TEXELS`.
   */
  const globe = new Globe(origin, { maxScreenSpaceError: 1, maxZoom: 18 });

  // Terrain is almost always seen at a grazing angle from a cockpit, which is
  // the exact case trilinear filtering smears into a band a few hundred metres
  // ahead. This is the cheapest single improvement available to the ground's
  // appearance, and the renderer's own maximum is the right value because the
  // cost is per-texel, not per-frame.
  globe.setAnisotropy(engine.renderer.capabilities.getMaxAnisotropy());
  globe.applyProfile(networkMonitor.profile);

  const traffic3d = new Traffic3D(origin);
  const ownAircraft = new OwnAircraft(origin);
  const pov = new PovController(origin);

  engine.scene.add(globe.scene);
  engine.scene.add(traffic3d.scene);
  engine.scene.add(ownAircraft.scene);

  return { engine, globe, traffic3d, ownAircraft, pov };
}
