/**
 * How much of the device the 3D view may use.
 *
 * Phones do not tell a page it is running out of memory. iOS kills the tab's
 * whole process ("A problem repeatedly occurred") and Android Chrome shows
 * "Aw, Snap" — and both blame the site, which is fair: the globe was sized for
 * a desktop GPU. Up to six thousand terrain tiles, each a quarter-megabyte
 * texture with its mipmaps plus its mesh, is well past what a phone allows a
 * single tab, so the view crashed after a few minutes of flying.
 *
 * So the budget is set by the device class, up front, and it learns: a run
 * that ended without the page being closed normally — which on a phone means
 * the tab was killed — makes the next one a step lighter, and a long clean
 * session earns a step back. A device that cannot hold the full picture ends
 * up with one it can hold, instead of a crash loop.
 */

export type DeviceTier = 'high' | 'mid' | 'low' | 'minimal';

export interface DeviceBudget {
  tier: DeviceTier;
  /** Terrain tiles the globe may keep, drawn or not. */
  maxResidentTiles: number;
  /** MSAA samples for the offscreen scene; 0 for none. */
  msaaSamples: number;
  /** Bloom, flare and the float depth buffer. Off only at the bottom. */
  post: boolean;
  /** Ceiling on the adaptive pixel ratio. */
  maxPixelRatio: number;
  /** Ceiling on texture anisotropy. */
  maxAnisotropy: number;
  /** Longest side of an aircraft or cockpit texture, px; larger sheets are scaled down on load. */
  maxModelTexture: number;
}

const TIERS: readonly DeviceTier[] = ['high', 'mid', 'low', 'minimal'];

const BUDGETS: Record<DeviceTier, Omit<DeviceBudget, 'tier' | 'maxPixelRatio'> & { pixelRatio: number }> = {
  high: { maxResidentTiles: 6000, msaaSamples: 4, post: true, pixelRatio: 2, maxAnisotropy: 16, maxModelTexture: 4096 },
  mid: { maxResidentTiles: 1800, msaaSamples: 4, post: true, pixelRatio: 1.75, maxAnisotropy: 8, maxModelTexture: 2048 },
  low: { maxResidentTiles: 900, msaaSamples: 2, post: true, pixelRatio: 1.5, maxAnisotropy: 4, maxModelTexture: 1024 },
  minimal: { maxResidentTiles: 600, msaaSamples: 0, post: false, pixelRatio: 1.25, maxAnisotropy: 2, maxModelTexture: 512 },
};

export interface DeviceSignals {
  userAgent: string;
  /** `navigator.deviceMemory`, GB, where the browser reports it (Chromium only). */
  deviceMemoryGb: number | null;
  maxTouchPoints: number;
  platform: string;
  /** Short side of the screen, CSS px. */
  screenShortSide: number;
}

/** A phone or tablet, including an iPad that reports itself as a Mac. */
function isHandheld(s: DeviceSignals): boolean {
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(s.userAgent)) return true;
  return s.platform === 'MacIntel' && s.maxTouchPoints > 1;
}

/** The tier the device's class suggests, before anything is learnt from crashes. */
export function baseTier(s: DeviceSignals): DeviceTier {
  const memory = s.deviceMemoryGb;
  if (!isHandheld(s)) return memory !== null && memory <= 4 ? 'mid' : 'high';
  // A tablet has the GPU of a laptop and the memory rules of a phone.
  const tablet = s.screenShortSide >= 700;
  if (memory !== null) {
    if (memory >= 8) return 'mid';
    if (memory >= 4) return tablet ? 'mid' : 'low';
    return 'minimal';
  }
  // iOS reports nothing; an iPad is mid, an iPhone low.
  return tablet ? 'mid' : 'low';
}

