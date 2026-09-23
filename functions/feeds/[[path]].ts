/**
 * Feed relay — Cloudflare Pages Function (free tier, no account upgrade, no card).
 *
 * Deployed automatically by Cloudflare Pages: any file under `functions/`
 * becomes a route, and `[[path]]` is a catch-all. With the static build this
 * serves `/feeds/<target>/<upstream path>` on the same origin as the app, so
 * the browser never makes a cross-origin request and CORS stops mattering.
 *
 * It exists for exactly two reasons the browser cannot solve on its own:
 *   1. adsb.lol / adsb.fi / OpenSky send no usable `Access-Control-Allow-Origin`.
 *   2. Planespotters requires a descriptive `User-Agent`, and `User-Agent` is a
 *      forbidden header for `fetch` in a page.
 *
 * ## This is an allowlist, not a proxy
 *
 * The target is matched against a fixed map of origins. An arbitrary URL can
 * never be reached through it, so it cannot be used to probe private networks
 * or to launder traffic — the failure mode that makes naive CORS proxies
 * dangerous to deploy.
 */

import relayTargets from '../../relay-targets.json';

const UPSTREAM: Record<string, string> = relayTargets;

/** Identifies the project to upstream operators, as their terms ask. */
const USER_AGENT = 'PlanesView/0.1 (+https://github.com/planesview/planesview)';

/**
 * Edge-cache windows, seconds. Positions go stale in about a second; airframe
 * photos essentially never change. Caching is what keeps a popular deployment
 * from becoming a burden on services that are donating their bandwidth.
 */
const CACHE_SECONDS: Record<string, number> = {
  'adsb-lol': 1,
  'adsb-fi': 1,
  'airplanes-live': 1,
  opensky: 5,
  planespotters: 86_400,
};

interface PagesContext {
  request: Request;
  params: { path?: string | string[] };
  waitUntil(promise: Promise<unknown>): void;
}

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    ...extra,
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
  });
}

export const onRequestOptions = (): Response =>
  new Response(null, { status: 204, headers: corsHeaders() });

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const raw = context.params.path;
  const segments = Array.isArray(raw) ? raw : raw ? [raw] : [];

  const target = segments[0];
  if (!target || !Object.hasOwn(UPSTREAM, target)) {
    return json(
      { error: 'Unknown relay target', allowed: Object.keys(UPSTREAM) },
      404,
    );
  }

  const origin = UPSTREAM[target]!;
  const upstreamPath = segments.slice(1).map(encodeURIComponent).join('/');
  const incoming = new URL(context.request.url);

  // Rebuilt from parts, never concatenated from user input, so the origin is
  // fixed by the allowlist and the path cannot escape it.
  const url = new URL(`/${upstreamPath}`, origin);
  url.search = incoming.search;

  const ttl = CACHE_SECONDS[target] ?? 5;

  try {
    const upstream = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      // Collapses concurrent identical requests across all visitors.
      cf: { cacheTtl: ttl, cacheEverything: true },
      signal: AbortSignal.timeout(10_000),
    } as RequestInit);

    const headers = corsHeaders({
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
      'X-Relay-Target': target,
    });

    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    return json(
      { error: 'Upstream unreachable', target, detail: String(err) },
      502,
    );
  }
}
