/**
 * Upstream endpoints and how requests reach them.
 *
 * ## Only services that may be used commercially
 *
 * Every service here is free *and* allows a commercial product to use it. That
 * excludes most of what an aircraft tracker normally leans on: OpenSky and
 * adsb.fi are for personal or research use (adsb.fi is used anyway while the site is a demonstration), airplanes.live asks for approval,
 * Open-Meteo's free tier is non-commercial, and Planespotters and
 * airport-data.com photographs belong to their photographers. What is left:
 *
 * | Service        | Licence                      | Reached how |
 * |----------------|------------------------------|-------------|
 * | adsb.lol       | ODbL                         | relay       |
 * | MET Norway     | CC BY 4.0 / NLOD             | relay       |
 * | Wikimedia Commons | per file, filtered to CC BY / CC BY-SA / CC0 / PD | direct |
 * | EOX / NASA / AWS / OpenFreeMap | CC BY 4.0 / public domain / open data | direct |
 *
 * Routes and airline names are not looked up at all: they ship with the app
 * (`public/routes`, built from the CC0 Virtual Radar Server standing data).
 *
 * ## Why a relay
 *
 * adsb.lol sends no `Access-Control-Allow-Origin`, and MET Norway requires a
 * `User-Agent` that identifies the project — a header browsers forbid scripts
 * from setting. Neither can be called from a page, and no client-side code
 * changes that: CORS is enforced by the browser.
 *
 *  - **Development** — Vite's dev server proxies `/feeds/*`. No extra process.
 *  - **Production**  — `functions/feeds/[[path]].ts`, a Cloudflare Pages
 *    Function. Deploy it beside the static build and the same paths keep
 *    working.
 *
 * Set `VITE_DIRECT_FEEDS=1` to bypass the relay and call upstream directly —
 * useful inside a browser extension or an Electron shell.
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
export type RelayTarget = 'adsb-lol' | 'adsb-fi' | 'metno';

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
