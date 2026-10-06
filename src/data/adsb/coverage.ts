/**
 * Viewport coverage: which circles to ask the feed for, and in what order.
 *
 * Every free feed answers a *point and radius* query capped at 250 nm. The map,
 * zoomed out over a continent, shows thousands of miles — so one circle at the
 * centre left everything outside it empty. That is why Africa, the Sahel or
 * central Asia looked deserted while every other tracker showed traffic there:
 * the aircraft were in the feed, they were just never asked for.
 *
 * The view is tiled instead. Circles of the largest allowed radius are laid on
 * a square grid whose spacing is `r·√2` — the side of the square inscribed in
 * each circle — so neighbouring circles overlap exactly enough to leave no
 * gaps. Cells are ordered nearest-first from the centre, capped, and served
 * round-robin: each request takes the next one, and the tracker's dead
 * reckoning carries each aircraft between visits.
 *
 * ## Shared by every visitor
 *
 * The relay caches each reply at the CDN for a second or two, keyed by URL.
 * A circle centred on the exact middle of one visitor's screen is a URL no
 * other visitor will ever ask for, so that cache never hit and every visitor
 * cost the donated feed its own request. Every circle is therefore laid on a
 * grid fixed to the world, not to the view, and its radius taken from a short
 * ladder: two people looking at Paris ask for the same URL, and the feed
 * answers it once for both.
 */

import { clamp, haversineMetres, wrapLongitude } from '@/core/math/geo';
import type { TrafficQuery } from '@/data/types';

export interface ViewBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface ViewWindow {
  lat: number;
  lon: number;
  /** Radius that covers the view from its centre, nm. */
  radiusNm: number;
  /** The visible rectangle. Absent means "just the circle". */
  bounds?: ViewBounds;
}

/** Latitude beyond which cells are not laid: nothing flies there to find. */
const POLAR_LIMIT_DEG = 84;

/** Into [-180, 180], leaving values already there exactly as they were. */
const wrap = (lon: number) => (lon >= -180 && lon <= 180 ? lon : wrapLongitude(lon));

/** Fixed to the decimals the providers send, so equal cells spell equal URLs. */
const fix = (deg: number) => Number(deg.toFixed(5));

/**
 * Radii a single circle is rounded up to, nm. Each step is at most half again
 * the one below, so rounding up never asks for much more than was needed.
 */
const RADIUS_LADDER = [10, 15, 20, 30, 40, 60, 80, 120, 160, 200, 250] as const;

/** Grid spacing as a fraction of the radius: the centre moves at most ~12 % of it. */
const SNAP_DIVISIONS = 6;

/** Longitude step of a grid row at `lat` whose latitude step is `dLat`. */
const rowStep = (lat: number, dLat: number) =>
  dLat / Math.max(0.05, Math.cos((Math.min(POLAR_LIMIT_DEG, Math.abs(lat)) * Math.PI) / 180));

/**
 * The shared circle that contains `query`: centre on the world grid of its
 * radius step, radius from the ladder, and never smaller than the original
 * circle plus the distance the centre moved — so snapping only ever adds
 * aircraft at the edge, never loses one.
 *
 * Left as it was when no step up to `capNm` can contain it: a circle already
 * at the cap is one the sweep tiles anyway.
 */
export function shareableQuery(query: TrafficQuery, capNm: number): TrafficQuery {
  const ladder = [...RADIUS_LADDER.filter((r) => r < capNm), capNm];
  for (const radius of ladder) {
    if (radius < query.radiusNm) continue;
    const dLat = radius / SNAP_DIVISIONS / 60;
    const lat = clamp(Math.round(query.lat / dLat) * dLat, -90, 90);
    const dLon = rowStep(lat, dLat);
    const lon = wrap(Math.round(query.lon / dLon) * dLon);
    const movedNm = haversineMetres(query.lat, query.lon, lat, lon) / 1852;
    if (query.radiusNm + movedNm <= radius) return { lat: fix(lat), lon: fix(lon), radiusNm: radius };
  }
  return query;
}

