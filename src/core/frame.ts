/**
 * Floating origin.
 *
 * ECEF coordinates are ~6.4e6 metres. A float32 has ~7 significant decimal
 * digits, so an ECEF position stored in a GPU buffer quantises to roughly
 * **half a metre** — and the jitter is *correlated with camera motion*, which
 * reads as the whole world shimmering. That is fatal for a cockpit view where
 * the camera sits 10 m above the terrain.
 *
 * The fix is standard: keep a double-precision origin near the camera, and
 * upload everything relative to it. Vertex data stays in the hundreds or
 * thousands of metres, where float32 has millimetre precision.
 *
 * The origin is only re-based when the camera drifts past `rebaseThreshold`,
 * because every rebase means walking the scene graph. At cruise speed
 * (~250 m/s) a 50 km threshold rebases about every 3 minutes.
 */

import type { Vec3 } from './math/geo';

export interface FrameListener {
  /** Called after the origin moved. `delta` is `oldOrigin - newOrigin`. */
  onOriginChanged(newOrigin: Readonly<Vec3>, delta: Readonly<Vec3>): void;
}

export class FloatingOrigin {
  /** Current origin in ECEF metres, double precision. */
  private readonly origin: Vec3 = [0, 0, 0];
  private readonly listeners = new Set<FrameListener>();
  private readonly scratch: Vec3 = [0, 0, 0];

  constructor(private readonly rebaseThreshold = 50_000) {}

  get current(): Readonly<Vec3> {
    return this.origin;
  }

  addListener(l: FrameListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Squared distance from the origin to an ECEF point. */
  distanceSqFrom(ecef: Readonly<Vec3>): number {
    const dx = ecef[0] - this.origin[0];
    const dy = ecef[1] - this.origin[1];
    const dz = ecef[2] - this.origin[2];
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * Convert an ECEF position to render space. Safe to call every frame; writes
   * into `out` and never allocates.
   */
  toRenderInto(ecef: Readonly<Vec3>, out: Vec3): Vec3 {
    out[0] = ecef[0] - this.origin[0];
    out[1] = ecef[1] - this.origin[1];
    out[2] = ecef[2] - this.origin[2];
    return out;
  }

  toRender(ecef: Readonly<Vec3>): Vec3 {
    return this.toRenderInto(ecef, [0, 0, 0]);
  }

  /** Convert a render-space position back to ECEF. */
  toEcefInto(render: Readonly<Vec3>, out: Vec3): Vec3 {
    out[0] = render[0] + this.origin[0];
    out[1] = render[1] + this.origin[1];
    out[2] = render[2] + this.origin[2];
    return out;
  }

  /**
   * Move the origin to `ecef` if the camera has drifted far enough. Returns
   * true when a rebase happened, in which case every listener has already been
   * notified and any cached render-space position is stale.
   */
  maybeRebase(cameraEcef: Readonly<Vec3>): boolean {
    if (this.distanceSqFrom(cameraEcef) < this.rebaseThreshold * this.rebaseThreshold) {
      return false;
    }
    this.rebase(cameraEcef);
    return true;
  }

  /** Force the origin to a new ECEF point. */
  rebase(ecef: Readonly<Vec3>): void {
    const delta = this.scratch;
    delta[0] = this.origin[0] - ecef[0];
    delta[1] = this.origin[1] - ecef[1];
    delta[2] = this.origin[2] - ecef[2];

    this.origin[0] = ecef[0];
    this.origin[1] = ecef[1];
    this.origin[2] = ecef[2];

    for (const l of this.listeners) l.onOriginChanged(this.origin, delta);
  }
}
