/**
 * Place names over the selection map, drawn as real text.
 *
 * MapLibre's own text layers need a glyph server, which this project will not
 * depend on (see `map.ts`). A pre-rendered label tile layer was the stand-in,
 * and it looked it: a bitmap of text, scaled, blurred between zoom levels,
 * heavy and pixelated. This draws the names itself on a 2D canvas laid over
 * the map, in the interface's own typeface, at device resolution — so they
 * are as crisp as the rest of the UI at every zoom, not just the integer ones.
 *
 * The data is Natural Earth (public domain), trimmed to what gets drawn and
 * served from this origin: `public/map/places.json`. Each place carries the
 * zoom at which Natural Earth considers it worth naming, which is what keeps
 * the map to countries and large cities until you zoom in.
 *
 * Past that, detail comes from GeoNames (CC BY 4.0): every place of 1,000+
 * people, cut into square cells (`public/map/towns/`) that are fetched only
 * once the map is zoomed into them. Each town carries its own first zoom by
 * population, so zooming in adds names progressively — towns, then smaller
 * towns, then villages — and zooming out takes them away in the same order.
 * Both files are built by `tools/map/build-places.mjs`.
 *
 * Smoothness is the point, so two things are deliberate. Placement is redone
 * every frame the map renders, which makes names track the imagery exactly
 * during a pan or pinch rather than catching up afterwards. And a name never
 * pops: it fades toward shown or hidden, so a label giving way to a neighbour
 * during a zoom reads as motion rather than flicker.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

/** [name, lon, lat, minZoom] */
type CountryRow = [string, number, number, number];
/** [name, lon, lat, minZoom, isCapital] */
type CityRow = [string, number, number, number, 0 | 1];
/** [name, lon, lat, minZoom] — zoom already in MapLibre terms. */
type TownRow = [string, number, number, number];

interface Place {
  readonly key: string;
  readonly text: string;
  readonly lon: number;
  readonly lat: number;
  /** MapLibre zoom from which it may appear. */
  readonly minZoom: number;
  /** MapLibre zoom past which it is no longer drawn. */
  readonly maxZoom: number;
  readonly kind: 'country' | 'major' | 'city' | 'town';
  width?: number;
}

/**
 * Natural Earth's zooms are for 256 px tiles; MapLibre's are for 512 px, one
 * level apart. The extra half level lets a place in slightly before its
 * nominal zoom, which the collision pass then thins where it is crowded.
 */
const NE_TO_MAPLIBRE = -1.5;
/**
 * Towns are not fetched below this zoom. The shallowest town zoom in the data
 * is 7; half a level earlier gives a cell time to arrive before its first
 * names are due.
 */
const TOWN_FETCH_ZOOM = 6.5;
/** Seconds for a full fade in or out. */
const FADE_S = 0.25;
/** Padding around each name, CSS px, so neighbours do not touch. */
const GAP = 6;

const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** A pin's name, as `theme.css` sets it — for measuring the room it takes. */
const PIN_FONT = `500 12px ${FONT_STACK}`;
const STYLE = {
  country: {
    font: `500 11px ${FONT_STACK}`,
    spacing: '1.5px',
    fill: 'rgba(235,240,245,0.62)',
  },
  major: {
    font: `500 13px ${FONT_STACK}`,
    spacing: '0px',
    fill: 'rgba(245,248,250,0.95)',
  },
  city: {
    font: `400 12px ${FONT_STACK}`,
    spacing: '0px',
    fill: 'rgba(235,240,245,0.85)',
  },
  town: {
    font: `400 11px ${FONT_STACK}`,
    spacing: '0px',
    fill: 'rgba(230,236,242,0.75)',
  },
} as const;

export class PlaceLabels {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private places: Place[] = [];
  /** Degrees per town cell; 0 until places.json says. */
  private townCell = 0;
  /** Town cells by key: loaded, in flight, or known to be empty. */
  private readonly towns = new Map<string, Place[] | 'loading' | null>();
  private mergedFrom: Place[][] = [];
  private obstacles: { lat: number; lon: number; name: string; width?: number }[] = [];
  private merged: Place[] = [];
  private readonly opacity = new Map<string, number>();
  private visible = true;
  private lastFrame = 0;
  private readonly onRender = (): void => this.draw();
  private readonly onResize = (): void => this.resize();

  constructor(private readonly map: MapLibreMap) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;

