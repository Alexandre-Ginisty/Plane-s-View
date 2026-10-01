/**
 * 2D selection map (MapLibre GL).
 *
 * Deliberately a *different* renderer from the globe rather than a zoomed-out
 * camera mode. Picking an aircraft out of a thousand is a flat-map task —
 * north up, no perspective, everything the same size — and a globe is a bad
 * instrument for it. The 3D view begins once a target is chosen.
 *
 * No MapLibre text layers are used anywhere. MapLibre needs a glyph server for
 * labels, every free one has usage limits, and this project does not take a
 * dependency it cannot guarantee. Place names are drawn by `PlaceLabels`
 * instead, and borders are an ordinary line layer; both read Natural Earth
 * data served from this origin.
 */

import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type MapLayerMouseEvent,
  type MapMouseEvent,
  setWorkerUrl,
} from 'maplibre-gl';
// MapLibre ships its own stylesheet; without it the controls and the
// attribution box are unstyled and overlap the map.
import 'maplibre-gl/dist/maplibre-gl.css';
/*
 * MapLibre's worker, bundled by Vite with the chunk it imports.
 *
 * Left to itself MapLibre looks for `maplibre-gl-worker.mjs` beside its own
 * module — which in a production build is `assets/`, where no such file is
 * ever emitted. The request fell through to the SPA's index page, the worker
 * died on HTML, and every GeoJSON layer stayed empty: in production the map
 * showed imagery and place names and not a single aircraft, while the dev
 * server, which serves `node_modules` as is, was fine.
 */
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(maplibreWorkerUrl);
import type { FeatureCollection, LineString, Point } from 'geojson';

import { DEFAULT_IMAGERY, type ImagerySource } from '@/tiles/sources';
import {
  AIRCRAFT_ICON,
  AIRCRAFT_LAYERS,
  AIRCRAFT_SOURCE,
  CLICK_TOLERANCE_PX,
  EMPTY_COLLECTION,
  TRAIL_SOURCE,
  createAircraftIcon,
} from './style';
import { PlaceLabels } from './labels';
import { MapPins } from './pins';
import type { Pin } from '@/state/appStore.svelte';
import { METRES_TO_NM, haversineMetres } from '@/core/math/geo';
import type { SampledAircraft } from '@/state/traffic';

export interface MapEvents {
  onSelect(hex: string | null): void;
  onHover(hex: string | null): void;
  onMoveEnd(
    center: { lat: number; lon: number },
    radiusNm: number,
    bounds: { south: number; west: number; north: number; east: number },
  ): void;
  onError?(message: string): void;
  /** A pin dropped here, with the nearest place's name when there is one. */
  onPlacePin(lat: number, lon: number, name: string): void;
  onRemovePin(id: string): void;
  onRenamePin(id: string, name: string): void;
}

export class SelectionMap {
  private map: MapLibreMap | null = null;
  private selectedHex: string | null = null;
  private imagery: ImagerySource = DEFAULT_IMAGERY;
  private labelsVisible = true;
  private labels: PlaceLabels | null = null;
  private pins: MapPins | null = null;
  private pinMode = false;
  /**
   * Fetch a source, or null while the style is still parsing.
   *
   * Callers simply skip that update. The map is refreshed ten times a second,
   * so the first successful call is at most a frame or two later than the
   * style becoming usable — and nothing has to know when that was.
   */
  private geojsonSource(id: string): GeoJSONSource | null {
    try {
      return (this.map?.getSource(id) as GeoJSONSource | undefined) ?? null;
    } catch {
      return null;
    }
  }

  constructor(
    private readonly container: HTMLElement,
    private readonly events: MapEvents,
  ) {}

  /** Dev-only handle so the live map can be inspected from the console. */
  get instance(): MapLibreMap | null {
    return this.map;
  }

