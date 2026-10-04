import { haversineMetres } from '@/core/math/geo';
import type { ViewWindow } from '@/data/adsb/coverage';

/**
 * Whether the area traffic is wanted for has changed enough to ask for it
 * again at once (see `TrafficClient.requestNow`), rather than at the next tick.
 *
 * A pan of a few miles is covered by the circle already in hand — the feeds
 * answer up to 250 nm — so it waits for the ordinary cadence. A move of a
 * quarter of the radius or more, or a zoom to a clearly different scale, is a
 * new place and a new set of aircraft.
 */
export function viewJumped(previous: ViewWindow, next: ViewWindow): boolean {
  const radiusNm = Math.max(previous.radiusNm, next.radiusNm, 20);
  const movedNm = haversineMetres(previous.lat, previous.lon, next.lat, next.lon) / 1852;
  if (movedNm > radiusNm * 0.25) return true;
  const ratio = next.radiusNm / Math.max(1, previous.radiusNm);
  return ratio > 1.5 || ratio < 1 / 1.5;
}
