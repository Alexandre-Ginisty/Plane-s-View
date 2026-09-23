/**
 * Application orchestrator.
 *
 * Owns every long-lived object and the single frame loop. Nothing else starts
 * a `requestAnimationFrame`: one loop means one place where ordering is
 * decided, and ordering matters — the camera must move before the quadtree
 * selects tiles for it, or every tile is chosen for where the camera *was*.
 *
 * Per frame, in order:
 *   1. sample the traffic store at the exact frame time
 *   2. move the camera (which may rebase the floating origin)
 *   3. update the quadtree against the new camera
 *   4. rebuild the instanced traffic buffer
 *   5. publish a throttled snapshot to the UI store
 */

import { Vector3 } from 'three';

import { FloatingOrigin } from '@/core/frame';
import { networkMonitor } from '@/net/quality';
import type { Engine } from '@/render/engine';
import type { Globe } from '@/render/globe';
import type { OwnAircraft } from '@/render/ownAircraft';
import type { PovController, CameraMode } from '@/render/pov';
import type { Traffic3D } from '@/render/traffic3d';
import {
  DEG2RAD,
  FEET_TO_METRES,
  KNOTS_TO_MPS,
  geodeticToEcef,
} from '@/core/math/geo';
import { TrafficClient } from '@/data/adsb/client';
import { registry } from '@/data/meta/registry';
import { DEFAULT_IMAGERY, imageryById, type ImagerySource } from '@/tiles/sources';
import { SelectionMap } from '@/map2d/map';
import { TrafficStore, type SampledAircraft } from '@/state/traffic';
import { app } from '@/state/appStore.svelte';
import { ConnectionSupervisor } from './connection';
import { FALLBACK_VIEW, initialView } from './geolocate';
import { PovSession } from './povSession';
import { clearSelection, loadSelection } from './selection';
import { createSurfaces } from './surfaces';
import { updateSunlight } from './sunlight';
import { publishTelemetry } from './telemetry';
import type { TrafficQuery } from '@/data/types';

/** UI store writes per second. 60 would re-render the HUD needlessly. */
const UI_REFRESH_HZ = 10;

export class Orchestrator {
  private readonly origin = new FloatingOrigin(50_000);
  private readonly traffic = new TrafficStore();
  private readonly client: TrafficClient;

  private engine: Engine | null = null;
  private globe: Globe | null = null;
  private traffic3d: Traffic3D | null = null;
  private ownAircraft: OwnAircraft | null = null;
  private pov: PovController | null = null;
  private map: SelectionMap | null = null;

  private query: TrafficQuery = { ...FALLBACK_VIEW, radiusNm: 120 };
  private uiAccumulator = 0;
  private prefetchAccumulator = 0;
  private followAccumulator = 0;
  private dossierToken = 0;

  private readonly sunVec = new Vector3();
  private readonly upVec = new Vector3();
  private readonly cameraEcefVec = new Vector3();

  private lastSamples: SampledAircraft[] = [];

  /** Held-fix state for the cockpit view, across feed gaps. */
  private readonly povSession = new PovSession();

  /** Watches the link and retunes the renderer to it. */
  private readonly connection = new ConnectionSupervisor((profile) =>
    this.globe?.applyProfile(profile),
  );

