/**
 * Application orchestrator.
 *
 * Owns every long-lived object and the single frame loop. Nothing else starts
 * a `requestAnimationFrame`: one loop means one place where ordering is
 * decided, and ordering matters — the camera must move before the quadtree
 * selects tiles for it, or every tile is chosen for where the camera *was*.
 */

import { Vector3 } from 'three';

import { FloatingOrigin } from '@/core/frame';
import {
  networkMonitor,
} from '@/net/quality';
import { EngineAudio } from '@/audio/engineAudio';
import type { Engine } from '@/render/engine';
import type { Globe } from '@/render/globe';
import { GroundDetail } from '@/render/groundDetail';
import { NightLights } from '@/render/nightLights';
import { atmoData } from '@/render/sky/shader';
import type { OwnAircraft } from '@/render/ownAircraft';
import { isInterior, type PovController, type CameraGroup, type CameraMode } from '@/render/pov';
import { isFreighter } from '@/data/freighters';
import type { Traffic3D } from '@/render/traffic3d';
import type { Pins3D } from '@/render/pins3d';
import type { AirportModels } from '@/render/airports';
import type { ViewOverlay } from '@/render/overlay';
import type { Pin } from '@/state/appStore.svelte';
import {
  DEG2RAD,
  FEET_TO_METRES,
  KNOTS_TO_MPS,
  geodeticToEcef,
  haversineMetres,
} from '@/core/math/geo';
import { TrafficClient, type QuerySource } from '@/data/adsb/client';
import { t as tr } from '@/i18n/index.svelte';
import { viewJumped } from './viewJump';
import { Coverage, type ViewBounds, type ViewWindow } from '@/data/adsb/coverage';
import { registry } from '@/data/meta/registry';
import { DEFAULT_IMAGERY, imageryById, type ImagerySource } from '@/tiles/sources';
import { SelectionMap } from '@/map2d/map';
import { flightRegime } from '@/state/regime';
import {
  PhaseTracker,
  TouchdownClock,
  type FlightPhase,
  type PhaseInput,
} from '@/state/phase';
import { clearanceFor } from '@/render/ground';
import { RunwayMotion } from './runwayMotion';
import { TrafficStore, type SampledAircraft } from '@/state/traffic';
import type { TrailPoint } from '@/state/track';
import { fetchFlightTrace } from '@/data/adsb/trace';
import { app } from '@/state/appStore.svelte';
import { ConnectionSupervisor } from './connection';
import { FALLBACK_VIEW, initialView } from './geolocate';
import { PovSession } from './povSession';
import { findRandomAircraft, type ShuffleResult } from './shuffle';
import { acceptsForCatch, pickNearby, type CatchKind } from './catch';
import { pickOfType } from './typeSearch';
import { typeName } from '@/data/meta/typeNames';
import type { PlaceResult } from '@/data/places/search';
import { clearSelection, loadSelection } from './selection';
import { createSurfaces } from './surfaces';
import { updateSunlight } from './sunlight';
import { hazeForVisibility } from '@/render/sky/model';
import { publishTelemetry } from './telemetry';
import { Cockpit, emptyReadings } from '@/render/cockpit';
import { shapeFor } from '@/render/aircraft';
import { loadModelFor, operatorOf } from '@/render/aircraft/library';
import { fillContacts, readingsFromSample } from './cockpitReadings';
import { WindField } from '@/data/weather/wind';
import type { DeepLink } from './deepLink';
import { armCrashCheck, recordMemoryLoss } from '@/render/deviceBudget';
import { ClipRecorder, canRecord, captionPhoto, toJpeg } from './capture';
import { captureName, deliverFile, describeFlight } from './share';
import { GyroLook } from './gyro';
import { fetchCurrentWeather } from '@/data/weather/metno';

/** Terrain tiles still loading above which decoration (night map, ground detail) holds off. */
const GROUND_BUSY_TILES = 3;
/** The longest decoration is held back for, ms. */
const GROUND_BUSY_MAX_MS = 6000;

/** UI store writes per second. 60 would re-render the HUD needlessly. */
const UI_REFRESH_HZ = 10;
/**
 * Degrees added to the lens inside the cockpit: a person sees the panel at
 * the bottom of their vision and the sky above the canopy bow at once, and a
 * 60° lens cannot show both. Simulators widen it for the same reason.
 */
const COCKPIT_FOV_BOOST_DEG = 12;
/** Radians the cockpit view rests below the boresight, for the same reason. */
const COCKPIT_REST_PITCH = -0.12;

/**
 * The view the auto camera picks for each moment worth one.
 *
 * Cockpit for the ground roll and the final approach, because the runway
 * rushing at the windscreen is the whole event. The wing for the initial
 * climb, because the moment after liftoff is best seen from outside: the
 * ground falling away under the aircraft, and the gear coming up.
 */
const DIRECTED_VIEWS: Partial<Record<FlightPhase, CameraMode>> = {
  takeoff: 'cockpit',
  departure: 'wing',
  final: 'cockpit',
  rollout: 'cockpit',
};

/** How long an aircraft found ahead of time is still worth flying into, ms. */
const NEXT_SHUFFLE_FRESH_MS = 75_000;

/** Whole-chain failures in a row before the user is told the feed is down. */
const FEED_FAILURES_BEFORE_NOTICE = 3;

/**
 * Say what a feed error means rather than what the browser called it.
 *
 * "Failed to fetch" (Chrome) and "Load failed" (Safari) are the same thing:
 * no response arrived at all. Naming that is more useful than the raw text.
 */
function describeFeedError(message: string): string {
  if (/failed to fetch|load failed|networkerror/i.test(message)) return tr('feed.noResponse');
  if (/exceeded \d+ ms|timed out/i.test(message)) return tr('feed.timedOut');
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  if (status === '429') return tr('feed.rateLimited');
  if (status) return `HTTP ${status}`;
  return message;
}

export class Orchestrator {
  private readonly origin = new FloatingOrigin(50_000);
  private readonly traffic = new TrafficStore();
  /** The wind the clouds drift in: the traffic's own reports, layer by layer. */
  private readonly wind = new WindField();
  private readonly client: TrafficClient;

  private engine: Engine | null = null;
  private globe: Globe | null = null;
  private readonly nightLights = new NightLights();
  private readonly groundDetail = new GroundDetail();
  /** When the terrain last started loading in earnest, or null while it is not. */
  private groundBusySince: number | null = null;
  private traffic3d: Traffic3D | null = null;
  private ownAircraft: OwnAircraft | null = null;
  private pins3d: Pins3D | null = null;
  private airports: AirportModels | null = null;
  private overlay: ViewOverlay | null = null;
  /** The labelled aircraft under the pointer in the 3D view, if any. */
  private hoverTraffic: string | null = null;
  private pov: PovController | null = null;

