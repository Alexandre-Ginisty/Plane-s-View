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
 *
 * ## And it is same-origin
 *
 * It used to answer `Access-Control-Allow-Origin: *`, which is the other half
 * of the same problem. The app is served from this origin, so it never needed
 * CORS at all; what the wildcard bought was any other site on the internet
 * being able to point its own client at this deployment and spend its request
 * budget — and, through it, the goodwill of feeds that are donating bandwidth
 * on the understanding that this project is the one using them.
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

/**
 * Content types the relay will pass on.
 *
 * Reflecting whatever the upstream sent means an upstream that is down, or
 * hijacked, can decide what type of document this origin serves. Everything
 * here is fetched as JSON by the client, so anything else is a failure to
 * report rather than a body to forward.
 */
const ALLOWED_CONTENT_TYPES = ['application/json', 'text/json', 'application/geo+json'];

function safeContentType(upstream: string | null): string {
  const base = (upstream ?? '').split(';')[0]!.trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.includes(base)
    ? `${base}; charset=utf-8`
    : 'application/json; charset=utf-8';
}

/**
 * Same-origin only. The app is served from here, so the browser sends no
 * preflight and needs no allow-origin header; echoing the caller's origin back
 * would re-open exactly what the wildcard did.
 */
function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Origin',
    ...extra,
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: baseHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
  });
}

/**
 * Anything that is not a GET.
 *
 * A same-origin relay has no preflight to answer, so an OPTIONS here is either
 * a scanner or a misconfiguration; either way the honest reply is that only GET
 * exists. Cloudflare routes every method to the catch-all, so without this a
 * POST would fall through to the platform's own handling rather than being
 * refused by the code that owns the route.
 */
const methodNotAllowed = (): Response =>
  new Response(null, { status: 405, headers: baseHeaders({ Allow: 'GET' }) });

export const onRequestOptions = methodNotAllowed;
export const onRequestPost = methodNotAllowed;
export const onRequestPut = methodNotAllowed;
export const onRequestPatch = methodNotAllowed;
export const onRequestDelete = methodNotAllowed;

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

    const headers = baseHeaders({
      'Content-Type': safeContentType(upstream.headers.get('Content-Type')),
      'Cache-Control': `public, max-age=${ttl}`,
    });

    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    // No `detail`. The caught value is a network error from an internal fetch
    // and its text names the upstream URL and the shape of the infrastructure
    // behind this route — free reconnaissance, in exchange for a message no
    // user can act on. The client already falls through to the next provider.
    return json({ error: 'Upstream unreachable', target }, 502);
  }
}