  constructor() {
    this.client = new TrafficClient({
      onSnapshot: (snapshot) => {
        this.traffic.ingest(snapshot);
        // Keep the followed aircraft alive even if it left the query circle.
        this.traffic.prune(
          Date.now(),
          app.selectedHex ? new Set([app.selectedHex]) : undefined,
        );
        app.aircraftCount = this.traffic.size;
        app.lastUpdateAt = snapshot.receivedAt;
        app.feedSource = snapshot.source;
      },
      onHints: (hints) => registry.ingestHints(hints),
      onHealth: (health) => {
        app.providers = health;
      },
      onAllFailed: (errors) => {
        // When the link itself is down, naming four providers and their
        // individual timeouts is noise dressed up as diagnostics — the user
        // already has an offline notice and none of those four is the problem.
        if (networkMonitor.profile.grade === 'offline') {
          app.notify('Live traffic is paused until the connection returns.', 'warn', 8000);
          return;
        }
        const detail = [...errors.entries()].map(([id, e]) => `${id}: ${e}`).join(' | ');
        app.notify(`No traffic feed reachable. ${detail}`, 'error', 10_000);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async start(mapContainer: HTMLElement, canvas: HTMLCanvasElement): Promise<void> {
    // Boot blocks on nothing that can be deferred.
    //
    // Previously this awaited geolocation (up to 4 s) and then the map's
    // 'load' event, which waits for the first complete render and so can
    // never fire if a single tile stalls. Both are now fire-and-forget: the
    // map opens immediately over a sensible default and re-centres if and
    // when the browser grants a position.
    this.query = { ...FALLBACK_VIEW, radiusNm: 120 };

    this.map = new SelectionMap(mapContainer, {
      onSelect: (hex) => void this.select(hex),
      onHover: (hex) => {
        app.hoveredHex = hex;
      },
      onMoveEnd: (center, radiusNm) => {
        this.query = { lat: center.lat, lon: center.lon, radiusNm };
      },
      onError: (message) => app.notify(`Map: ${message}`, 'warn'),
    });
    this.map.init(FALLBACK_VIEW, 8);

    void initialView().then((where) => {
      // Only move if the user is somewhere else; re-centring on the fallback
      // would yank a map they may already be panning.
      if (where === FALLBACK_VIEW) return;
      this.query = { ...where, radiusNm: this.query.radiusNm };
      this.map?.flyTo(where.lat, where.lon, 8);
    });

    const surfaces = createSurfaces(canvas, this.origin);
    this.engine = surfaces.engine;
    this.globe = surfaces.globe;
    this.traffic3d = surfaces.traffic3d;
    this.ownAircraft = surfaces.ownAircraft;
    this.pov = surfaces.pov;

    if (!this.engine.webgl2) {
      app.notify('WebGL2 unavailable — the 3D globe needs it.', 'error', 0);
    }
    this.connection.start();

    this.client.start(() => this.feedQuery(), 4000);
    this.engine.start((ctx) => this.frame(ctx.dt));

    if (import.meta.env.DEV) {
      // Debug handle. Dev-only: nothing in the production bundle reaches it.
      (window as unknown as Record<string, unknown>)['__planesview'] = this;
    }

    app.notify('Pick an aircraft on the map, then step inside it.', 'info', 7000);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  private frame(dt: number): void {
    const engine = this.engine;
    const globe = this.globe;
    const pov = this.pov;
    const traffic3d = this.traffic3d;
    if (!engine || !globe || !pov || !traffic3d) return;

    const now = Date.now();
    this.connection.tick(dt);

    const samples = this.traffic.sampleAll(now);
    this.lastSamples = samples;

    const selected = app.selectedHex
      ? samples.find((s) => s.hex === app.selectedHex) ?? null
      : null;

    let flying: SampledAircraft | null = null;

    if (app.view === 'pov') {
      // Coast on the last known fix rather than ejecting. The camera holds
      // position, the terrain keeps streaming, and `maybeFollow` keeps asking
      // for the aircraft by hex until it answers.
      const step = this.povSession.step(selected, dt);
      flying = step.flying;

      if (step.action === 'exit') {
        app.notify('Lost contact with that aircraft — returning to the map.', 'warn');
        this.exitPov();
        return;
      }
      if (!flying) return; // unreachable once 'exit' is handled; narrows the type

      if (step.warn) {
        app.notify('Signal lost — holding position while we re-acquire it.', 'warn', 4000);
      }

      pov.update(engine.camera, flying, dt, (lat, lon) => globe.sampleHeight(lat, lon));
      this.applySunlight(flying.lat, flying.lon);
      this.maybePrefetch(dt, flying);
      this.maybeFollow(dt, flying.hex);

      globe.update(engine.camera, dt, engine.viewportHeight);

      this.cameraEcefVec.copy(engine.camera.position);
      const radiansPerPixel =
        (2 * Math.tan((engine.camera.fov * DEG2RAD) / 2)) / engine.viewportHeight;

      traffic3d.update(samples, this.cameraEcefVec, radiansPerPixel, app.selectedHex);

      // The followed aircraft is drawn by its own renderer, at true scale and
      // with the silhouette of its actual type — but not from inside it.
      if (this.ownAircraft) {
        this.ownAircraft.update(
          flying,
          app.dossier?.meta?.icaoTypeCode ?? null,
          app.cameraMode !== 'cockpit',
        );
        this.ownAircraft.setSun(this.sunVec);
      }
    }

    this.publish(dt, flying ?? selected, samples.length);
  }

  /**
   * The traffic query, narrowed to what the link can carry.
   *
   * A 120 nm circle over western Europe is several thousand aircraft and a
   * megabyte of JSON per poll. On a weak link that request takes longer than
   * the poll interval, so every snapshot arrives already stale and the
   * aircraft visibly jump between two old positions instead of moving — which
   * is the "planes lagging" complaint, and it is a payload problem, not a
   * rendering one. A smaller circle returns sooner, so positions update more
   * often; fewer aircraft that are current beat more aircraft that are wrong.
   */
  private feedQuery(): TrafficQuery {
    return {
      ...this.query,
      radiusNm: Math.min(this.query.radiusNm, this.connection.feedRadiusCapNm),
    };
  }

  private applySunlight(lat: number, lon: number): void {
    const engine = this.engine;
    const globe = this.globe;
    if (!engine || !globe) return;
    updateSunlight(engine, globe, this.sunVec, this.upVec, lat, lon);
  }

  /** Warm the tile cache along the aircraft's projected path. */
  private maybePrefetch(dt: number, sample: SampledAircraft): void {
    this.prefetchAccumulator += dt;
    if (this.prefetchAccumulator < 2) return;
    this.prefetchAccumulator = 0;

    // How far ahead to speculate is the connection's call. On a weak link
    // every prefetched tile is one the ground directly under the aircraft did
    // not get, so the profile winds it down to nothing rather than competing
    // with the view the user is actually looking at.
    this.globe?.prefetchAlong(
      sample.lat,
      sample.lon,
      sample.trackDeg,
      sample.groundSpeedKt * KNOTS_TO_MPS,
      networkMonitor.profile.prefetchSeconds,
      12,
    );

    // Keep the viewport query centred on the aircraft so nearby traffic keeps
    // arriving once the map is no longer driving it.
    this.query = { lat: sample.lat, lon: sample.lon, radiusNm: 80 };
  }

  /**
   * Track the followed aircraft directly by hex.
   *
   * The area query is centred on it, but a fast aircraft can still outrun the
   * circle between polls, and losing the aircraft you are sitting in is the
   * one failure the user will not forgive.
   */
  private maybeFollow(dt: number, hex: string): void {
    this.followAccumulator += dt;
    // Poll harder while it is quiet: this is the only thing that can end a
    // signal-loss hold before the grace period runs out.
    if (this.followAccumulator < (this.povSession.silence > 0 ? 1.5 : 4)) return;
    this.followAccumulator = 0;

    void this.client
      .fetchAircraft(hex)
      .then((state) => {
        if (state) this.traffic.ingestOne(state);
      })
      .catch(() => undefined);
  }

  /** Push a throttled snapshot into the reactive store. */
  private publish(dt: number, selected: SampledAircraft | null, tracked: number): void {
    this.uiAccumulator += dt;
    if (this.uiAccumulator < 1 / UI_REFRESH_HZ) return;
    this.uiAccumulator = 0;

    const engine = this.engine;
    const globe = this.globe;
    if (!engine || !globe) return;

    app.selected = selected;
    publishTelemetry({
      engine,
      globeStats: globe.getStats(),
      cameraEcef: [
        engine.camera.position.x + this.origin.current[0],
        engine.camera.position.y + this.origin.current[1],
        engine.camera.position.z + this.origin.current[2],
      ],
      aircraftTracked: tracked,
      aircraftDrawn: this.traffic3d?.getStats().drawn ?? 0,
    });

    if (app.view === 'map') {
      this.map?.updateAircraft(this.lastSamples);
      if (selected) {
        const track = this.traffic.get(selected.hex);
        if (track) this.map?.updateTrail(track.trailPoints);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Selection and view transitions
  // -------------------------------------------------------------------------

  /**
   * Select an aircraft, or clear the selection.
   *
   * The dossier lookup is awaited but token-guarded: a user clicking through a
   * busy map faster than adsbdb answers would otherwise see a panel filled in
   * by whichever request happened to return last.
   */
  async select(hex: string | null): Promise<void> {
    app.selectedHex = hex;
    this.map?.setSelected(hex);

    if (!hex) {
      clearSelection(this.map);
      return;
    }

    const sample = this.traffic.sampleOne(hex);
    app.selected = sample;
    await loadSelection(hex, sample, ++this.dossierToken, () => this.dossierToken, this.map);
  }

  /** Step into the selected aircraft. */
  enterPov(): void {
    const hex = app.selectedHex;
    if (!hex) return;

    const sample = this.traffic.sampleOne(hex);
    if (!sample) {
      app.notify('That aircraft is no longer being received.', 'warn');
      return;
    }

    this.pov?.reset();

    // Place the floating origin on the aircraft before the first frame, so the
    // very first tile selection is already centred correctly and nothing has
    // to stream in after the transition.
    const ecef = geodeticToEcef(sample.lat, sample.lon, sample.altFt * FEET_TO_METRES);
    this.origin.rebase(ecef);
    this.applySunlight(sample.lat, sample.lon);

    // Warm the area before the camera arrives, so the first frame of the
    // cockpit view already has terrain under it.
    this.globe?.prefetchAlong(
      sample.lat,
      sample.lon,
      sample.trackDeg,
      sample.groundSpeedKt * KNOTS_TO_MPS,
      Math.min(60, networkMonitor.profile.prefetchSeconds),
      12,
    );

    this.povSession.enter(sample);

    app.view = 'pov';
    app.cameraMode = this.pov?.state.mode ?? 'cockpit';
    this.query = { lat: sample.lat, lon: sample.lon, radiusNm: 80 };
  }

  exitPov(): void {
    app.view = 'map';
    this.pov?.reset();
    this.povSession.reset();

    const sample = app.selectedHex ? this.traffic.sampleOne(app.selectedHex) : null;
    if (sample) this.map?.flyTo(sample.lat, sample.lon);
    this.map?.resize();
  }

  setCameraMode(mode: CameraMode): void {
    this.pov?.setMode(mode);
    app.cameraMode = mode;
  }

  setImagery(id: string): void {
    const source: ImagerySource = imageryById(id) ?? DEFAULT_IMAGERY;
    this.globe?.setImagery(source);
    this.map?.setImagery(source);
    app.imageryId = source.id;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleDrag(dx: number, dy: number): void {
    this.pov?.applyDrag(dx, dy);
  }

  handleZoom(delta: number): void {
    this.pov?.applyZoom(delta);
  }

  recentreView(): void {
    this.pov?.recentre();
  }

  resizeMap(): void {
    this.map?.resize();
  }

  dispose(): void {
    this.connection.dispose();
    this.client.stop();
    this.engine?.dispose();
    this.globe?.dispose();
    this.traffic3d?.dispose();
    this.ownAircraft?.dispose();
    this.map?.dispose();
  }
}