    // Over the map but inert: every click and drag still reaches MapLibre.
    Object.assign(this.canvas.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
    });
    map.getContainer().appendChild(this.canvas);

    this.resize();
    map.on('render', this.onRender);
    map.on('resize', this.onResize);
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch('/map/places.json');
      if (!res.ok) return;
      const data = (await res.json()) as {
        townCell: number;
        countries: CountryRow[];
        cities: CityRow[];
      };
      this.townCell = data.townCell;
      // Order is priority: the collision pass keeps whichever it meets first.
      this.places = [
        ...data.countries.map(([text, lon, lat, z]): Place => ({
          key: `c:${text}`,
          text: text.toUpperCase(),
          lon,
          lat,
          minZoom: z + NE_TO_MAPLIBRE,
          // Country names make way for cities once the view is regional.
          maxZoom: 6.5,
          kind: 'country',
        })),
        ...data.cities.map(([text, lon, lat, z, capital]): Place => ({
          key: `p:${text}:${lon}`,
          text,
          lon,
          lat,
          minZoom: z + NE_TO_MAPLIBRE,
          maxZoom: Infinity,
          kind: capital || z <= 3 ? 'major' : 'city',
        })),
      ];
      this.map.triggerRepaint();
    } catch {
      // No names is a working map; nothing to report.
    }
  }

  private async loadTownCell(key: string): Promise<void> {
    this.towns.set(key, 'loading');
    try {
      const res = await fetch(`/map/towns/${key}.json`);
      // Open ocean has no file. Remember that, so it is asked once.
      if (!res.ok) {
        this.towns.set(key, null);
        return;
      }
      const rows = (await res.json()) as TownRow[];
      this.towns.set(
        key,
        rows.map(([text, lon, lat, z]) => ({
          key: `t:${text}:${lon}`,
          text,
          lon,
          lat,
          minZoom: z,
          maxZoom: Infinity,
          kind: 'town' as const,
        })),
      );
      this.map.triggerRepaint();
    } catch {
      // Offline or refused: let a later frame try again.
      this.towns.delete(key);
    }
  }

  /**
   * Town cells overlapping the view, fetching any not yet asked for when
   * `fetch` is set.
   *
   * Only called at town zooms, where the view is a handful of cells wide, so
   * this is a few iterations a frame, never the whole world.
   */
  private visibleTowns(west: number, south: number, east: number, north: number, fetch: boolean): Place[][] {
    const size = this.townCell;
    const cols = Math.round(360 / size);
    const out: Place[][] = [];
    const y0 = Math.max(0, Math.floor((south + 90) / size));
    const y1 = Math.min(Math.round(180 / size) - 1, Math.floor((north + 90) / size));
    const x0 = Math.floor((west + 180) / size);
    const x1 = Math.floor((east + 180) / size);
    for (let x = x0; x <= x1; x++) {
      // World copies put the view past ±180; wrap back onto a real cell.
      const cx = ((x % cols) + cols) % cols;
      for (let cy = y0; cy <= y1; cy++) {
        const key = `${cx}_${cy}`;
        const cell = this.towns.get(key);
        if (cell === undefined) {
          if (fetch) void this.loadTownCell(key);
        } else if (Array.isArray(cell)) out.push(cell);
      }
    }
    return out;
  }

  /**
   * The visible cells as one list in town-zoom order.
   *
   * Each cell is sorted by population on its own, so walking cells one after
   * another would let a village at the edge of one beat a large town just
   * across the line in the next. Merged and re-sorted only when the set of
   * cells changes — a pan within them costs nothing.
   */
  private mergedTowns(cells: Place[][]): Place[] {
    if (cells.length === this.mergedFrom.length && cells.every((c, i) => c === this.mergedFrom[i])) {
      return this.merged;
    }
    this.mergedFrom = cells;
    // Stable sort: within a zoom tier, each cell's population order survives.
    this.merged = cells.flat().sort((a, b) => a.minZoom - b.minZoom);
    return this.merged;
  }

  /**
   * Name of the nearest named place within `maxKm`, or null.
   *
   * Searches the cities and whichever town cells are already loaded — at the
   * zoom someone drops a pin at, the cells under the view almost always are.
   * Towns win over a city only when clearly nearer — a third of the
   * distance — so a pin in a suburb well out of town is named after the
   * suburb, and one anywhere in the city after the city rather than
   * whichever district happens to be closest.
   */
  nearestName(lat: number, lon: number, maxKm = 12): string | null {
    const cosLat = Math.cos((lat * Math.PI) / 180);
    let best: string | null = null;
    let bestKm = maxKm;
    const consider = (p: Place, bias: number): void => {
      if (p.kind === 'country') return;
      const dx = (p.lon - lon) * cosLat * 111.32;
      const dy = (p.lat - lat) * 110.57;
      const km = Math.hypot(dx, dy) * bias;
      if (km < bestKm) {
        bestKm = km;
        best = p.text;
      }
    };
    for (const p of this.places) consider(p, 1);
    for (const cell of this.towns.values()) {
      if (Array.isArray(cell)) for (const p of cell) consider(p, 3);
    }
    return best;
  }

    /** Pins on the map, which place names must keep clear of. */
  setObstacles(pins: readonly { lat: number; lon: number; name: string }[]): void {
    this.obstacles = pins.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name }));
    this.map.triggerRepaint();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map.triggerRepaint();
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  private draw(): void {
    const { map, ctx, canvas } = this;
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const step = dt / FADE_S;

    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const zoom = map.getZoom();
    const bounds = map.getBounds();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();

    const placed: [number, number, number, number][] = [];
    // The user's pins own their spot: a place name never sits under one.
    ctx.font = PIN_FONT;
    ctx.letterSpacing = '0px';
    for (const o of this.obstacles) {
      const pt = map.project([o.lon, o.lat]);
      o.width ??= ctx.measureText(o.name).width;
      placed.push([pt.x - 10, pt.y - 14, pt.x + o.width + 44, pt.y + 14]);
    }
    const shown = new Set<string>();
    let fading = false;

    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    // A level below the fetch zoom, cells already loaded are still walked so
    // their names fade out on the way down instead of vanishing.
    const towns =
      this.townCell > 0 && zoom >= TOWN_FETCH_ZOOM - 1
        ? this.mergedTowns(
            this.visibleTowns(west, south, east, north, this.visible && zoom >= TOWN_FETCH_ZOOM),
          )
        : [];

    // Priority order: countries and cities first, then towns, so a village
    // never takes the spot of the city it sits beside.
    for (const p of this.places.concat(towns)) {
      const was = this.opacity.get(p.key) ?? 0;
      const eligible = this.visible && zoom >= p.minZoom && zoom < p.maxZoom;
      // Cheap rejects before any projection: most of the world is off screen.
      if (!eligible && was === 0) continue;
      if (p.lat < south || p.lat > north) {
        if (was > 0) this.opacity.delete(p.key);
        continue;
      }
      // With world copies on, the view can straddle the antimeridian.
      let lon = p.lon;
      if (lon < west) lon += 360;
      else if (lon > east) lon -= 360;
      if (lon < west || lon > east) {
        if (was > 0) this.opacity.delete(p.key);
        continue;
      }

      const style = STYLE[p.kind];
      ctx.font = style.font;
      ctx.letterSpacing = style.spacing;
      p.width ??= ctx.measureText(p.text).width;

      const pt = map.project([lon, p.lat]);
      const dot = p.kind !== 'country';
      const x = dot ? pt.x + 6 : pt.x - p.width / 2;
      const y = pt.y;
      const box: [number, number, number, number] = [
        (dot ? pt.x - 3 : x) - GAP,
        y - 8 - GAP,
        x + p.width + GAP,
        y + 8 + GAP,
      ];

      let fits = eligible && box[2] > 0 && box[0] < w && box[3] > 0 && box[1] < h;
      if (fits) {
        for (const b of placed) {
          if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) {
            fits = false;
            break;
          }
        }
      }
      if (fits) placed.push(box);

      const target = fits ? 1 : 0;
      const a = target > was ? Math.min(1, was + step) : Math.max(0, was - step);
      if (a !== target) fading = true;
      if (a === 0) {
        this.opacity.delete(p.key);
        continue;
      }
      this.opacity.set(p.key, a);
      shown.add(p.key);

      ctx.globalAlpha = a;
      // A thin dark outline rather than a blurred shadow: it keeps the text
      // legible over bright desert or cloud, and it is far cheaper to draw.
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 2.5;
      ctx.strokeText(p.text, x, y);
      ctx.fillStyle = style.fill;
      ctx.fillText(p.text, x, y);
      if (dot) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, p.kind === 'major' ? 2.2 : p.kind === 'town' ? 1.3 : 1.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Names that left the view mid-fade are dropped rather than left pending.
    for (const key of this.opacity.keys()) if (!shown.has(key)) this.opacity.delete(key);

    // Keep frames coming until every fade has landed; MapLibre only renders
    // when something on the map changes, and a fade is not something it sees.
    if (fading) map.triggerRepaint();
    else this.lastFrame = 0;
  }

  dispose(): void {
    this.map.off('render', this.onRender);
    this.map.off('resize', this.onResize);
    this.canvas.remove();
  }
}