  /** Synthesised engine note. Silent until the user asks for it. */
  private readonly audio = new EngineAudio();
  private map: SelectionMap | null = null;

  /** The area traffic is wanted for: the map's view, or a followed aircraft. */
  private currentQuery: ViewWindow = { ...FALLBACK_VIEW, radiusNm: 120 };
  private get query(): ViewWindow {
    return this.currentQuery;
  }
  /**
   * Setting the area is also the moment to ask for it: a view that has moved
   * somewhere new (or zoomed to a different scale) gets its traffic at once
   * instead of at the next tick of a cadence tuned for a view that stays put.
   */
  private set query(next: ViewWindow) {
    const previous = this.currentQuery;
    this.currentQuery = next;
    if (!viewJumped(previous, next)) return;
    this.client?.requestNow();
  }
  /** Tiles `query` into feed-sized circles and hands them out in turn. */
  private readonly coverage = new Coverage(this.query);
  private uiAccumulator = 0;
  private prefetchAccumulator = 0;
  private followAccumulator = 0;
  private dossierToken = 0;

  private readonly sunVec = new Vector3();
  /** The 3D cockpit around the first-person camera, and what its instruments show. */
  private readonly cockpit = new Cockpit();
  private readonly readings = emptyReadings();
  private readonly cameraEcefVec = new Vector3();

  private lastSamples: SampledAircraft[] = [];

  /** The selected aircraft's flight so far, from before this page saw it. See `@/data/adsb/trace`. */
  private history: { hex: string; points: readonly TrailPoint[] } | null = null;
  private historyAbort: AbortController | null = null;

  /** Held-fix state for the cockpit view, across feed gaps. */
  private readonly povSession = new PovSession();

  /** Phase of the aircraft being flown, and which aircraft that is. */
  private readonly phaseTracker = new PhaseTracker();
  private phaseHex: string | null = null;
  private phaseEventId = 0;
  private readonly touchdownClock = new TouchdownClock();
  /** The runway's last minute, flown by the book when the feed goes quiet. See `./runwayMotion`. */
  private readonly runway = new RunwayMotion();
  /** The view the user chose, restored when the auto camera lets go. */
  private userCameraMode: CameraMode = 'cockpit';
  /** The view last chosen inside and outside, for switching between the two. */
  private readonly lastInGroup: Record<CameraGroup, CameraMode> = { interior: 'cockpit', exterior: 'chase' };
  /** True while the auto camera is holding the view. */
  private directing = false;
  /**
   * A phase in which the user took the camera back. The auto camera stays
   * out of it until the phase changes, rather than fighting them every frame.
   */
  private directorSuppressedFor: FlightPhase | null = null;
  /** Newest "take me somewhere else" search; older ones land nowhere. */
  private shuffleToken = 0;
  /**
   * The next "somewhere else", found ahead of time. The search walks several
   * regions of the world over a feed that is often rate-limited — anything from
   * half a second to ten — so it is done while the user is still flying, and
   * the button only has to take what is ready. The aircraft's model, its
   * interiors and the ground under it are warmed at the same time.
   */
  private nextShuffle: { found: ShuffleResult; at: number } | null = null;
  private preparingShuffle = false;
  private lastShuffleSearch = 0;
  private povEnteredAt = 0;