export function budgetFor(tier: DeviceTier, devicePixelRatio: number): DeviceBudget {
  const b = BUDGETS[tier];
  return {
    tier,
    maxResidentTiles: b.maxResidentTiles,
    msaaSamples: b.msaaSamples,
    post: b.post,
    maxPixelRatio: Math.min(devicePixelRatio, b.pixelRatio),
    maxAnisotropy: b.maxAnisotropy,
    maxModelTexture: b.maxModelTexture,
  };
}

/** `steps` tiers lighter than `tier`, never past the bottom. */
export function stepDown(tier: DeviceTier, steps: number): DeviceTier {
  const i = Math.min(TIERS.length - 1, TIERS.indexOf(tier) + Math.max(0, steps));
  return TIERS[i]!;
}

// ---------------------------------------------------------------------------
// Learning from the last run
// ---------------------------------------------------------------------------

/** Steps down earned by crashes, 0–3. Local storage: a device stays the device it is. */
const DROP_KEY = 'pv.tierDrop';
/** Set while the 3D view runs, cleared when the page is closed normally. */
const ALIVE_KEY = 'pv.alive';
/** Seconds of 3D view, uninterrupted, that earn a step back up. */
const CLEAN_RUN_S = 20 * 60;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private window or storage blocked: nothing is learnt, the base tier stands.
  }
}

/**
 * Notice how the last run ended, and arm the check for this one.
 *
 * The flag is set when the heavy view is first used, not at boot — a tab
 * killed on the front page says nothing about the globe — and cleared on
 * `pagehide`, which a normal close, a reload and a navigation all fire, and
 * a killed process does not.
 */
function learnedDrop(): number {
  let drop = Number(read(DROP_KEY) ?? 0) || 0;
  if (read(ALIVE_KEY) === '1') {
    drop = Math.min(3, drop + 1);
    write(DROP_KEY, String(drop));
    write(ALIVE_KEY, null);
  }
  return drop;
}

let armed = false;
let armedAt = 0;

/** The 3D view is being used: from here, an unannounced end counts as a crash. */
export function armCrashCheck(): void {
  if (armed) return;
  armed = true;
  armedAt = performance.now();
  write(ALIVE_KEY, '1');
  const clear = (): void => {
    write(ALIVE_KEY, null);
    // A long session at this budget is evidence it fits: earn a step back.
    if ((performance.now() - armedAt) / 1000 > CLEAN_RUN_S) {
      const drop = Number(read(DROP_KEY) ?? 0) || 0;
      if (drop > 0) write(DROP_KEY, String(drop - 1));
    }
  };
  addEventListener('pagehide', clear);
  // A phone reclaims background tabs as a matter of course; that is not this
  // page failing. Only an end while the page is on screen counts.
  document.addEventListener('visibilitychange', () => {
    write(ALIVE_KEY, document.visibilityState === 'visible' ? '1' : null);
  });
  // Coming back from the back/forward cache: the page is alive again.
  addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) write(ALIVE_KEY, '1');
  });
}

/** The graphics context was lost for want of memory: take a step down for next time. */
export function recordMemoryLoss(): void {
  const drop = Number(read(DROP_KEY) ?? 0) || 0;
  write(DROP_KEY, String(Math.min(3, drop + 1)));
  write(ALIVE_KEY, null);
}

let cached: DeviceBudget | null = null;

/** This device's budget, decided once per page. */
export function deviceBudget(): DeviceBudget {
  if (cached) return cached;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const signals: DeviceSignals = {
    userAgent: nav.userAgent,
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    platform: nav.platform ?? '',
    // The window's short side bounds it too: an embedded or emulated browser
    // can report the host's screen, and a tablet in split view is a phone's
    // width (and gets a phone's budget, which is the safe side to err on).
    screenShortSide: Math.min(screen.width, screen.height, innerWidth, innerHeight),
  };
  const forced = new URLSearchParams(location.search).get('tier');
  const tier = TIERS.includes(forced as DeviceTier)
    ? (forced as DeviceTier)
    : stepDown(baseTier(signals), learnedDrop());
  cached = budgetFor(tier, window.devicePixelRatio || 1);
  return cached;
}
