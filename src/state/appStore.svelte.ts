/**
 * Application state.
 *
 * Svelte 5 runes, kept in one place so the render loop has exactly one
 * boundary to push across. The 60 fps data — camera attitude, tile counts —
 * is written here once per frame; anything a component derives from it is
 * recomputed by Svelte only when it actually changes.
 *
 * Deliberately *not* here: the aircraft list. Pushing a thousand objects into
 * reactive state every second would make Svelte diff them every second for no
 * benefit, since the map and the globe consume them directly. Only the
 * selected aircraft is reactive.
 */

import type { ProviderHealth } from '@/data/adsb/client';
import type { NetworkReadout, StreamingProfile } from '@/net/quality';
import type { CameraMode } from '@/render/pov';
import type { AircraftDossier, CurrentWeather } from '@/data/types';
import type { SampledAircraft } from '@/state/traffic';

export type ViewMode = 'map' | 'pov';

export interface RuntimeStats {
  fps: number;
  /** Our own update + draw cost, ms. The number that shows real headroom. */
  renderMs: number;
  pixelRatio: number;
  aircraftTracked: number;
  aircraftDrawn: number;
  tilesResident: number;
  tilesRendered: number;
  tilesLoading: number;
  triangles: number;
  requestsQueued: number;
  requestsInFlight: number;
  deepestZoom: number;
  /** Camera height above the ellipsoid, feet. Null outside the 3D views. */
  eyeAltFt: number | null;
  diskCacheMb: number;
}

class AppStore {
  /** Which surface is showing. */
  view = $state<ViewMode>('map');
  /** True during the map -> cockpit transition, so both can be on screen. */
  transitioning = $state(false);

  selectedHex = $state<string | null>(null);
  hoveredHex = $state<string | null>(null);
  dossier = $state<AircraftDossier | null>(null);
  dossierLoading = $state(false);

  /** Live state of the selected aircraft, refreshed every frame in POV. */
  selected = $state<SampledAircraft | null>(null);

  cameraMode = $state<CameraMode>('cockpit');
  imageryId = $state('esri');

  providers = $state<ProviderHealth[]>([]);
  aircraftCount = $state(0);
  lastUpdateAt = $state(0);
  feedSource = $state<string | null>(null);

  weather = $state<CurrentWeather | null>(null);

  /**
   * What the connection is doing, and what the renderer decided about it.
   *
   * Surfaced rather than kept internal on purpose: when the app quietly drops
   * to low detail because the link is weak, a user who is not told assumes the
   * app is broken. Saying so turns a bug report into an explanation.
   */
  network = $state<NetworkReadout | null>(null);
  networkProfile = $state<StreamingProfile | null>(null);

  stats = $state<RuntimeStats>({
    fps: 60,
    renderMs: 0,
    pixelRatio: 1,
    aircraftTracked: 0,
    aircraftDrawn: 0,
    tilesResident: 0,
    tilesRendered: 0,
    tilesLoading: 0,
    triangles: 0,
    requestsQueued: 0,
    requestsInFlight: 0,
    deepestZoom: 0,
    eyeAltFt: null,
    diskCacheMb: 0,
  });

  /** Non-fatal problems worth telling the user about, newest first. */
  notices = $state<{ id: number; text: string; level: 'info' | 'warn' | 'error' }[]>([]);

  /** True while "take me somewhere else" is searching the world. */
  shuffling = $state(false);

  showDiagnostics = $state(false);
  /** The key-and-controls panel. Opened once on a first visit; see `App`. */
  showLegend = $state(false);
  showLayers = $state(false);
  /** Flight details panel in the cockpit view. */
  showFlightCard = $state(true);

  private noticeId = 0;

  notify(text: string, level: 'info' | 'warn' | 'error' = 'info', ttlMs = 6000): void {
    const id = ++this.noticeId;
    this.notices = [{ id, text, level }, ...this.notices].slice(0, 4);
    if (ttlMs > 0) {
      setTimeout(() => {
        this.notices = this.notices.filter((n) => n.id !== id);
      }, ttlMs);
    }
  }

  dismiss(id: number): void {
    this.notices = this.notices.filter((n) => n.id !== id);
  }
}

export const app = new AppStore();
