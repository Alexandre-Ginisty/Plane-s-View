/**
 * Map symbology.
 *
 * The source names, the aircraft icon, and the layer specifications that turn
 * a GeoJSON feature collection into what the user sees. Separated from the map
 * class because it is declarative data with one interesting piece of code in
 * it, and because a layer specification is the kind of thing that gets read
 * and edited far more often than the machinery around it.
 *
 * Colours come from `@/ui/palette`, which the 3D traffic layer also reads, so
 * an aircraft cannot be one colour on the map and another in the cockpit.
 */

import type { LayerSpecification } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

import { PALETTE } from '@/ui/palette';

export const AIRCRAFT_SOURCE = 'aircraft';
export const TRAIL_SOURCE = 'trail';
export const ROUTE_SOURCE = 'route';
export const AIRCRAFT_ICON = 'aircraft-icon';

/** Half-width of the click hit box, pixels. Icons are ~14 px across. */
export const CLICK_TOLERANCE_PX = 10;

/**
 * Aircraft silhouette as an SDF image.
 *
 * MapLibre can only tint an icon per-feature when the image is flagged `sdf`,
 * which is what lets one image serve every altitude colour. A rasterised alpha
 * mask is not a true signed distance field, so edges are slightly softer than
 * a generated SDF would be — at the sizes used here that is invisible, and it
 * avoids shipping a build step for one 64px sprite.
 */
export function createAircraftIcon(size = 64): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');

  const s = size / 64;
  ctx.translate(size / 2, size / 2);
  ctx.fillStyle = '#fff';

  ctx.beginPath();
  // Nose at the top; MapLibre's icon-rotate is clockwise from north, which
  // matches the ADS-B track convention exactly.
  ctx.moveTo(0, -26 * s);
  ctx.lineTo(4 * s, -10 * s);
  ctx.lineTo(26 * s, 6 * s);
  ctx.lineTo(26 * s, 11 * s);
  ctx.lineTo(4 * s, 5 * s);
  ctx.lineTo(3 * s, 19 * s);
  ctx.lineTo(11 * s, 25 * s);
  ctx.lineTo(11 * s, 28 * s);
  ctx.lineTo(0, 24 * s);
  ctx.lineTo(-11 * s, 28 * s);
  ctx.lineTo(-11 * s, 25 * s);
  ctx.lineTo(-3 * s, 19 * s);
  ctx.lineTo(-4 * s, 5 * s);
  ctx.lineTo(-26 * s, 11 * s);
  ctx.lineTo(-26 * s, 6 * s);
  ctx.lineTo(-4 * s, -10 * s);
  ctx.closePath();
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}

export const EMPTY_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * The three aircraft-related layers, bottom to top.
 *
 * Declared as data so they can go straight into the initial style. Order
 * matters: the great-circle route sits under the flown trail, which sits under
 * the aircraft symbols.
 */
export const AIRCRAFT_LAYERS: LayerSpecification[] = [
  {
    id: 'route-layer',
    type: 'line',
    source: ROUTE_SOURCE,
    paint: {
      'line-color': PALETTE.holo,
      'line-width': 1.5,
      'line-opacity': 0.55,
      'line-dasharray': [2, 2],
    },
  },
  {
    id: 'trail-layer',
    type: 'line',
    source: TRAIL_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': PALETTE.amber,
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.2, 12, 2.6],
      'line-opacity': 0.8,
    },
  },
  {
    id: 'aircraft-layer',
    type: 'symbol',
    source: AIRCRAFT_SOURCE,
    layout: {
      'icon-image': AIRCRAFT_ICON,
      'icon-rotate': ['get', 'track'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.22, 7, 0.32, 12, 0.45],
    },
    paint: {
      /*
       * Altitude ramp: ground through cruise.
       *
       * The one place the app's palette deliberately does not apply. This is
       * the scale every flight-tracking site uses — red on the ground through
       * violet at cruise — so it reads immediately to anyone who has seen one,
       * and a prettier scheme that nobody recognises would be a net loss.
       * Selection and staleness *do* use the palette, because those two mean
       * the same thing here as they do in the cockpit view.
       */
      'icon-color': [
        'case',
        ['get', 'selected'], PALETTE.amber,
        ['get', 'stale'], PALETTE.slate,
        [
          'interpolate',
          ['linear'],
          ['get', 'alt'],
          0, '#f06543',
          5000, '#f0a043',
          15000, '#e8dc43',
          25000, '#7fd67f',
          35000, '#4fb8e8',
          45000, '#9a7fe8',
        ],
      ],
      'icon-opacity': ['case', ['get', 'stale'], 0.45, 1],
      'icon-halo-color': '#000',
      'icon-halo-width': 0.6,
    },
  },
];