  /**
   * Seconds the 3D view keeps drawing after it was left, so the cross-fade
   * back to the map has something to fade. See `Engine.renderEnabled`.
   */
  private renderHold = 0;

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
      onAllFailed: (errors, consecutive) => {
        // One failed cycle is invisible: every aircraft is dead-reckoned
        // between fixes, and the next cycle usually succeeds. Only a run of
        // them is an outage worth interrupting someone for.
        if (consecutive < FEED_FAILURES_BEFORE_NOTICE) return;
        // When the link itself is down, naming four providers and their
        // individual timeouts is noise dressed up as diagnostics — the user
        // already has an offline notice and none of those four is the problem.
        if (networkMonitor.profile.grade === 'offline') {
          app.notify(tr('notice.trafficPaused'), 'warn', 8000);
          return;
        }
        const detail = [...errors.entries()]
          .map(([id, e]) => `${id}: ${describeFeedError(e)}`)
          .join(' | ');
        app.notify(tr('notice.noFeed', { detail }), 'error', 10_000);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async start(
    mapContainer: HTMLElement,
    canvas: HTMLCanvasElement,
    pinOverlay: HTMLCanvasElement,
    link: DeepLink | null = null,
  ): Promise<void> {
    // Boot blocks on nothing that can be deferred.
    //
    // Previously this awaited geolocation (up to 4 s) and then the map's
    // 'load' event, which waits for the first complete render and so can
    // never fire if a single tile stalls. Both are now fire-and-forget: the
    // map opens immediately over a sensible default and re-centres if and
    // when the browser grants a position.
    const linkedPlace = link?.kind === 'map' ? link : null;
    const opening = linkedPlace ?? FALLBACK_VIEW;
    this.query = { lat: opening.lat, lon: opening.lon, radiusNm: 120 };

    this.map = new SelectionMap(mapContainer, {
      onSelect: (hex) => void this.select(hex),
      onHover: (hex) => {
        app.hoveredHex = hex;
      },
      onMoveEnd: (center, radiusNm, bounds: ViewBounds) => {
        this.query = { lat: center.lat, lon: center.lon, radiusNm, bounds };
        app.mapView = { lat: center.lat, lon: center.lon, zoom: this.map?.zoom ?? 8 };
      },
      onError: (message) => app.notify(tr('notice.mapError', { message }), 'warn'),
      onPlacePin: (lat, lon, name) => app.addPin(lat, lon, name),
      onRemovePin: (id) => app.removePin(id),
      onRenamePin: (id, name) => app.renamePin(id, name),
    });
    this.map.setPins(app.pins);
    this.map.init(opening, linkedPlace?.zoom ?? 8);

    // A link says where to look; the visitor's own position does not override it.
    if (!link) void initialView().then((where) => {
      // Only move if the user is somewhere else; re-centring on the fallback
      // would yank a map they may already be panning.
      if (where === FALLBACK_VIEW) return;
      this.query = { ...where, radiusNm: this.query.radiusNm };
      this.map?.flyTo(where.lat, where.lon, 8);
    });

    const surfaces = createSurfaces(canvas, this.origin, pinOverlay, () => this.onContextLost());
    this.engine = surfaces.engine;
    this.engine.origin = this.origin;
    this.engine.overlay = this.cockpit;
    this.cockpit.renderer = this.engine.renderer;
    this.globe = surfaces.globe;
    this.traffic3d = surfaces.traffic3d;
    this.ownAircraft = surfaces.ownAircraft;
    this.pov = surfaces.pov;
    this.pins3d = surfaces.pins3d;
    this.airports = surfaces.airports;
    this.overlay = surfaces.overlay;
    /*
     * The globe changes layer by itself when the active provider stops
     * serving; the 2D map and the attribution line have to follow, or the app
     * spends the rest of the session crediting imagery it is not showing.
     */
    this.globe.onImageryChanged = (source) => {
      this.map?.setImagery(source);
      app.imageryId = source.id;
      app.notify(tr('notice.imagerySwitched', { layer: source.label }), 'warn');
    };

    if (!this.engine.webgl2) {
      app.notify(tr('notice.noWebgl2'), 'error', 0);
    }
    this.connection.start();

    this.client.start(this.feedSource(), 4000);
    this.engine.start((ctx) => this.frame(ctx.dt));

    if (link?.kind === 'aircraft') void this.openAircraftLink(link.hex, link.cam);

    if (import.meta.env.DEV) {
      // Debug handle. Dev-only: nothing in the production bundle reaches it.
      // `__pv` carries the store too, for driving the app from a script.
      Object.assign(window, { __planesview: this, __pv: { orchestrator: this, app } });
    }

    /*
     * No "pick an aircraft" toast: it fired on every reload, in the same strip
     * as the genuine feed and connection warnings, so an instruction the user
     * already followed read as something having gone wrong. The aircraft panel
     * says it at the moment it is true, and `?` has it for anyone looking.
     */
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

    const inPov = app.view === 'pov';
    if (!inPov && this.cockpit.visible) {
      this.cockpit.visible = false;
      app.cockpit3d = false;
    }
    this.renderHold = inPov ? 0.8 : Math.max(0, this.renderHold - dt);
    engine.renderEnabled = inPov || this.renderHold > 0;

    // On the map, nothing reads the fleet between UI refreshes: the markers
    // move at 10 Hz. Sampling a few thousand tracks sixty times a second for
    // them was work thrown away fifty times out of sixty.
    if (!inPov && this.uiAccumulator + dt < 1 / UI_REFRESH_HZ) {
      this.uiAccumulator += dt;
      return;
    }

    const samples = this.traffic.sampleAll(now);
    this.lastSamples = samples;

    const selected = app.selectedHex
      ? samples.find((s) => s.hex === app.selectedHex) ?? null
      : null;

    let flying: SampledAircraft | null = null;

    if (inPov) {
      // Coast on the last known fix rather than ejecting. The camera holds
      // position, the terrain keeps streaming, and `maybeFollow` keeps asking
      // for the aircraft by hex until it answers.
      const step = this.povSession.step(selected, dt);
      flying = step.flying;

      // Low down, a quiet feed is the runway's blind spot, not a lost
      // aircraft: the landing or the takeoff is flown on by the book.
      if (flying) {
        const ground = globe.sampleHeight(flying.lat, flying.lon);
        const aglFt = Number.isFinite(ground) ? flying.altFt - ground / FEET_TO_METRES : Number.NaN;
        const runway = this.runway.step(
          flying,
          this.phaseTracker.phase,
          aglFt,
          (lat, lon) => globe.sampleHeight(lat, lon),
          pov.airframe ? clearanceFor(pov.airframe) : 3,
          dt,
        );
        flying = runway.flying;
        if (runway.landed || this.parkedAndQuiet(flying)) {
          this.arrive();
          return;
        }
      }

      if (step.action === 'exit' && !this.runway.active) {
        app.notify(tr('notice.lostContact'), 'warn');
        this.exitPov();
        return;
      }
      if (!flying) return; // unreachable once 'exit' is handled; narrows the type

      if (step.warn && !this.runway.active) {
        app.notify(tr('notice.signalLost'), 'warn', 4000);
      }

      // Drag gain follows the live camera, so the same drag means the same
      // rotation whatever the window size or field of view.
      const radiansPerPixel =
        (2 * Math.tan((engine.camera.fov * DEG2RAD) / 2)) / engine.viewportHeight;
      pov.setViewport(radiansPerPixel);

      pov.shake = 0;
      pov.speedFovDeg = isInterior(app.cameraMode) ? COCKPIT_FOV_BOOST_DEG : 0;
      pov.update(engine.camera, flying, dt, (lat, lon) => globe.sampleHeight(lat, lon));
      this.trackPhase(flying, dt, globe.sampleHeight(flying.lat, flying.lon));

      // After the camera has moved, so beacons are placed for the frame about
      // to be drawn rather than the last one.
      this.pins3d?.update(app.pins, engine.camera, engine.viewportHeight, (lat, lon) =>
        globe.sampleHeight(lat, lon),
      );
      this.applySunlight();
      this.maybePrefetch(dt, flying);
      this.maybeFollow(dt, flying.hex);

      globe.update(engine.camera, dt, engine.viewportHeight);
      // The night factor is the shared atmosphere's (slot 5, w).
      const aglM = Math.max(0, flying.altFt * FEET_TO_METRES - globe.sampleHeight(flying.lat, flying.lon));
      const where = { aglM, trackDeg: flying.trackDeg, groundSpeedMs: flying.groundSpeedKt * KNOTS_TO_MPS };
      // The map's vector tiles and the satellite night glow are decoration over
      // the ground: while the ground itself is still arriving they wait, rather
      // than share a connection with the tiles the view cannot do without.
      const stats = globe.getStats();
      // Not for ever, though: over fresh ground at speed the terrain never quite
      // stops loading, and decoration that never arrives is worse than late.
      if (stats.loadingTiles <= GROUND_BUSY_TILES) this.groundBusySince = null;
      else this.groundBusySince ??= performance.now();
      const groundBusy = this.groundBusySince !== null && performance.now() - this.groundBusySince < GROUND_BUSY_MAX_MS;
      this.nightLights.update(flying.lat, flying.lon, atmoData[23] ?? 0, dt, { ...where, hold: groundBusy });
      this.groundDetail.update(flying.lat, flying.lon, dt, { ...where, hold: groundBusy });
      this.airports?.update(flying.lat, flying.lon, flying.altFt, atmoData[23] ?? 0, dt, (lat, lon) => globe.sampleHeight(lat, lon));

      this.cameraEcefVec.copy(engine.camera.position);
      traffic3d.update(samples, this.cameraEcefVec, app.selectedHex, (lat, lon) =>
        globe.sampleHeight(lat, lon),
      );

      // The followed aircraft is drawn by its own renderer, at true scale and
      // with the silhouette of its actual type — but not from inside it.
      if (this.ownAircraft) {
        // The registry, not `app.dossier`, and for two reasons. The dossier
        // belongs to whatever is *selected*, which during a switch is not yet
        // the aircraft being flown — so the model was briefly built for the
        // wrong airframe. And the dossier only exists once its network lookup
        // has landed, while the registry already holds the type code the
        // position feed shipped alongside the position, so the right
        // silhouette is usually there on the first frame instead of popping in
        // a second later.
        this.ownAircraft.update(
          flying,
          registry.knownTypeCode(flying.hex),
          // Also shown while flying across to it from another aircraft, so
          // what the camera is heading for is an aeroplane, not empty sky —
          // until the very end, when the camera is about to be inside it.
          !isInterior(app.cameraMode) || (pov.transitionProgress ?? 1) < 0.9,
          dt,
          (lat, lon) => globe.sampleHeight(lat, lon),
        );
        this.ownAircraft.setSun(this.sunVec);
      }
      this.updateCockpit(flying, dt);
      this.commitLights();

      // Text over the view: pin names, and the aircraft that can be clicked.
      if (this.overlay) {
        const frame = this.overlay.begin();
        this.pins3d?.drawLabels(frame, engine.camera);
        // Not mid-switch: labels sliding past during the flight are noise.
        if (pov.transitionProgress === null) {
          traffic3d.drawLabels(frame, engine.camera, { hoverHex: this.hoverTraffic, ownAltFt: flying.altFt });
        }
      }

      // Engines driven from the same inferred regime as the propellers (see
      // `@/state/regime`): sound saying climb power while the propellers said
      // idle would be more noticeable than either being wrong on its own.
      const airframe = pov.airframe;
      if (airframe) {
        this.audio.update(airframe, flightRegime(flying), app.cameraMode);
        // The type code is surer than the emitter category, which many
        // helicopters leave unset; the track flies it as one from here on.
        this.traffic.get(flying.hex)?.setRotorcraft(airframe.kind === 'rotorcraft');
      }
    }

    this.publish(dt, flying ?? selected, samples.length);
  }

  /**
   * The cockpit for the aircraft being ridden, when the view is inside it and
   * not flying between views; its instruments filled from the feed.
   */
  private updateCockpit(sample: SampledAircraft, dt: number): void {
    const pov = this.pov!;
    const engine = this.engine!;
    const globe = this.globe!;
    const show =
      app.view === 'pov' &&
      isInterior(app.cameraMode) &&
      (pov.transitionProgress ?? 1) >= 0.9;
    this.cockpit.visible = show;
    if (app.cockpit3d !== show) app.cockpit3d = show;
    const type = registry.knownTypeCode(sample.hex);
    const shape = pov.airframe ?? shapeFor(type, sample.latest.category ?? null);
    // A freighter's cabin is its hold.
    const freighter = isFreighter(sample.latest.callsign);
    // Both interiors loaded and on the GPU whatever the view, so stepping inside is instant.
    if (app.view === 'pov') this.cockpit.prefetch(type, shape, freighter);
    if (!show) {
      pov.setRestPitch(0);
      return;
    }

    const seat = app.cameraMode === 'cabin' ? 'cabin' : 'cockpit';
    this.cockpit.setAirframe(type, shape, seat, freighter);
    // From the flight deck, a little down onto the panel; from a seat, out of its window.
    const look = seat === 'cabin' ? this.cockpit.look : null;
    if (look) pov.setRestLook(look.yaw, look.pitch);
    else pov.setRestPitch(seat === 'cockpit' ? COCKPIT_REST_PITCH : 0);
    const r = this.readings;
    readingsFromSample(r, sample, globe.sampleHeight(sample.lat, sample.lon));
    fillContacts(r, this.traffic3d!.inRange, engine.camera.position, pov.bodyQuaternion, sample.altFt);
    this.cockpit.update(engine.camera, pov.bodyQuaternion, this.sunVec, r, dt);
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
   *
   * The same measurement bounds how many circles a zoomed-out view is tiled
   * into, for the same reason. Limits and view are re-read on every request,
   * so a pan or a change of link takes effect on the very next one.
   */
  private feedSource(): QuerySource {
    const coverage = this.coverage;
    const sync = () => {
      coverage.setLimits(this.connection.feedRadiusCapNm, this.connection.feedMaxCells);
      coverage.setView(this.query);
    };
    return {
      next: () => {
        sync();
        return coverage.next();
      },
      get cellCount() {
        sync();
        return coverage.cellCount;
      },
    };
  }

  /** The frame's aircraft lights — traffic and the aircraft being ridden — to the GPU. */
  private commitLights(): void {
    const engine = this.engine!;
    const camera = engine.camera;
    const pxPerRad = engine.viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.traffic3d?.lights.commit(performance.now() / 1000, pxPerRad);
  }

  private applySunlight(): void {
    const engine = this.engine;
    const globe = this.globe;
    if (!engine || !globe) return;
    updateSunlight(engine, globe, this.sunVec);
    this.ownAircraft?.setLight(engine.atmosphere.light);
    this.traffic3d?.lights.setLight(engine.atmosphere.light);
    this.cockpit.setLight(engine.atmosphere.light);
    engine.atmosphere.setHaze(hazeForVisibility(app.weather?.visibilityM ?? null));
  }

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

    // The weather about the aircraft: the wind the traffic reports, and the
    // weather model's (cached by cell, so a request every ten minutes at most).
    this.wind.observe(this.lastSamples, sample.lat, sample.lon);
    this.updateClouds(sample);
    void fetchCurrentWeather(sample.lat, sample.lon).then((weather) => {
      if (weather && app.selectedHex === sample.hex) app.weather = weather;
    });

    this.prepareNextShuffle();
  }

  /**
   * The cloud layers from the weather about the aircraft: cover by layer, the
   * low base from the dew-point spread (about 125 m a degree), and the wind
   * the traffic reports at each layer's height. Unknown weather draws no
   * cloud rather than invented cloud.
   */
  private updateClouds(sample: SampledAircraft): void {
    const clouds = this.engine?.clouds;
    if (!clouds) return;
    const w = app.weather;
    const pct = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.min(1, Math.max(0, v / 100)));
    let low = pct(w?.cloudLowPct);
    const mid = pct(w?.cloudMidPct);
    const high = pct(w?.cloudHighPct);
    // A source with only the total: put it where most cloud is.
    if (low === null && mid === null && high === null) low = pct(w?.cloudCoverPct);
    if (!w || (low === null && mid === null && high === null)) {
      clouds.setWeather(null);
      return;
    }
    const ground = this.globe?.sampleHeight(sample.lat, sample.lon);
    const spread = w.temperatureC !== null && w.dewPointC !== null ? w.temperatureC - w.dewPointC : 8;
    const baseAgl = Math.min(2500, Math.max(300, 125 * spread));
    clouds.setWeather({
      low: low ?? 0,
      mid: mid ?? 0,
      high: high ?? 0,
      lowBaseM: (Number.isFinite(ground) ? (ground as number) : 0) + baseAgl,
    });
    const at = { east: 0, north: 0 };
    clouds.heights.forEach((h, i) => {
      this.wind.at(h, Number.POSITIVE_INFINITY, at);
      clouds.setWind(i as 0 | 1 | 2, at.east, at.north);
    });
  }

