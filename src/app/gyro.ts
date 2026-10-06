/**
 * Looking around by turning the phone.
 *
 * Read from the gyroscope's rotation rate rather than from the absolute
 * orientation: a rate integrated over time turns the view by exactly as much
 * as the hand turned the phone, with no compass to drift, no jump when the
 * phone passes vertical, and nothing to calibrate. A finger drag still works
 * alongside; the two simply add.
 *
 * The rate is in the device's own axes, and which of them is "turn" and which
 * is "tilt" depends on how the phone is held, so it is mapped through the
 * screen's orientation. With the screen facing you, +X to its right, +Y to
 * its top and +Z out towards you, a turn to the left is a positive rotation
 * about whichever device axis points up, and looking up is a positive one
 * about the axis pointing to the screen's right.
 */

/** Degrees per second below which the hand is taken to be still: sensor noise, not intent. */
const DEAD_BAND_DPS = 0.6;
const DEG = Math.PI / 180;

type Permissioned = { requestPermission?: () => Promise<'granted' | 'denied'> };

export const hasGyro = (): boolean =>
  typeof window !== 'undefined' &&
  'DeviceMotionEvent' in window &&
  matchMedia('(hover: none) and (pointer: coarse)').matches;

/** Yaw and pitch rates, degrees per second, from the device's rates and the screen's angle. */
export function lookRates(rate: { beta: number; gamma: number }, screenAngle: number): { yaw: number; pitch: number } {
  switch (((screenAngle % 360) + 360) % 360) {
    case 90:
      return { yaw: rate.beta, pitch: -rate.gamma };
    case 270:
      return { yaw: -rate.beta, pitch: rate.gamma };
    case 180:
      return { yaw: -rate.gamma, pitch: -rate.beta };
    default:
      return { yaw: rate.gamma, pitch: rate.beta };
  }
}

export class GyroLook {
  private last = 0;
  private readonly onMotion = (e: DeviceMotionEvent): void => this.motion(e);

  constructor(private readonly look: (dYaw: number, dPitch: number) => void) {}

  /**
   * Start, asking for permission where the browser wants it asked (iOS, and
   * only from a tap). Resolves false when refused or unavailable.
   */
  async enable(): Promise<boolean> {
    const ask = (DeviceMotionEvent as unknown as Permissioned).requestPermission;
    if (typeof ask === 'function') {
      try {
        if ((await ask.call(DeviceMotionEvent)) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    this.last = 0;
    addEventListener('devicemotion', this.onMotion);
    return true;
  }

  disable(): void {
    removeEventListener('devicemotion', this.onMotion);
  }

  private motion(e: DeviceMotionEvent): void {
    const r = e.rotationRate;
    const now = e.timeStamp;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!r || dt <= 0 || r.beta === null || r.gamma === null) return;
    const { yaw, pitch } = lookRates({ beta: r.beta, gamma: r.gamma }, screen.orientation?.angle ?? 0);
    const y = Math.abs(yaw) < DEAD_BAND_DPS ? 0 : yaw;
    const p = Math.abs(pitch) < DEAD_BAND_DPS ? 0 : pitch;
    if (y || p) this.look(y * DEG * dt, p * DEG * dt);
  }
}
