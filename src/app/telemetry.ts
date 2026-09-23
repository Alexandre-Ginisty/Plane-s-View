/**
 * The UI snapshot.
 *
 * Everything the reactive store learns about the running system, assembled in
 * one place so the store's shape and the producers of it cannot drift. Written
 * at 10 Hz, not 60: a HUD digit changing sixty times a second is unreadable,
 * and every write costs a Svelte pass over everything derived from it.
 */

import { ecefToGeodetic, METRES_TO_FEET, type Vec3 } from '@/core/math/geo';
import type { Engine } from '@/render/engine';
import type { GlobeStats } from '@/render/globe';
import { networkMonitor } from '@/net/quality';
import { tileDiskCache } from '@/tiles/cache';
import { app } from '@/state/appStore.svelte';

export interface TelemetryInput {
  engine: Engine;
  globeStats: Readonly<GlobeStats>;
  aircraftTracked: number;
  aircraftDrawn: number;
  /** True ECEF position of the camera — floating origin already added back. */
  cameraEcef: Vec3;
}

export function publishTelemetry(input: TelemetryInput): void {
  const { engine, globeStats } = input;

  app.stats = {
    fps: Math.round(engine.fps),
    renderMs: Number(engine.renderMs.toFixed(1)),
    pixelRatio: Number(engine.currentPixelRatio.toFixed(2)),
    aircraftTracked: input.aircraftTracked,
    aircraftDrawn: input.aircraftDrawn,
    tilesResident: globeStats.residentTiles,
    tilesRendered: globeStats.renderedTiles,
    tilesLoading: globeStats.loadingTiles,
    triangles: globeStats.triangles,
    requestsQueued: globeStats.queuedRequests,
    requestsInFlight: globeStats.inFlightRequests,
    deepestZoom: globeStats.deepestZoom,
    diskCacheMb: Number((tileDiskCache.diskBytes / 1024 / 1024).toFixed(1)),
    // Where the eye actually is, so the claim "the view sits at the
    // aircraft's altitude" is checkable rather than asserted. Read it
    // against the altitude on the flight card: they should agree to within
    // the geoid-to-ellipsoid separation, a few tens of feet.
    //
    // Null outside the 3D views, where the camera belongs to the 2D map and
    // its position is not a point on the globe at all — reported literally it
    // read as minus twenty million feet.
    eyeAltFt:
      app.view === 'pov'
        ? Math.round(
            ecefToGeodetic(input.cameraEcef[0], input.cameraEcef[1], input.cameraEcef[2]).height *
              METRES_TO_FEET,
          )
        : null,
  };

  // Refreshed every publish rather than only on a grade change, so the
  // diagnostics panel shows live latency and throughput instead of whatever
  // they happened to be at the last transition.
  app.network = networkMonitor.readout();
  app.networkProfile = networkMonitor.profile;
}