  /**
   * The area query is centred on the followed aircraft, but a fast one can
   * still outrun the circle between polls, and losing the aircraft you are
   * sitting in is the one failure the user will not forgive.
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

  /**
   * Classify the flown aircraft's phase, announce liftoff and touchdown, and
   * let the auto camera react. Runs every frame so the events land on the
   * frame they happen; the HUD only reads the result at 10 Hz.
   */
  private trackPhase(flying: SampledAircraft, dt: number, groundM: number): void {
    if (this.phaseHex !== flying.hex) {
      this.phaseTracker.reset();
      this.phaseHex = flying.hex;
      this.directorSuppressedFor = null;
    }

    const input: PhaseInput = {
      onGround: flying.latest.onGround === true,
      groundSpeedKt: flying.groundSpeedKt,
      verticalRateFpm: flying.verticalRateFpm,
      aglFt: Number.isFinite(groundM) ? flying.altFt - groundM / FEET_TO_METRES : Number.NaN,
      altFt: flying.altFt,
    };

    const { phase, event } = this.phaseTracker.update(input, dt);
    if (event) app.phaseEvent = { kind: event, id: ++this.phaseEventId, at: Date.now() };
    this.touchdownClock.update(input, phase, dt);
    this.direct(phase);
  }

  /** On the ground at a walk and unheard for a while: it has reached its stand. */
  private parkedAndQuiet(flying: SampledAircraft): boolean {
    const phase = this.phaseTracker.phase;
    return (
      !this.runway.active &&
      flying.latest.onGround === true &&
      (phase === 'taxi' || phase === 'parked') &&
      this.povSession.silence > 8
    );
  }

