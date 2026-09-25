/**
 * Upstream endpoints and how requests reach them.
 *
 * ## Why this module exists
 *
 * The project brief assumes every free ADS-B feed can be called straight from
 * the browser. Measured against the live services, none of them can be:
 *
 * | Service          | `Access-Control-Allow-Origin` | Usable from a page? |
 * |------------------|-------------------------------|---------------------|
 * | adsb.lol         | *absent*                      | no                  |
 * | adsb.fi          | *absent*                      | no                  |
 * | OpenSky          | `https://opensky-network.org` | no                  |
 * | airplanes.live   | 403, approval required        | no                  |
 * | planespotters    | `*`, but demands a custom `User-Agent` — a header browsers forbid scripts from setting | no |
 * | adsbdb           | `*`                           | **yes**             |
 * | Open-Meteo       | `*`                           | **yes**             |
 * | Esri / EOX / AWS | `*`                           | **yes**             |
 *
 * So imagery, terrain, airframe metadata and weather are genuinely
 * backend-free. The traffic feed and photos are not, and no amount of
 * client-side code changes that — CORS is enforced by the browser.
 *
 * The resolution keeps every constraint that actually mattered (free, no API
 * key, no account, no card) by routing those two through a relay:
 *
 *  - **Development** — Vite's dev server proxies `/feeds/*`. No extra process.
 *  - **Production**  — `functions/feeds/[[path]].ts`, a Cloudflare Pages
 *    Function on the free tier. Deploy it beside the static build and the
 *    same paths keep working. `deploy/` has equivalents for other hosts.
 *
 * Set `VITE_DIRECT_FEEDS=1` to bypass the relay and call upstream directly —
 * useful inside a browser extension, an Electron shell, or if a provider ever
 * starts sending permissive CORS.
 */

import relayTargets from '../../relay-targets.json';

/** True when the build was told to skip the relay. */
const DIRECT_FEEDS = import.meta.env['VITE_DIRECT_FEEDS'] === '1';

/**
 * Path prefix the relay listens on. Kept relative so the app works from a
 * sub-path deployment (GitHub Pages project sites) without reconfiguration.
 */
const FEED_PREFIX = 'feeds';

/**
 * Upstream origins, one per relayed service.
 *
 * Kept in `relay-targets.json` at the repo root so that the app, the Vite dev
 * proxy and the deployed relay function all read the *same* list. Adding a
 * provider means editing one file.
 */
export type RelayTarget =
  | 'adsb-lol'
  | 'adsb-fi'
  | 'airplanes-live'
  | 'opensky'
  | 'planespotters';

const UPSTREAM = relayTargets as Record<RelayTarget, string>;

/**
 * Build a URL for a relayed service. `path` must start with `/`.
 *
 * The relative base matters: on GitHub Pages the app may live at
 * `/planesview/`, and an absolute `/feeds/...` would miss the function.
 */
export function relayUrl(target: RelayTarget, path: string): string {
  if (DIRECT_FEEDS) return `${UPSTREAM[target]}${path}`;
  const base = new URL(import.meta.env.BASE_URL ?? '/', window.location.href);
  return new URL(`${FEED_PREFIX}/${target}${path}`, base).toString();
}

/** Services that speak CORS properly and are always called directly. */
export const DIRECT = {
  adsbdb: 'https://api.adsbdb.com',
  openMeteo: 'https://api.open-meteo.com',
} as const;