/**
 * The circles that cover `view`, nearest the centre first.
 *
 * A view that fits inside one circle gets exactly one, around the centre and
 * about the view's own radius — so a zoomed-in map costs what it always did.
 */
export function planCells(view: ViewWindow, cellRadiusNm: number, maxCells: number): TrafficQuery[] {
  const centre = shareableQuery(
    { lat: view.lat, lon: wrap(view.lon), radiusNm: Math.min(view.radiusNm, cellRadiusNm) },
    cellRadiusNm,
  );
  if (!view.bounds || view.radiusNm <= cellRadiusNm || maxCells <= 1) return [centre];

  const spacingNm = cellRadiusNm * Math.SQRT2;
  const dLat = spacingNm / 60;

  const south = clamp(view.bounds.south, -POLAR_LIMIT_DEG, POLAR_LIMIT_DEG);
  const north = clamp(view.bounds.north, -POLAR_LIMIT_DEG, POLAR_LIMIT_DEG);
  let west = view.bounds.west;
  let east = view.bounds.east;
  // With world copies on, MapLibre reports unwrapped longitudes; wider than
  // the world is just the world.
  if (east - west >= 360) {
    west = view.lon - 180;
    east = view.lon + 180;
  }

  // Rows and columns count from the equator and the prime meridian, not from
  // the view, so every visitor's sweep asks for the same circles.
  const cells: TrafficQuery[] = [];
  const kMin = Math.floor(south / dLat - 0.5) + 1;
  const kMax = Math.ceil(north / dLat + 0.5) - 1;

  for (let k = kMin; k <= kMax; k++) {
    const lat = k * dLat;
    // The row is only as wide as its poleward edge allows.
    const dLon = rowStep(Math.abs(lat) + dLat / 2, dLat);
    const jMin = Math.floor(west / dLon - 0.5) + 1;
    const jMax = Math.ceil(east / dLon + 0.5) - 1;
    for (let j = jMin; j <= jMax; j++) {
      cells.push({ lat: fix(lat), lon: fix(wrap(j * dLon)), radiusNm: cellRadiusNm });
    }
  }

  const distance = (q: TrafficQuery) => haversineMetres(view.lat, view.lon, q.lat, q.lon);
  // The grid is laid from the centre, so the first cell after sorting is the
  // centre itself and the middle of the screen fills first.
  cells.sort((a, b) => distance(a) - distance(b));
  return cells.slice(0, maxCells);
}

/**
 * A round-robin cursor over the cells for the current view.
 *
 * Restarting at the centre whenever the view changes is deliberate: a user who
 * has just panned is looking at the middle, and that is where the first
 * answer should land.
 */
export class Coverage {
  private cells: TrafficQuery[] = [];
  private cursor = 0;
  private key = '';

  constructor(
    private view: ViewWindow,
    private cellRadiusNm = 250,
    private maxCells = 1,
  ) {
    this.replan();
  }

  setView(view: ViewWindow): void {
    this.view = view;
    this.replan();
  }

  setLimits(cellRadiusNm: number, maxCells: number): void {
    if (cellRadiusNm === this.cellRadiusNm && maxCells === this.maxCells) return;
    this.cellRadiusNm = cellRadiusNm;
    this.maxCells = maxCells;
    this.replan();
  }

  get cellCount(): number {
    return this.cells.length;
  }

  get current(): ViewWindow {
    return this.view;
  }

  /** The next circle to fetch. Never null once a view is set. */
  next(): TrafficQuery | null {
    if (this.cells.length === 0) return null;
    const cell = this.cells[this.cursor % this.cells.length] ?? null;
    this.cursor = (this.cursor + 1) % this.cells.length;
    return cell;
  }

  private replan(): void {
    const cells = planCells(this.view, this.cellRadiusNm, this.maxCells);
    const key = cells.map((c) => `${c.lat.toFixed(3)},${c.lon.toFixed(3)},${c.radiusNm.toFixed(0)}`).join(';');
    if (key === this.key) return;
    this.key = key;
    this.cells = cells;
    this.cursor = 0;
  }
}