  /**
   * The flight is over: the aircraft is down and has stopped talking. Said
   * as an arrival, not as a lost signal, and back to the map.
   */
  private arrive(): void {
    const dest = app.dossier?.route?.destination;
    const place = dest?.municipality ?? dest?.name ?? dest?.iata ?? dest?.icao ?? null;
    app.notify(place ? tr('notice.arrivedAt', { place }) : tr('notice.arrived'), 'info', 6000);
    this.exitPov();
  }

  /** Hold the directed view for this phase, or hand the camera back. */
  private direct(phase: FlightPhase): void {
    if (this.directorSuppressedFor !== null && this.directorSuppressedFor !== phase) {
      this.directorSuppressedFor = null;
    }
    let want = app.autoCamera && this.directorSuppressedFor === null ? DIRECTED_VIEWS[phase] : undefined;
    // A passenger at the window keeps the window: the runway rushing by out
    // of it is the same event, seen from the seat that was chosen.
    const chosen = this.directing ? this.userCameraMode : app.cameraMode;
    if (want === 'cockpit' && chosen === 'cabin') want = 'cabin';

    if (want) {
      if (!this.directing) {
        this.userCameraMode = app.cameraMode;
        this.directing = true;
      }
      if (app.cameraMode !== want) this.applyCameraMode(want);
    } else if (this.directing) {
      this.directing = false;
      if (this.directorSuppressedFor === null) this.applyCameraMode(this.userCameraMode);
    }
  }

  private resetPhase(): void {
    this.phaseTracker.reset();
    this.phaseHex = null;
    this.directing = false;
    this.directorSuppressedFor = null;
    app.phase = null;
    app.touchdownInS = null;
    app.phaseEvent = null;
    this.touchdownClock.reset();
    this.runway.reset();
  }