  init(center: { lat: number; lon: number }, zoom = 7): void {
    const map = new MapLibreMap({
      container: this.container,
      center: [center.lon, center.lat],
      zoom,
      minZoom: 1,
      maxZoom: 17,
      // No glyphs or sprite: nothing here needs them, and declaring URLs we do
      // not control would make the map fail offline for no benefit.
      // Sources and layers are declared up front rather than added after a
      // readiness event.
      //
      // Three different "the style is ready now" signals were tried here —
      // `load`, `styledata`, and polling `isStyleLoaded()` — and each failed
      // in its own way, leaving the map permanently without its aircraft
      // layer. Declaring everything in the style removes the question: there
      // is no moment at which the layers do not exist, so there is nothing to
      // detect and nothing to miss.
      style: {
        version: 8,
        sources: {
          basemap: {
            type: 'raster',
            tiles: [this.imagery.template],
            tileSize: this.imagery.tileSize,
            maxzoom: this.imagery.maxZoom,
            attribution: this.imagery.attribution,
          },
          borders: { type: 'geojson', data: '/map/borders.json' },
          [TRAIL_SOURCE]: { type: 'geojson', data: EMPTY_COLLECTION },
          [AIRCRAFT_SOURCE]: { type: 'geojson', data: EMPTY_COLLECTION },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#04070d' } },
          {
            id: 'basemap',
            type: 'raster',
            source: 'basemap',
            paint: {
              // Toned down so the traffic, not the ground, is what the eye
              // lands on.
              'raster-saturation': -0.25,
              'raster-brightness-max': 0.85,
              /*
               * Longer than MapLibre's 300 ms default.
               *
               * A zoom step replaces every tile on screen at once, and at the
               * default the old level is gone before the new one has finished
               * decoding — so the picture blinks through a coarse ancestor on
               * the way. Half a second is long enough that the two levels
               * overlap for the whole swap and short enough not to smear a
               * continuous pinch-zoom.
               */
              'raster-fade-duration': 500,
            },
          },
          // Borders over the imagery, under the traffic. Hairline and faint:
          // orientation, not decoration.
          {
            id: 'borders',
            type: 'line',
            source: 'borders',
            layout: {
              visibility: this.labelsVisible ? 'visible' : 'none',
              'line-join': 'round',
            },
            paint: {
              'line-color': '#e8edf2',
              'line-opacity': 0.35,
              'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 8, 1.1],
            },
          },
          ...AIRCRAFT_LAYERS,
        ],
      },
      attributionControl: {
        compact: true,
        // GeoNames is CC BY: credit is a condition of use, not a courtesy.
        customAttribution: 'Places © Natural Earth, GeoNames (CC BY 4.0)',
      },
      /*
       * Keep what has already been downloaded.
       *
       * The default cache holds barely more than one screen, so zooming out
       * and back in re-fetches tiles that were on screen a second earlier —
       * which is most of what makes zooming feel abrupt rather than slow. This
       * is memory the browser was going to spend on the same bytes anyway.
       */
      maxTileCacheSize: 512,
      /** Symbol fades, matched to the raster cross-fade above. */
      fadeDuration: 500,
      // Pitch and rotation belong to the 3D view; here they only get in the way.
      pitchWithRotate: false,
      dragRotate: false,
      touchZoomRotate: true,
      renderWorldCopies: true,
    });

    this.map = map;

    /*
     * A finer wheel.
     *
     * MapLibre's default rate turns one notch of a mouse wheel into a large
     * jump, which reads as the map snapping between zoom levels rather than
     * moving through them. A trackpad sends a stream of small deltas and does
     * not need it; a wheel does, and the same setting serves both because it
     * scales the delta rather than quantising it.
     */
    map.scrollZoom.setWheelZoomRate(1 / 800);

    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new ScaleControl({ unit: 'nautical' }), 'bottom-left');

    // Surface style/tile problems instead of letting MapLibre swallow them.
    map.on('error', (e) => {
      this.events.onError?.(e.error?.message ?? 'Map error');
    });

    // The icon cannot be declared in a style, but MapLibre asks for it by name
    // the moment a layer needs it — which is exactly the right time to supply
    // it, and needs no readiness check either.
    map.on('styleimagemissing', (e: { id: string }) => {
      if (e.id !== AIRCRAFT_ICON || map.hasImage(AIRCRAFT_ICON)) return;
      map.addImage(AIRCRAFT_ICON, createAircraftIcon(), { sdf: true, pixelRatio: 2 });
    });

    this.labels = new PlaceLabels(map);
    this.labels.setVisible(this.labelsVisible);
    this.pins = new MapPins(map, {
      remove: (id) => this.events.onRemovePin(id),
      rename: (id, name) => this.events.onRenamePin(id, name),
    });

