/**
 * The wind aloft and at the surface: measured, not invented.
 *
 * Two sources, each good where the other is not. The weather forecast gives the wind ten
 * metres above the ground at the spawn — the wind a landing is flown in. The
 * traffic gives the wind aloft: ADS-B version 2 aircraft broadcast the wind
 * they measure (`wd`, `ws`) at their own altitude, so the airliners around the
 * player are, in effect, a free radiosonde. Reports are averaged in 1000 m
 * layers and interpolated between layers; below the lowest layer the surface
 * wind grows with height by the usual one-seventh power law until it meets it.
 *
 * Directions are meteorological (where the wind comes FROM); the output is
 * the velocity of the air (where it goes TO), east and north, m/s.
 */

const KT_TO_MS = 0.514_444;
const LAYER_M = 1000;
/** Height the surface wind is reported at, metres above the ground. */
const SURFACE_REF_M = 10;
/** The power law stops growing here, metres above the ground. */
const BOUNDARY_LAYER_M = 400;
/** Reports further than this from the player are not the wind it flies in. */
const REPORT_RADIUS_M = 200_000;

interface Layer {
  altM: number;
  east: number;
  north: number;
}

/** What `observe` needs from an aircraft on the feed. */
export interface WindReporter {
  lat: number;
  lon: number;
  altFt: number;
  latest: { windDirectionDeg: number | null; windSpeedKt: number | null };
}

function toVector(fromDeg: number, speedMs: number): { east: number; north: number } {
  const r = (fromDeg * Math.PI) / 180;
  return { east: -speedMs * Math.sin(r), north: -speedMs * Math.cos(r) };
}

export class WindField {
  private surface: { east: number; north: number } | null = null;
  private layers: Layer[] = [];

  /** The 10 m wind from the weather service; null when unknown. */
  setSurface(fromDeg: number | null, speedMs: number | null): void {
    this.surface =
      fromDeg !== null && speedMs !== null && Number.isFinite(fromDeg) && Number.isFinite(speedMs)
        ? toVector(fromDeg, Math.max(0, speedMs))
        : null;
  }

  /** Rebuild the layers aloft from the traffic around (lat, lon). */
  observe(reporters: Iterable<WindReporter>, lat: number, lon: number): void {
    const sums = new Map<number, { east: number; north: number; n: number }>();
    const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
    for (const a of reporters) {
      const { windDirectionDeg: dir, windSpeedKt: kt } = a.latest;
      if (dir === null || kt === null || !Number.isFinite(dir) || !Number.isFinite(kt)) continue;
      const altM = a.altFt * 0.3048;
      if (!(altM > 300)) continue;
      const dx = (a.lon - lon) * kx;
      const dy = (a.lat - lat) * 111_320;
      if (dx * dx + dy * dy > REPORT_RADIUS_M * REPORT_RADIUS_M) continue;
      const band = Math.floor(altM / LAYER_M);
      const v = toVector(dir, kt * KT_TO_MS);
      const s = sums.get(band) ?? { east: 0, north: 0, n: 0 };
      s.east += v.east;
      s.north += v.north;
      s.n++;
      sums.set(band, s);
    }
    this.layers = [...sums.entries()]
      .map(([band, s]) => ({ altM: (band + 0.5) * LAYER_M, east: s.east / s.n, north: s.north / s.n }))
      .sort((a, b) => a.altM - b.altM);
  }

  get layerCount(): number {
    return this.layers.length;
  }

  /** Air velocity at an altitude (MSL) and height above the ground, m/s. */
  at(altM: number, aglM: number, out: { east: number; north: number }): { east: number; north: number } {
    const layers = this.layers;
    const agl = Number.isFinite(aglM) ? Math.max(0, aglM) : BOUNDARY_LAYER_M;
    // The surface wind, grown through the boundary layer; still near the ground.
    const s = this.surface;
    const grow = Math.pow(Math.max(0.5, Math.min(agl, BOUNDARY_LAYER_M)) / SURFACE_REF_M, 1 / 7);
    const se = s ? s.east * grow : 0;
    const sn = s ? s.north * grow : 0;
    if (layers.length === 0) {
      out.east = se;
      out.north = sn;
      return out;
    }
    const first = layers[0]!;
    if (altM <= first.altM) {
      // From the top of the boundary layer to the lowest report, a straight blend.
      const top = altM - agl + BOUNDARY_LAYER_M;
      const t = first.altM > top ? Math.max(0, Math.min(1, (altM - top) / (first.altM - top))) : 1;
      const k = s ? t : 1;
      out.east = se + (first.east - se) * k;
      out.north = sn + (first.north - sn) * k;
      return out;
    }
    for (let i = 1; i < layers.length; i++) {
      const b = layers[i]!;
      if (altM <= b.altM) {
        const a = layers[i - 1]!;
        const t = (altM - a.altM) / (b.altM - a.altM);
        out.east = a.east + (b.east - a.east) * t;
        out.north = a.north + (b.north - a.north) * t;
        return out;
      }
    }
    const last = layers[layers.length - 1]!;
    out.east = last.east;
    out.north = last.north;
    return out;
  }
}
