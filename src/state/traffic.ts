/**
 * The fleet.
 *
 * A map of hex to `AircraftTrack`, plus the lifecycle rules around it:
 * ingesting a snapshot, sampling every track at one consistent instant, and
 * pruning the ones that have gone quiet.
 *
 * Sampling every track at the *same* `now` is what keeps the picture coherent.
 * Sampling each one as it is drawn would extrapolate them by slightly
 * different amounts, which is invisible for one aircraft and, across a
 * thousand, shows up as the formation subtly shearing.
 */

import { clamp } from '@/core/math/geo';
import type { AircraftState, TrafficSnapshot } from '@/data/types';
import { AircraftTrack, DROP_AFTER_SEC, type SampledAircraft } from './track';

export type { SampledAircraft } from './track';
export { AircraftTrack } from './track';

export class TrafficStore {
  private readonly tracks = new Map<string, AircraftTrack>();
  private lastSampleTime = 0;

  /** Epoch ms of the most recent snapshot folded in. */
  lastUpdate = 0;
  /** Aircraft in the last snapshot that were new to the store. */
  lastNewCount = 0;

  get size(): number {
    return this.tracks.size;
  }

  ingest(snapshot: TrafficSnapshot): void {
    let added = 0;
    for (const state of snapshot.aircraft) {
      const existing = this.tracks.get(state.hex);
      if (existing) {
        existing.update(state);
      } else {
        this.tracks.set(state.hex, new AircraftTrack(state));
        added++;
      }
    }
    this.lastNewCount = added;
    this.lastUpdate = snapshot.receivedAt;
  }

  /** Drop aircraft that have gone quiet. Returns the hexes removed. */
  prune(now = Date.now(), keep?: ReadonlySet<string>): string[] {
    const removed: string[] = [];
    for (const [hex, track] of this.tracks) {
      if (keep?.has(hex)) continue;
      if ((now - track.lastSeenMs) / 1000 > DROP_AFTER_SEC) {
        this.tracks.delete(hex);
        removed.push(hex);
      }
    }
    return removed;
  }

  get(hex: string): AircraftTrack | undefined {
    return this.tracks.get(hex);
  }

  has(hex: string): boolean {
    return this.tracks.has(hex);
  }

  /**
   * Fold in a single report — used when POV mode tracks one aircraft by hex
   * outside the viewport query.
   */
  ingestOne(state: AircraftState): void {
    const existing = this.tracks.get(state.hex);
    if (existing) existing.update(state);
    else this.tracks.set(state.hex, new AircraftTrack(state));
  }

  /** Evaluate every aircraft at `now`. Allocates one array per call. */
  sampleAll(now = Date.now()): SampledAircraft[] {
    const dt = this.lastSampleTime > 0 ? (now - this.lastSampleTime) / 1000 : 0;
    this.lastSampleTime = now;

    const out: SampledAircraft[] = [];
    for (const track of this.tracks.values()) {
      out.push(track.sampleAt(now, clamp(dt, 0, 0.25)));
    }
    return out;
  }

  sampleOne(hex: string, now = Date.now()): SampledAircraft | null {
    const track = this.tracks.get(hex);
    if (!track) return null;
    const dt = this.lastSampleTime > 0 ? (now - this.lastSampleTime) / 1000 : 0;
    return track.sampleAt(now, clamp(dt, 0, 0.25));
  }

  tracksIterator(): IterableIterator<AircraftTrack> {
    return this.tracks.values();
  }

  clear(): void {
    this.tracks.clear();
  }
}
