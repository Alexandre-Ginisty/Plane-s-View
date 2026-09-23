/**
 * 2D selection map (MapLibre GL).
 *
 * Deliberately a *different* renderer from the globe rather than a zoomed-out
 * camera mode. Picking an aircraft out of a thousand is a flat-map task —
 * north up, no perspective, everything the same size — and a globe is a bad
 * instrument for it. The 3D view begins once a target is chosen.
 *
 * No text layers are used anywhere. MapLibre needs a glyph server for labels,
 * every free one has usage limits, and this project does not take a
 * dependency it cannot guarantee. Labels are DOM markers instead, which are
 * also crisper.
 */

import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type MapLayerMouseEvent,
  type MapMouseEvent,
} from 'maplibre-gl';
// MapLibre ships its own stylesheet; without it the controls and the
// attribution box are unstyled and overlap the map.
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection, LineString, Point } from 'geojson';

import { DEFAULT_IMAGERY, type ImagerySource } from '@/tiles/sources';
import {
  AIRCRAFT_ICON,
  AIRCRAFT_LAYERS,
  AIRCRAFT_SOURCE,
  CLICK_TOLERANCE_PX,
  EMPTY_COLLECTION,
  ROUTE_SOURCE,
  TRAIL_SOURCE,
  createAircraftIcon,
} from './style';
import { METRES_TO_NM, haversineMetres } from '@/core/math/geo';
import type { SampledAircraft } from '@/state/traffic';
import type { FlightRoute } from '@/data/types';

export interface MapEvents {
  onSelect(hex: string | null): void;
  onHover(hex: string | null): void;
  onMoveEnd(center: { lat: number; lon: number }, radiusNm: number): void;
  onError?(message: string): void;
}

export class SelectionMap {
  private map: MapLibreMap | null = null;
  private selectedHex: string | null = null;
  private imagery: ImagerySource = DEFAULT_IMAGERY;
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
          [ROUTE_SOURCE]: { type: 'geojson', data: EMPTY_COLLECTION },
          [TRAIL_SOURCE]: { type: 'geojson', data: EMPTY_COLLECTION },
          [AIRCRAFT_SOURCE]: { type: 'geojson', data: EMPTY_COLLECTION },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#04070d' } },
          { id: 'basemap', type: 'raster', source: 'basemap' },
          ...AIRCRAFT_LAYERS,
        ],
      },
      attributionControl: { compact: true },
      // Pitch and rotation belong to the 3D view; here they only get in the way.
      pitchWithRotate: false,
      dragRotate: false,
      touchZoomRotate: true,
      renderWorldCopies: true,
    });

    this.map = map;
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

    this.attachInteractions(map);
    this.emitMove();
  }

  /** Wired once the style is live and the layers exist. */
  private attachInteractions(map: MapLibreMap): void {
    map.on('moveend', () => this.emitMove());
    map.on('click', (e: MapMouseEvent) => this.handleClick(e));

    map.on('mousemove', 'aircraft-layer', (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = 'pointer';
      const hex = e.features?.[0]?.properties?.['hex'];
      this.events.onHover(typeof hex === 'string' ? hex : null);
    });
    map.on('mouseleave', 'aircraft-layer', () => {
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

  /** Viewport centre and the radius that covers it, for the traffic query. */
  private emitMove(): void {
    const map = this.map;
    if (!map) return;

    const center = map.getCenter();
    const bounds = map.getBounds();
    const ne = bounds.getNorthEast();

    const radiusM = haversineMetres(center.lat, center.lng, ne.lat, ne.lng);
    // Providers cap at 250 nm; a small floor keeps a deeply zoomed-in map from
    // asking for a circle so small it returns nothing.
    const radiusNm = Math.min(250, Math.max(10, radiusM * METRES_TO_NM));

    this.events.onMoveEnd({ lat: center.lat, lon: center.lng }, radiusNm);
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

  /** Draw origin -> aircraft -> destination for the selected flight. */
  updateRoute(route: FlightRoute | null, current: { lat: number; lon: number } | null): void {
    const source = this.geojsonSource(ROUTE_SOURCE);
    if (!source) return;

    const coords: [number, number][] = [];
    if (route?.origin?.lat != null && route.origin.lon != null) {
      coords.push([route.origin.lon, route.origin.lat]);
    }
    if (current) coords.push([current.lon, current.lat]);
    if (route?.destination?.lat != null && route.destination.lon != null) {
      coords.push([route.destination.lon, route.destination.lat]);
    }

    const data: FeatureCollection<LineString> = {
      type: 'FeatureCollection',
      features:
        coords.length < 2
          ? []
          : [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }],
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
    this.map?.remove();
    this.map = null;
  }
}
