/**
 * Links to a view: an aircraft, the seat in it, or a place on the map.
 *
 * In the fragment rather than the query string, for three reasons. Changing it
 * never reloads the page, so the address bar can follow the app as it moves.
 * It is never sent to the server, so a link names no aircraft in anyone's
 * access log. And the static host serves one cacheable page for every link.
 *
 *   #ac=3c6444              that aircraft, on the map
 *   #ac=3c6444&cam=wing     that aircraft, from the wing
 *   #map=8/48.857/2.352     the map, at zoom 8 over Paris (the OSM spelling)
 *
 * Everything read from a link is checked against what the app can actually
 * do: an aircraft address of the wrong shape, a camera that does not exist or
 * a map off the planet is simply no link, and the app opens as usual.
 */

import { CAMERA_MODES, type CameraMode } from '@/render/pov';

export type DeepLink =
  | { kind: 'aircraft'; hex: string; cam: CameraMode | null }
  | { kind: 'map'; lat: number; lon: number; zoom: number };

/** ICAO 24-bit address, with readsb's `~` for the non-ICAO ones. */
const HEX = /^~?[0-9a-f]{6}$/;

const isCamera = (id: string): id is CameraMode => CAMERA_MODES.some((m) => m.id === id);

export function parseDeepLink(hash: string): DeepLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));

  const hex = params.get('ac')?.toLowerCase();
  if (hex !== undefined) {
    if (!HEX.test(hex)) return null;
    const cam = params.get('cam');
    return { kind: 'aircraft', hex, cam: cam !== null && isCamera(cam) ? cam : null };
  }

  const map = params.get('map');
  if (map !== null) {
    const parts = map.split('/');
    if (parts.length !== 3) return null;
    const [zoom, lat, lon] = parts.map(Number) as [number, number, number];
    if (![zoom, lat, lon].every(Number.isFinite)) return null;
    if (zoom < 1 || zoom > 20 || Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
    return { kind: 'map', lat, lon, zoom };
  }

  return null;
}

export function formatDeepLink(link: DeepLink): string {
  if (link.kind === 'aircraft') {
    return link.cam ? `#ac=${link.hex}&cam=${link.cam}` : `#ac=${link.hex}`;
  }
  // Three decimals is about 100 m: plenty for a map, and short to paste.
  const zoom = Math.round(link.zoom * 10) / 10;
  return `#map=${zoom}/${link.lat.toFixed(3)}/${link.lon.toFixed(3)}`;
}

/**
 * Keep the address bar on the current view, without adding to the history:
 * Back should leave the site, not step through every pan of the map.
 */
export function writeDeepLink(link: DeepLink | null): void {
  const hash = link ? formatDeepLink(link) : '';
  if (location.hash === hash) return;
  try {
    history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
  } catch {
    // Some embedded browsers refuse; the link is simply not kept up to date.
  }
}

/**
 * The address to hand someone. The language choice is left out: the person
 * receiving it should read the site in theirs.
 */
export function shareableUrl(link: DeepLink | null): string {
  const params = new URLSearchParams(location.search);
  params.delete('lang');
  const search = params.toString();
  return `${location.origin}${location.pathname}${search ? `?${search}` : ''}${link ? formatDeepLink(link) : ''}`;
}
