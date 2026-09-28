/**
 * Points.
 *
 * Bigger aircraft are worth more (an A380 is a feat, a Cessna is not), a kill
 * soon after the last one multiplies, and the impact — seeing it all the way
 * down — pays a bonus of its own. The best score is kept in this browser.
 */

export interface KillAward {
  points: number;
  streak: number;
  label: string;
}

/** Seconds within which the next kill extends the streak. */
const STREAK_WINDOW_S = 12;
const BEST_KEY = 'planesview.sandbox.best';

export function killPoints(lengthM: number, streak: number): number {
  const base = 100 + Math.round(Math.max(0, lengthM) * 6);
  return Math.round(base * (1 + 0.5 * Math.max(0, streak - 1)));
}

export class Score {
  points = 0;
  kills = 0;
  streak = 0;
  crashes = 0;
  best = 0;
  private lastKillAt = -Infinity;

  constructor(private readonly storage: Storage | null = safeStorage()) {
    try {
      this.best = Number(this.storage?.getItem(BEST_KEY) ?? 0) || 0;
    } catch {
      this.best = 0;
    }
  }

  kill(lengthM: number, now: number): KillAward {
    this.streak = now - this.lastKillAt <= STREAK_WINDOW_S ? this.streak + 1 : 1;
    this.lastKillAt = now;
    this.kills++;
    const points = killPoints(lengthM, this.streak);
    this.add(points);
    const label = this.streak >= 5 ? 'Rampage' : this.streak === 4 ? 'Quad kill' : this.streak === 3 ? 'Triple kill' : this.streak === 2 ? 'Double kill' : 'Splash one';
    return { points, streak: this.streak, label };
  }

  /** Seen all the way to the ground. */
  impact(lengthM: number): number {
    const points = 50 + Math.round(lengthM * 2);
    this.add(points);
    return points;
  }

  crash(): void {
    this.crashes++;
    this.streak = 0;
    this.lastKillAt = -Infinity;
  }

  private add(points: number): void {
    this.points += points;
    if (this.points > this.best) {
      this.best = this.points;
      try {
        this.storage?.setItem(BEST_KEY, String(this.best));
      } catch {
        // Not remembered; still shown.
      }
    }
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