    this.attachInteractions(map);
    this.emitMove();
  }

  /** Wired once the style is live and the layers exist. */
  private attachInteractions(map: MapLibreMap): void {
    map.on('moveend', () => this.emitMove());
    map.on('click', (e: MapMouseEvent) => this.handleClick(e));
    // Right-click drops a pin whatever mode the map is in. Android turns a
    // long press into this event; iOS does not, hence the timer below.
    let lastPinAt = 0;
    map.on('contextmenu', (e: MapMouseEvent) => {
      e.preventDefault();
      if (performance.now() - lastPinAt < 800) return;
      lastPinAt = performance.now();
      this.placePin(e.lngLat.lat, e.lngLat.lng);
    });

    // A long press with one still finger is the touch screen's right-click.
    let press: ReturnType<typeof setTimeout> | undefined;
    let pressAt: { x: number; y: number } | null = null;
    const cancel = (): void => {
      clearTimeout(press);
      pressAt = null;
    };
    map.on('touchstart', (e) => {
      cancel();
      if (e.originalEvent.touches.length !== 1) return;
      pressAt = { x: e.point.x, y: e.point.y };
      const { lat, lng } = e.lngLat;
      press = setTimeout(() => {
        if (!pressAt || performance.now() - lastPinAt < 800) return;
        lastPinAt = performance.now();
        this.placePin(lat, lng);
        navigator.vibrate?.(12);
      }, 600);
    });
    map.on('touchmove', (e) => {
      if (pressAt && Math.hypot(e.point.x - pressAt.x, e.point.y - pressAt.y) > 8) cancel();
    });
    map.on('touchend', cancel);
    map.on('touchcancel', cancel);
    map.on('movestart', cancel);

    map.on('mousemove', 'aircraft-layer', (e: MapLayerMouseEvent) => {
      if (this.pinMode) return;
      map.getCanvas().style.cursor = 'pointer';
      const hex = e.features?.[0]?.properties?.['hex'];
      this.events.onHover(typeof hex === 'string' ? hex : null);
    });
    map.on('mouseleave', 'aircraft-layer', () => {
      if (this.pinMode) return;
      map.getCanvas().style.cursor = '';
      this.events.onHover(null);
    });
  }

  /**
   * Resolve a click to an aircraft, or to empty sky.
   *
   * One handler, not two. Registering a layer-scoped `click` *and* a general
   * `click` means both fire for a hit on an aircraft, and the general one —
   * which runs second — would clear the selection the first had just made.
   *
   * The query uses a box rather than a point because the icons are ~14 px
   * across: an exact-pixel hit test makes selecting a target feel broken even
   * when the aim is good.
   */
  private handleClick(e: MapMouseEvent): void {
    const map = this.map;
    if (!map) return;

    if (this.pinMode) {
      this.placePin(e.lngLat.lat, e.lngLat.lng);
      return;
    }

    const t = CLICK_TOLERANCE_PX;
    const box: [[number, number], [number, number]] = [
      [e.point.x - t, e.point.y - t],
      [e.point.x + t, e.point.y + t],
    ];

    const hits = map.queryRenderedFeatures(box, { layers: ['aircraft-layer'] });
    if (hits.length === 0) {
      if (this.selectedHex !== null) {
        this.selectedHex = null;
        this.events.onSelect(null);
      }
      return;
    }

    // Several aircraft can fall inside the box; take the one nearest the
    // actual click so a dense stack still resolves predictably.
    let bestHex: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const hit of hits) {
      const hex = hit.properties?.['hex'];
      if (typeof hex !== 'string') continue;
      if (hit.geometry.type !== 'Point') continue;

      const [lon, lat] = hit.geometry.coordinates as [number, number];
      const projected = map.project([lon, lat]);
      const distance = Math.hypot(projected.x - e.point.x, projected.y - e.point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestHex = hex;
      }
    }

    if (bestHex && bestHex !== this.selectedHex) {
      this.selectedHex = bestHex;
      this.events.onSelect(bestHex);
    }
  }

  private placePin(lat: number, lon: number): void {
    const name = this.labels?.nearestName(lat, lon) ?? formatCoordinates(lat, lon);
    this.events.onPlacePin(lat, lon, name);
  }

  /** While on, a click drops a pin instead of selecting an aircraft. */
  setPinMode(on: boolean): void {
    this.pinMode = on;
    const canvas = this.map?.getCanvas();
    if (canvas) canvas.style.cursor = on ? 'crosshair' : '';
  }

  setPins(pins: readonly Pin[]): void {
    this.pins?.sync(pins);
    this.labels?.setObstacles(pins);
  }

  /** Swap the basemap layer without rebuilding the map. */
  setImagery(source: ImagerySource): void {
    this.imagery = source;
    const map = this.map;
    if (!map) return;

    const src = map.getSource('basemap');
    if (src && 'setTiles' in src && typeof src.setTiles === 'function') {
      src.setTiles([source.template]);
    }
  }

  /** Show or hide borders and place names. */
  setLabels(visible: boolean): void {
    this.labelsVisible = visible;
    const map = this.map;
    if (!map) return;
    if (map.getLayer('borders')) map.setLayoutProperty('borders', 'visibility', visible ? 'visible' : 'none');
    this.labels?.setVisible(visible);
  }

  /** Viewport centre and the radius that covers it, for the traffic query. */
  private emitMove(): void {
    const map = this.map;
    if (!map) return;

    const center = map.getCenter();
    const bounds = map.getBounds();
    const ne = bounds.getNorthEast();

    const sw = bounds.getSouthWest();

    const radiusM = Math.max(
      haversineMetres(center.lat, center.lng, ne.lat, ne.lng),
      haversineMetres(center.lat, center.lng, sw.lat, sw.lng),
    );
    // Not capped at the providers' 250 nm: a wider view is tiled into several
    // circles by the feed (see `data/adsb/coverage`). The floor keeps a deeply
    // zoomed-in map from asking for a circle so small it returns nothing.
    const radiusNm = Math.max(10, radiusM * METRES_TO_NM);

    this.events.onMoveEnd({ lat: center.lat, lon: center.lng }, radiusNm, {
      south: sw.lat,
      west: sw.lng,
      north: ne.lat,
      east: ne.lng,
    });
  }

  setSelected(hex: string | null): void {
    this.selectedHex = hex;
  }

  updateAircraft(samples: readonly SampledAircraft[]): void {
    const source = this.geojsonSource(AIRCRAFT_SOURCE);
    if (!source) return;

    const features: FeatureCollection<Point>['features'] = [];
    for (const s of samples) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: {
          hex: s.hex,
          track: s.trackDeg,
          alt: s.altFt,
          stale: s.stale,
          selected: s.hex === this.selectedHex,
          callsign: s.latest.callsign ?? '',
        },
      });
    }

    source.setData({ type: 'FeatureCollection', features });
  }

  /** Draw the selected aircraft's recent track. */
  updateTrail(points: readonly { lat: number; lon: number }[]): void {
    const source = this.geojsonSource(TRAIL_SOURCE);
    if (!source) return;

    const data: FeatureCollection<LineString> = {
      type: 'FeatureCollection',
      features:
        points.length < 2
          ? []
          : [
              {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: points.map((p) => [p.lon, p.lat]),
                },
              },
            ],
    };

    source.setData(data);
  }

  flyTo(lat: number, lon: number, zoom?: number): void {
    this.map?.flyTo({ center: [lon, lat], zoom: zoom ?? this.map.getZoom(), duration: 900 });
  }

  fitBounds(bounds: LngLatBoundsLike): void {
    this.map?.fitBounds(bounds, { padding: 80, duration: 900 });
  }

  get center(): { lat: number; lon: number } {
    const c = this.map?.getCenter();
    return c ? { lat: c.lat, lon: c.lng } : { lat: 0, lon: 0 };
  }

  resize(): void {
    this.map?.resize();
  }

  dispose(): void {
    // Nulling the map is what disables every other method: they all guard
    // on it, so a separate `disposed` flag would say the same thing twice.
    this.labels?.dispose();
    this.labels = null;
    this.pins?.dispose();
    this.pins = null;
    this.map?.remove();
    this.map = null;
  }
}

/** A pin's name when no place is near enough to lend it one. */
function formatCoordinates(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}
