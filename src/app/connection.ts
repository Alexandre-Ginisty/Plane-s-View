/**
 * Connection supervisor.
 *
 * Owns everything to do with "how good is this link, and what should the app
 * do about it": the monitor subscription, the active latency probes, the
 * messages the user sees when the answer changes, and the query radius the
 * traffic feed is allowed to ask for.
 *
 * Separated from the orchestrator because it is a policy, not a loop. The
 * orchestrator's job is ordering — camera before quadtree, selection before
 * eviction — and this has nothing to do with ordering; it just needed a place
 * to live that was not "wherever there was room".
 */

import { networkMonitor, type NetworkGrade, type StreamingProfile } from '@/net/quality';
import { TERRARIUM } from '@/tiles/sources';
import { app } from '@/state/appStore.svelte';

/**
 * A tiny, always-present tile used purely to time a round trip.
 *
 * The whole-world z0 heightmap: a few kB, served by the same CDN as the real
 * elevation, and guaranteed to exist everywhere on Earth. Measuring against a
 * host we do not otherwise use would measure the wrong network path.
 */
const PROBE_URL = TERRARIUM.url(0, 0, 0);

/** Seconds between active latency probes while the link is known to be bad. */
const PROBE_INTERVAL_SEC = 30;

/** How long to let the initial tile burst clear before probing. */
const PROBE_SETTLE_MS = 8000;

/**
 * Largest traffic query radius each grade is allowed to ask for, nautical miles.
 *
 * The cost of a query is roughly the area, so halving the radius quarters the
 * payload. `offline` is not zero because the request still has to be attempted
 * for the recovery to be noticed.
 */
const FEED_RADIUS_CAP_NM: Record<NetworkGrade, number> = {
  fast: 250,
  good: 250,
  slow: 80,
  poor: 40,
  offline: 40,
};

/** Plain-language explanation of each connection grade, for the user. */
const GRADE_MESSAGE: Record<NetworkGrade, { text: string; level: 'info' | 'warn' | 'error' }> = {
  fast: { text: 'Connection is strong — streaming terrain at full detail.', level: 'info' },
  good: { text: 'Connection recovered — back to full detail.', level: 'info' },
  slow: {
    text: 'Slow connection — reducing terrain detail so the ground keeps up.',
    level: 'warn',
  },
  poor: {
    text: 'Weak connection — the ground will be soft, but it will stay smooth and complete.',
    level: 'warn',
  },
  offline: {
    text: 'No connection. Showing terrain already stored on this device; live traffic is paused.',
    level: 'error',
  },
};

export class ConnectionSupervisor {
  private probeAccumulator = 0;
  /** Last grade announced to the user, so only real changes are announced. */
  private announcedGrade: NetworkGrade | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly onConnectivityChange = (): void => this.handleConnectivityChange();

  /**
   * @param onProfile Called whenever the profile changes, so the renderer can
   * retune. A callback rather than a direct `Globe` reference: the supervisor
   * has no business knowing that a globe exists.
   */
  constructor(private readonly onProfile: (profile: StreamingProfile) => void) {}

  /**
   * Largest radius the traffic query may ask for on this link, nm.
   *
   * From the measured grade, not the user's detail ceiling. Detail is about
   * how sharp the terrain is; this is about how much JSON the link can carry.
   * Tying them together meant choosing standard detail quietly cut the number
   * of aircraft on the map from a 250 nm circle to an 80 nm one, which is not
   * a thing anyone asked for and not a thing the setting says it does.
   */
  get feedRadiusCapNm(): number {
    return FEED_RADIUS_CAP_NM[networkMonitor.measuredGrade];
  }

  get profile(): StreamingProfile {
    return networkMonitor.profile;
  }

  /**
   * Watch the link and retune the renderer to it.
   *
   * Two signals, because neither alone is sufficient. The browser's own
   * `online`/`offline` events are authoritative about a cable being pulled and
   * completely blind to the far more common case — a connection that is
   * nominally up and delivering 30 kB/s on a train. The passive measurement
   * catches that one and is blind to nothing except the first few seconds,
   * which is what the startup probe covers.
   */
  start(): void {
    this.unsubscribe = networkMonitor.subscribe((profile, readout) => {
      app.network = readout;
      app.networkProfile = profile;
      this.onProfile(profile);

      // The *measured* grade, not the effective profile.
      //
      // The profile is the measurement held under the user's detail ceiling
      // (see `@/net/quality/preference`), so on standard detail it reads
      // `slow` however good the link is — and this would then announce "Slow
      // connection" to someone on fibre who had simply left the app on its
      // default. These messages exist to explain the connection; a message
      // that names the wrong cause sends the user to fix the wrong thing.
      // Announce a grade *change*, not every emission.
      //
      // The monitor now emits when the user's detail ceiling moves as well as
      // when the link does, so an unguarded notify fired "Connection
      // recovered — back to full detail" the instant someone switched to high
      // detail. Nothing about the connection had happened.
      if (readout.grade === this.announcedGrade) return;
      this.announcedGrade = readout.grade;

      const message = GRADE_MESSAGE[readout.grade];
      // `fast` is not announced. Nobody needs to be told their connection is
      // fine, and a toast for it would fire every time a train left a tunnel.
      if (readout.grade !== 'fast') {
        app.notify(message.text, message.level, readout.grade === 'offline' ? 0 : 8000);
      }
    });

    window.addEventListener('online', this.onConnectivityChange);
    window.addEventListener('offline', this.onConnectivityChange);

    // Deliberately *not* immediate.
    //
    // A probe fired at boot races the app's own first burst of tile requests
    // and opens a fresh connection to a host nothing is talking to yet.
    // Measured, that read 5.7 s on a fibre link — congestion this app caused
    // itself, reported as a property of the user's connection. Letting the
    // burst clear first makes the number mean something.
    setTimeout(() => void networkMonitor.probe(PROBE_URL), PROBE_SETTLE_MS);
  }

  private handleConnectivityChange(): void {
    // The browser's verdict feeds the same classifier as everything else, so
    // the profile, the notice and the UI all move together.
    networkMonitor.refresh();
    if (navigator.onLine) void networkMonitor.probe(PROBE_URL);
  }

  /**
   * Re-probe while the link is bad.
   *
   * A degraded link produces few completed transfers, and a link that has
   * fallen over produces none at all — so the passive window stops updating
   * exactly when it matters most, and nothing would ever notice the recovery.
   * One small request every thirty seconds is the cost of not being stuck in
   * low detail after the train leaves the tunnel.
   */
  tick(dt: number): void {
    const grade = networkMonitor.profile.grade;
    if (grade === 'fast' || grade === 'good') {
      this.probeAccumulator = 0;
      return;
    }
    this.probeAccumulator += dt;
    if (this.probeAccumulator < PROBE_INTERVAL_SEC) return;
    this.probeAccumulator = 0;
    void networkMonitor.probe(PROBE_URL);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    window.removeEventListener('online', this.onConnectivityChange);
    window.removeEventListener('offline', this.onConnectivityChange);
  }
}
