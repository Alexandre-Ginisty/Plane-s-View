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
import { applyTheme, saveTheme, type Theme } from '@/ui/theme';
import type { AircraftDossier, CurrentWeather } from '@/data/types';
import type { SampledAircraft } from '@/state/traffic';
import type { FlightPhase, PhaseEvent } from '@/state/phase';

/**
 * Read a boolean preference, falling back when storage is unavailable.
 * `localStorage` throws in a locked-down browser and is empty in a private
 * window; either way the default is the right answer.
 */
function storedFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function storeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Not remembered next time; still applied now.
  }
}

type ViewMode = 'map' | 'pov';

/** A place the user marked on the map, to find again from the air. */
export interface Pin {
  id: string;
  lat: number;
  lon: number;
  name: string;
}

const PINS_KEY = 'planesview.pins';

function loadPins(): Pin[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    // Stored by an older build or edited by hand: keep only what is usable.
    return raw.filter(
      (p): p is Pin =>
        typeof p === 'object' &&
        p !== null &&
        typeof p.id === 'string' &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        typeof p.name === 'string',
    );
  } catch {
    return [];
  }
}

interface RuntimeStats {
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
  /** A shared link to an aircraft is still being looked up; the address bar keeps it meanwhile. */
  linkPending = $state(false);
  /** Looking around by moving the phone. See `@/app/gyro`. */
  gyro = $state(false);
  /** When the clip being recorded started (`performance.now()`), or null. */
  recordingSince = $state<number | null>(null);
  /** Where the map last came to rest, for the link in the address bar. */
  mapView = $state<{ lat: number; lon: number; zoom: number } | null>(null);
  hoveredHex = $state<string | null>(null);
  dossier = $state<AircraftDossier | null>(null);
  dossierLoading = $state(false);

  /** Live state of the selected aircraft, refreshed every frame in POV. */
  selected = $state<SampledAircraft | null>(null);

  /** Phase of flight of the aircraft being flown. See `@/state/phase`. */
  phase = $state<FlightPhase | null>(null);
  /** Seconds to touchdown at the present sink rate, when descending low. */
  touchdownInS = $state<number | null>(null);
  /**
   * The latest liftoff or touchdown. `id` changes on every event, so the HUD
   * can key its caption on it and replay the animation for the next one.
   */
  phaseEvent = $state<{ kind: PhaseEvent; id: number; at: number } | null>(null);

  /**
   * Let the camera pick the view for takeoffs and landings. On by default and
   * remembered: it only ever acts during those two moments, and hands the
   * view straight back afterwards.
   */
  autoCamera = $state(storedFlag('planesview.autocam', true));
  setAutoCamera(on: boolean): void {
    this.autoCamera = on;
    storeFlag('planesview.autocam', on);
  }

  /**
   * Nothing but the picture: every overlay hidden, and the browser fullscreen
   * where it allows it. See `App.svelte`.
   */
  cinema = $state(false);

  /**
   * The user's pins. Kept in `localStorage`, so a home town marked once is
   * still marked next week — and only in this browser, which is the right
   * scope for "where I live".
   */
  pins = $state<Pin[]>(loadPins());
  /** While on, a click on the map drops a pin instead of selecting. */
  pinMode = $state(false);

  addPin(lat: number, lon: number, name: string): void {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.pins = [...this.pins, { id, lat, lon, name }];
    this.savePins();
  }

  removePin(id: string): void {
    this.pins = this.pins.filter((p) => p.id !== id);
    this.savePins();
  }

  renamePin(id: string, name: string): void {
    this.pins = this.pins.map((p) => (p.id === id ? { ...p, name } : p));
    this.savePins();
  }

  clearPins(): void {
    this.pins = [];
    this.savePins();
  }

  private savePins(): void {
    try {
      localStorage.setItem(PINS_KEY, JSON.stringify(this.pins));
    } catch {
      // Kept for this session only.
    }
  }

  /**
   * Dark or daylight. Seeded before the first paint — see `ui/theme.ts`.
   *
   * Held here rather than read from the DOM so every component sees the same
   * value reactively; the attribute on `<html>` is what the CSS reads, and
   * `setTheme` is the one place that keeps the two in step.
   */
  theme = $state<Theme>('dark');

  /**
   * @param followSystem Clear the stored override instead of writing one, so
   * the page goes back to tracking the operating system.
   */
  setTheme(theme: Theme, followSystem = false): void {
    this.theme = theme;
    applyTheme(theme);
    if (!followSystem) saveTheme(theme);
  }

  cameraMode = $state<CameraMode>('cockpit');
  /** The 3D cockpit (with its own instruments) is on screen. */
  cockpit3d = $state(false);
  imageryId = $state('esri');
  /** National imagery layers in the picture now (ids from `tiles/regional.ts`): their credit is shown. */
  regionalImagery = $state<readonly string[]>([]);
  /** Borders and place names drawn over the selection map. */
  showLabels = $state(true);

  /**
   * Engine sound, off until asked for.
   *
   * Off is not timidity about the autoplay policy — a browser tab that starts
   * making engine noises on load is a bad guest whatever the policy allows,
   * and the people most likely to have several tabs open are the ones most
   * likely to want this one.
   */
  sound = $state(false);

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
  /**
   * Flight details panel in the cockpit view. Closed to begin with on a
   * phone, where open it covers most of the view the user came for.
   */
  showFlightCard = $state(typeof matchMedia !== 'function' || !matchMedia('(max-width: 720px)').matches);
  /**
   * True while the user is dragging the 3D view round. The details card steps
   * aside for the drag and comes back when the button is released, so looking
   * around is never looking at a panel.
   */
  lookingAround = $state(false);

  /** Drag direction preference: false = the camera goes where the hand goes. */
  invertY = $state(storedFlag('planesview.invertY', false));
  setInvertY(on: boolean): void {
    this.invertY = on;
    storeFlag('planesview.invertY', on);
  }

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