  private publish(dt: number, selected: SampledAircraft | null, tracked: number): void {
    this.uiAccumulator += dt;
    if (this.uiAccumulator < 1 / UI_REFRESH_HZ) return;
    this.uiAccumulator = 0;

    const engine = this.engine;
    const globe = this.globe;
    if (!engine || !globe) return;

    app.selected = selected;
    if (app.view === 'pov') {
      app.phase = this.phaseTracker.phase;
      app.touchdownInS = this.touchdownClock.seconds;
    }
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
        if (track) this.map?.updateTrail(this.flownSoFar(selected.hex, track.trailPoints));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Selection and view transitions
  // -------------------------------------------------------------------------

  /**
   * The dossier lookup is awaited but token-guarded: a user clicking through a
   * busy map faster than the photo lookup answers would otherwise see a panel filled in
   * by whichever request happened to return last.
   */
  async select(hex: string | null): Promise<void> {
    app.selectedHex = hex;
    this.map?.setSelected(hex);
    this.loadHistory(hex);

    if (!hex) {
      clearSelection(this.map);
      return;
    }

    const sample = this.traffic.sampleOne(hex);
    app.selected = sample;
    // Before the camera goes there: see `Globe.warmAt`.
    if (sample) this.globe?.warmAt(sample.lat, sample.lon, networkMonitor.profile.prefetchSeconds > 0);
    await loadSelection(hex, sample, ++this.dossierToken, () => this.dossierToken);
  }

  /** Fetch the selected aircraft's flight so far; drawn on the map once it lands. */
  private loadHistory(hex: string | null): void {
    if (hex && this.history?.hex === hex) return;
    this.historyAbort?.abort();
    this.historyAbort = null;
    this.history = null;
    if (!hex) return;
    const controller = new AbortController();
    this.historyAbort = controller;
    void fetchFlightTrace(hex, controller.signal).then((points) => {
      if (controller.signal.aborted || app.selectedHex !== hex) return;
      this.history = { hex, points };
    });
  }

  /** The leg flown so far: the fetched history up to where this page's own trail begins, then the trail. */
  private flownSoFar(hex: string, trail: readonly TrailPoint[]): readonly TrailPoint[] {
    const history = this.history?.hex === hex ? this.history.points : null;
    if (!history?.length) return trail;
    const from = trail[0]?.t ?? Infinity;
    const before = history.filter((p) => p.t < from);
    return before.length ? [...before, ...trail] : trail;
  }

  /** The leg the aircraft in view has flown so far, for the HUD's minimap. */
  flownPath(): readonly TrailPoint[] {
    const hex = app.selectedHex;
    const track = hex ? this.traffic.get(hex) : undefined;
    return hex && track ? this.flownSoFar(hex, track.trailPoints) : [];
  }

  /** Every aircraft as last sampled, for the HUD's minimap. */
  get samples(): readonly SampledAircraft[] {
    return this.lastSamples;
  }

  enterPov(): void {
    const hex = app.selectedHex;
    if (!hex) return;
    this.povEnteredAt = performance.now();
    armCrashCheck();

    const sample = this.traffic.sampleOne(hex);
    if (!sample) {
      app.notify(tr('notice.notReceived'), 'warn');
      return;
    }

    this.pov?.reset();
    this.resetPhase();
    // `exitPov` suspends the graph rather than tearing it down, so the setting
    // survives a trip back to the map and stepping into the next aircraft is
    // not unexpectedly silent.
    if (app.sound) void this.audio.enable();

    // Place the floating origin on the aircraft before the first frame, so the
    // very first tile selection is already centred correctly and nothing has
    // to stream in after the transition.
    const ecef = geodeticToEcef(sample.lat, sample.lon, sample.altFt * FEET_TO_METRES);
    this.origin.rebase(ecef);
    this.applySunlight();

    // Warm the area before the camera arrives, so the first frame of the
    // cockpit view already has terrain under it.
    this.globe?.warmAt(sample.lat, sample.lon, networkMonitor.profile.prefetchSeconds > 0);
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
    this.userCameraMode = app.cameraMode;
    this.query = { lat: sample.lat, lon: sample.lon, radiusNm: 80 };
  }

  /**
   * A link opened in a tab the app is already running in: the address bar's
   * fragment changed under it (someone pasted one, or pressed Back to one).
   */
  openLink(link: DeepLink): void {
    if (link.kind === 'map') {
      if (app.view === 'pov') this.exitPov();
      void this.select(null);
      this.query = { lat: link.lat, lon: link.lon, radiusNm: this.query.radiusNm };
      this.map?.flyTo(link.lat, link.lon, link.zoom);
      return;
    }
    if (link.hex === app.selectedHex) {
      if (link.cam && app.view !== 'pov') this.enterPov();
      if (link.cam) this.setCameraMode(link.cam);
      return;
    }
    if (app.view === 'pov') this.exitPov();
    void this.openAircraftLink(link.hex, link.cam);
  }

  /**
   * Open a shared link to an aircraft: find it anywhere in the world, show it
   * on the map, and step into the seat the link names.
   *
   * The lookup shares the feed's politeness floor with the poll that has just
   * started, so the first try is often turned away unasked; it is retried a
   * few times before the aircraft is declared gone. A link to a flight that
   * has since landed is common and not an error — it says so and leaves the
   * visitor on the map.
   */
  private async openAircraftLink(hex: string, cam: CameraMode | null): Promise<void> {
    const token = ++this.shuffleToken;
    app.linkPending = true;
    try {
      let found: Awaited<ReturnType<TrafficClient['fetchAircraft']>> = null;
      for (let attempt = 0; attempt < 6 && !found; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500));
        if (token !== this.shuffleToken) return;
        found = await this.client.fetchAircraft(hex).catch(() => null);
      }
      if (token !== this.shuffleToken) return;
      if (!found) {
        app.notify(tr('link.gone'), 'warn', 6000);
        return;
      }
      this.traffic.ingestOne(found);
      this.query = { lat: found.lat, lon: found.lon, radiusNm: 80 };
      this.map?.flyTo(found.lat, found.lon, 9);
      void this.select(hex);
      if (!cam) return;
      this.enterPov();
      this.setCameraMode(cam);
    } finally {
      app.linkPending = false;
    }
  }

  /**
   * The GPU took its memory back. The view cannot be rebuilt in place, so
   * the page comes back a step lighter, at the same aircraft and seat — the
   * address bar already holds the link to them.
   */
  private onContextLost(): void {
    // Our own teardown, not the GPU's: nothing to recover from.
    if (this.disposed) return;
    recordMemoryLoss();
    app.notify(tr('notice.gpuReset'), 'warn', 0);
    setTimeout(() => location.reload(), 1800);
  }

  // -------------------------------------------------------------------------
  // Photos and clips
  // -------------------------------------------------------------------------

  private clip: ClipRecorder | null = null;

  /** The phone's gyroscope, turning the head in the 3D view. Off until asked for. */
  private readonly gyro = new GyroLook((dYaw, dPitch) => {
    if (app.view === 'pov') this.pov?.applyLook(dYaw, dPitch);
  });

  /** Must be called from a tap: iOS asks for permission, and only then. */
  async setGyro(on: boolean): Promise<void> {
    if (!on) {
      this.gyro.disable();
      app.gyro = false;
      return;
    }
    app.gyro = await this.gyro.enable();
    if (!app.gyro) app.notify(tr('hud.gyroDenied'), 'warn', 6000);
  }

  /** Save the view as a photo, captioned with the flight. Only the 3D view is drawn by the engine. */
  async takePhoto(): Promise<void> {
    const engine = this.engine;
    if (!engine || app.view !== 'pov') return;
    const flight = describeFlight(app.selected, app.dossier);
    const frame = await engine.captureFrame();
    const when = new Date();
    const stamp = `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const altitude = app.selected ? `${Math.round(app.selected.altFt / 100) * 100} ft` : null;
    captionPhoto(frame, [flight, ['PlanesView', altitude, stamp].filter(Boolean).join(' · ')]);
    const blob = await toJpeg(frame);
    if (!blob) return;
    if (await deliverFile(blob, captureName(flight, 'jpg', when))) app.notify(tr('capture.saved'), 'info', 2500);
  }

  /** Start a clip, or stop the one running and save it. */
  async toggleRecording(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    if (this.clip) {
      const clip = this.clip;
      this.clip = null;
      app.recordingSince = null;
      const blob = await clip.stop();
      const flight = describeFlight(app.selected, app.dossier);
      if (blob.size > 0 && (await deliverFile(blob, captureName(flight, clip.extension)))) {
        app.notify(tr('capture.clipSaved'), 'info', 2500);
      }
      return;
    }
    if (app.view !== 'pov') return;
    if (!canRecord()) {
      app.notify(tr('capture.unsupported'), 'warn', 4000);
      return;
    }
    try {
      this.clip = new ClipRecorder(engine.renderer.domElement, () => void this.toggleRecording());
      app.recordingSince = this.clip.startedAt;
    } catch {
      this.clip = null;
      app.notify(tr('capture.unsupported'), 'warn', 4000);
    }
  }

  /**
   * Leave this aircraft for a random one somewhere else in the world.
   *
   * Guarded on a token rather than a boolean: the search takes a second or two
   * over several regions and the user can press it again, press Escape, or
   * select something on the map in the meantime. Whichever action is newest
   * wins and the older searches land nowhere.
   */
  async shuffleAircraft(): Promise<void> {
    if (app.shuffling) return;
    app.shuffling = true;
    const token = ++this.shuffleToken;

    try {
      const found = this.takeNextShuffle() ?? (await this.searchShuffle());

      if (token !== this.shuffleToken) return;

      if (!found) {
        app.notify(tr('notice.feedUnreachable'), 'warn');
        return;
      }

      // Into the store before selecting: `select` and `enterPov` both read the
      // track, and this aircraft is nowhere near the viewport query that has
      // been running, so nothing else would have put it there. A report found
      // ahead of time is carried forward from its fix time by the track.
      this.traffic.ingestOne(found.aircraft);

      // Point the feed at the new place *first*. Otherwise the next poll is
      // still asking about the airspace we just left, and the aircraft we have
      // just stepped into goes unrefreshed until the session gives up on it.
      this.query = { lat: found.aircraft.lat, lon: found.aircraft.lon, radiusNm: 80 };

      // Not awaited: the flight card fills in when the dossier lands; the
      // aircraft is flown from the first frame.
      void this.select(found.aircraft.hex);
      if (token !== this.shuffleToken) return;

      this.enterPov();
      app.notify(tr('notice.nowOver', { place: found.region.name }), 'info', 4500);
    } finally {
      // Unconditionally: only one search can be in flight (the guard above),
      // so this is always *our* flag. Clearing it only on a token match left
      // the button disabled for the rest of the session whenever the user
      // pressed Escape while the search was running.
      app.shuffling = false;
    }
  }

  /**
   * Put the map over a place the user asked for.
   *
   * The traffic query is moved with it, so the aircraft over that city start
   * loading at once instead of when the map's own move settles.
   */
  goToPlace(place: PlaceResult): void {
    this.query = { lat: place.lat, lon: place.lon, radiusNm: this.query.radiusNm };
    this.map?.flyTo(place.lat, place.lon, place.zoom);
  }

  /**
   * Step into a random aircraft of exactly this model, wherever it is.
   *
   * Same guard as `shuffleAircraft`: the lookup takes a moment, and whichever
   * of "somewhere else", "catch a landing" and this was asked for last wins.
   */
  async flyToType(code: string): Promise<void> {
    if (app.shuffling) return;
    app.shuffling = true;
    const token = ++this.shuffleToken;
    const what = typeName(code) ?? code;

    try {
      const found = await this.client.fetchByType(code);
      if (token !== this.shuffleToken) return;
      if (found === null) {
        app.notify(tr('notice.feedUnreachable'), 'warn');
        return;
      }
      const pick = pickOfType(found, { excludeHex: app.selectedHex });
      if (!pick) {
        app.notify(tr('notice.noneFound', { what }), 'warn');
        return;
      }
      // As in `shuffleAircraft`: into the track first, the feed pointed at the
      // new place before anything is selected.
      this.traffic.ingestOne(pick);
      this.query = { lat: pick.lat, lon: pick.lon, radiusNm: 80 };
      void this.select(pick.hex);
      if (token !== this.shuffleToken) return;
      this.enterPov();
    } finally {
      app.shuffling = false;
    }
  }

  private searchShuffle(): Promise<ShuffleResult | null> {
    this.lastShuffleSearch = performance.now();
    return findRandomAircraft((query, signal) => this.client.fetchOnce(query, signal), { excludeHex: app.selectedHex });
  }

  /** The aircraft found ahead of time, if it is still fresh enough to fly into. */
  private takeNextShuffle(): ShuffleResult | null {
    const next = this.nextShuffle;
    this.nextShuffle = null;
    if (!next || performance.now() - next.at > NEXT_SHUFFLE_FRESH_MS || next.found.aircraft.hex === app.selectedHex) return null;
    return next.found;
  }

  /**
   * Find the next "somewhere else" in the background, and warm what arriving
   * there will need. Not before the current aircraft has settled — its own
   * tiles and models come first — and not more often than the feed can bear.
   */
  private prepareNextShuffle(): void {
    if (this.preparingShuffle || app.view !== 'pov' || app.shuffling) return;
    const now = performance.now();
    if (now - this.povEnteredAt < 8000 || now - this.lastShuffleSearch < 20_000) return;
    if (this.nextShuffle && now - this.nextShuffle.at < NEXT_SHUFFLE_FRESH_MS * 0.7) return;
    this.preparingShuffle = true;
    void this.searchShuffle()
      .then((found) => {
        if (!found) return;
        this.nextShuffle = { found, at: performance.now() };
        const a = found.aircraft;
        const type = registry.knownTypeCode(a.hex);
        void loadModelFor(type, operatorOf(a.callsign), a.category);
        if (type) this.cockpit.prefetch(type, shapeFor(type, a.category), isFreighter(a.callsign));
        this.globe?.prefetchAlong(a.lat, a.lon, a.trackDeg ?? 0, (a.groundSpeedKt ?? 0) * KNOTS_TO_MPS, 20, 12);
      })
      .finally(() => (this.preparingShuffle = false));
  }

  exitPov(): void {
    // Abandon any search in flight: landing in a random aircraft several
    // seconds after the user asked to go back to the map is not a feature.
    this.shuffleToken++;
    // A clip ends with the view it was recording, and is kept.
    if (this.clip) void this.toggleRecording();
    app.view = 'map';
    // Give back the view the user chose, not the one the auto camera held.
    if (this.directing) this.applyCameraMode(this.userCameraMode);
    this.resetPhase();
    this.pov?.reset();
    this.povSession.reset();
    this.overlay?.clear();
    this.hoverTraffic = null;
    // Nothing is being flown any more, so nothing should be heard. The setting
    // itself is kept, so stepping into the next aircraft is not silent.
    this.audio.disable();

    const sample = app.selectedHex ? this.traffic.sampleOne(app.selectedHex) : null;
    if (sample) this.map?.flyTo(sample.lat, sample.lon);
    this.map?.resize();
  }

  /**
   * The aircraft under a point of the 3D view, for the cursor. Returns true
   * when there is one, so the caller can show that it can be clicked.
   */
  hoverAt(x: number, y: number): boolean {
    const engine = this.engine;
    if (app.view !== 'pov' || !engine || !this.traffic3d) {
      this.hoverTraffic = null;
      return false;
    }
    const rect = engine.renderer.domElement.getBoundingClientRect();
    this.hoverTraffic = this.traffic3d.pick(x - rect.left, y - rect.top);
    return this.hoverTraffic !== null;
  }

  /** A click in the 3D view: step across to the aircraft there, if any. */
  clickAt(x: number, y: number): boolean {
    if (!this.hoverAt(x, y) || !this.hoverTraffic) return false;
    this.switchTo(this.hoverTraffic);
    return true;
  }

  /**
   * Leave this aircraft for another one nearby, flying the camera across.
   *
   * The same steps as choosing it on the map — select, then step inside —
   * with the camera's pose captured first and handed to the controller, which
   * blends from it to the new aircraft over the next second or two. See
   * `PovController.beginTransition`.
   */
  switchTo(hex: string): void {
    const engine = this.engine;
    const pov = this.pov;
    if (!engine || !pov || hex === app.selectedHex) return;

    const from = new Vector3(
      engine.camera.position.x + this.origin.current[0],
      engine.camera.position.y + this.origin.current[1],
      engine.camera.position.z + this.origin.current[2],
    );
    const fromQuat = engine.camera.quaternion.clone();

    const sample = this.traffic.sampleOne(hex);
    if (!sample) return;

    // Not awaited: `select` sets the selection at once and then waits on the
    // dossier lookup, a network round trip. The flight across starts on the
    // click; the flight card fills in when the lookup lands.
    void this.select(hex);
    this.enterPov();
    const to = geodeticToEcef(sample.lat, sample.lon, sample.altFt * FEET_TO_METRES);
    pov.beginTransition(from, fromQuat, new Vector3(to[0], to[1], to[2]));
    this.hoverTraffic = null;
  }

  /** Keep the map's markers in step with the store. */
  syncPins(pins: readonly Pin[]): void {
    this.map?.setPins(pins);
  }

  setPinMode(on: boolean): void {
    this.map?.setPinMode(on);
  }

  /** The user choosing a view. Also takes it back from the auto camera. */
  setCameraMode(mode: CameraMode): void {
    this.userCameraMode = mode;
    this.lastInGroup[isInterior(mode) ? 'interior' : 'exterior'] = mode;
    if (this.directing) this.directorSuppressedFor = this.phaseTracker.phase;
    this.applyCameraMode(mode);
  }

  /** Inside or outside: back to the view last chosen there. */
  setCameraGroup(group: CameraGroup): void {
    if ((isInterior(app.cameraMode) ? 'interior' : 'exterior') === group) return;
    this.setCameraMode(this.lastInGroup[group]);
  }

  toggleCameraGroup(): void {
    this.setCameraGroup(isInterior(app.cameraMode) ? 'exterior' : 'interior');
  }

  private applyCameraMode(mode: CameraMode): void {
    this.pov?.setMode(mode);
    app.cameraMode = mode;
  }

  /**
   * Step into an aircraft that is landing or taking off right now.
   *
   * Nearby first — see `./catch`. Shares the shuffle's token and busy flag,
   * because it is the same kind of action: a search that may take a few
   * seconds and that any newer choice should silently cancel.
   */
  async catchAircraft(kind: CatchKind): Promise<void> {
    if (app.shuffling) return;
    const label = tr(kind === 'landing' ? 'catch.landing' : 'catch.takeoff');

    const near = app.selected ?? this.map?.center ?? FALLBACK_VIEW;
    const local = pickNearby(kind, this.lastSamples, near, app.view === 'pov' ? app.selectedHex : null);
    if (local) {
      // Already flying and it is close: fly across to it rather than cut.
      const current = app.view === 'pov' ? app.selected : null;
      if (current && haversineMetres(current.lat, current.lon, local.lat, local.lon) < 100_000) {
        this.switchTo(local.hex);
      } else {
        await this.select(local.hex);
        this.enterPov();
      }
      return;
    }

    app.shuffling = true;
    const token = ++this.shuffleToken;
    try {
      const found = await findRandomAircraft((query, signal) => this.client.fetchOnce(query, signal), {
        excludeHex: app.selectedHex,
        accept: acceptsForCatch(kind),
      });
      if (token !== this.shuffleToken) return;
      if (!found) {
        app.notify(tr('notice.noneFound', { what: label }), 'warn');
        return;
      }
      this.traffic.ingestOne(found.aircraft);
      this.query = { lat: found.aircraft.lat, lon: found.aircraft.lon, radiusNm: 80 };
      await this.select(found.aircraft.hex);
      if (token !== this.shuffleToken) return;
      this.enterPov();
      app.notify(tr('notice.caught', { what: label, place: found.region.name }), 'info', 4500);
    } finally {
      app.shuffling = false;
    }
  }

  /**
   * Async because starting an AudioContext is, and because the browser may
   * simply refuse — not an error worth a toast. A notice explaining autoplay
   * policy would be the app blaming the browser at the user.
   */
  /** The tab went to the background or came back. See `./tabs`. */
  setBackground(hidden: boolean): void {
    this.audio.setBackground(hidden);
  }

  async setSound(on: boolean): Promise<void> {
    if (on) {
      app.sound = await this.audio.enable();
    } else {
      this.audio.disable();
      app.sound = false;
    }
  }

  /** Borders and place names over the selection map. */
  setLabels(visible: boolean): void {
    this.map?.setLabels(visible);
    app.showLabels = visible;
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
    if (this.pov) this.pov.invertY = app.invertY;
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

  private disposed = false;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.clip) void this.toggleRecording();
    this.historyAbort?.abort();
    this.connection.dispose();
    this.client.stop();
    this.engine?.dispose();
    this.globe?.dispose();
    this.nightLights.dispose();
    this.groundDetail.dispose();
    this.traffic3d?.dispose();
    this.ownAircraft?.dispose();
    this.pins3d?.dispose();
    this.airports?.dispose();
    this.overlay?.dispose();
    this.audio.dispose();
    this.gyro.disable();
    this.map?.dispose();
    // The GPU memory goes back now, not whenever the browser gets round to
    // collecting the page: a frozen tab must not keep a gigabyte of terrain.
    this.engine?.renderer.forceContextLoss();
  }
}
