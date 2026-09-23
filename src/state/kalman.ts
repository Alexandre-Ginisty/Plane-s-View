/**
 * Constant-velocity Kalman filter, one axis.
 *
 * ## Why one axis instead of one 4-state filter
 *
 * The obvious formulation tracks `[east, north, vEast, vNorth]` with a 4x4
 * covariance. But for a constant-velocity model the process noise is
 * independent per axis and the measurements are independent per axis, so `Q`,
 * `R` and `P` are all block-diagonal — and a block-diagonal Kalman filter
 * factorises **exactly** into independent per-axis filters. Two 2-state
 * filters are not an approximation of the 4-state one; they are the same
 * filter, with 4 covariance terms to propagate instead of 16, no matrix
 * inversion, and no allocation.
 *
 * ## Why filter at all
 *
 * ADS-B positions arrive about once a second, quantised, occasionally late and
 * occasionally wrong. Rendering them directly gives a visible 1 Hz stutter.
 * Naive linear interpolation between the last two fixes is smooth but always a
 * second behind, which is very obvious when you are sitting in the cockpit.
 *
 * The filter gives a *current* best estimate plus a velocity, so the render
 * loop can extrapolate to the exact frame time. Because velocity is measured
 * directly (`gs` and `track` are a velocity vector), the filter is
 * well-conditioned and converges within a couple of updates.
 *
 * State: `[position, velocity]`. Covariance `P` is symmetric, stored as
 * `p00, p01, p11`.
 */

export class CvKalman1D {
  /** Position estimate, metres. */
  x = 0;
  /** Velocity estimate, metres/second. */
  v = 0;

  private p00 = 1e6;
  private p01 = 0;
  private p11 = 1e4;

  private initialised = false;

  /**
   * Process noise: spectral density of unmodelled acceleration, m²/s³.
   * An airliner in cruise holds velocity very well; the default corresponds to
   * roughly 0.7 m/s² of manoeuvring, which covers normal turns without letting
   * the estimate lag through them.
   */
  constructor(private readonly accelNoise = 0.5) {}

  get ready(): boolean {
    return this.initialised;
  }

  /** Current position variance, m². Useful for fading uncertain aircraft. */
  get variance(): number {
    return this.p00;
  }

  reset(position: number, velocity: number, positionVar = 100, velocityVar = 25): void {
    this.x = position;
    this.v = velocity;
    this.p00 = positionVar;
    this.p01 = 0;
    this.p11 = velocityVar;
    this.initialised = true;
  }

  /**
   * Advance the estimate by `dt` seconds, growing the covariance.
   *
   * Discrete white-noise-acceleration model:
   *   `Q = q * [[dt^3/3, dt^2/2], [dt^2/2, dt]]`
   */
  predict(dt: number): void {
    if (!this.initialised || dt <= 0) return;

    this.x += this.v * dt;

    const { p11 } = this;
    const p01 = this.p01;

    // P = F P Fᵀ + Q
    this.p00 += dt * (2 * p01 + dt * p11);
    this.p01 = p01 + dt * p11;

    const q = this.accelNoise;
    const dt2 = dt * dt;
    this.p00 += (q * dt2 * dt) / 3;
    this.p01 += (q * dt2) / 2;
    this.p11 += q * dt;
  }

  /**
   * Extrapolate without mutating state — what the render loop calls to sample
   * the aircraft at an arbitrary frame time between measurements.
   */
  peek(dt: number): number {
    return this.x + this.v * dt;
  }

  /** Scalar measurement update on position. `r` is the measurement variance. */
  updatePosition(z: number, r: number): void {
    if (!this.initialised) {
      this.reset(z, this.v, r);
      return;
    }

    const s = this.p00 + r;
    if (s <= 0) return;

    const k0 = this.p00 / s;
    const k1 = this.p01 / s;
    const innovation = z - this.x;

    this.x += k0 * innovation;
    this.v += k1 * innovation;

    // Joseph-free form is fine here: H = [1 0], so P = (I - K H) P.
    const p00 = this.p00;
    const p01 = this.p01;
    this.p00 = p00 - k0 * p00;
    this.p01 = p01 - k0 * p01;
    this.p11 = this.p11 - k1 * p01;
  }

  /** Scalar measurement update on velocity. `H = [0 1]`. */
  updateVelocity(z: number, r: number): void {
    if (!this.initialised) return;

    const s = this.p11 + r;
    if (s <= 0) return;

    const k0 = this.p01 / s;
    const k1 = this.p11 / s;
    const innovation = z - this.v;

    this.x += k0 * innovation;
    this.v += k1 * innovation;

    const p01 = this.p01;
    const p11 = this.p11;
    this.p00 -= k0 * p01;
    this.p01 = p01 - k0 * p11;
    this.p11 = p11 - k1 * p11;
  }

  /**
   * Reject a measurement that is wildly inconsistent with the estimate.
   * Returns the normalised innovation squared; callers drop the update when it
   * exceeds a chi-squared gate. ADS-B feeds do occasionally emit a position on
   * the far side of the planet, and one such fix would otherwise fling the
   * aircraft across the globe and take several seconds to recover from.
   */
  gate(z: number, r: number): number {
    const s = this.p00 + r;
    if (s <= 0) return 0;
    const d = z - this.x;
    return (d * d) / s;
  }
}
