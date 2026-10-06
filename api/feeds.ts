/**
 * Feed relay — Vercel Function (free Hobby plan).
 *
 * Deployed automatically by Vercel: any file under `api/` becomes a function.
 * `vercel.json` rewrites `/feeds/<target>/<upstream path>` to this one, so it
 * is served on the same origin as the app, the browser never makes a
 * cross-origin request and CORS stops mattering.
 *
 * It exists for exactly two reasons the browser cannot solve on its own:
 *   1. adsb.lol sends no usable `Access-Control-Allow-Origin`.
 *   2. MET Norway requires a descriptive `User-Agent` identifying the project,
 *      and `User-Agent` is a forbidden header for `fetch` in a page.
 *
 * adsb.lol and MET Norway allow commercial use (ODbL; CC BY 4.0 / NLOD), and
 * the Aviation Weather Center's METARs are US government work (public domain);
 * it sends no `Access-Control-Allow-Origin` either.
 * adsb.fi is here as a second traffic feed because adsb.lol rate-limits hard,
 * and its terms are personal / non-commercial: fine for a demonstration, the
 * first thing to drop before the site earns money.
 *
 * ## This is an allowlist, not a proxy
 *
 * The target is matched against a fixed map of origins. An arbitrary URL can
 * never be reached through it, so it cannot be used to probe private networks
 * or to launder traffic — the failure mode that makes naive CORS proxies
 * dangerous to deploy.
 *
 * ## And only for the requests the app makes
 *
 * Each target also has the exact shape of the paths the client sends
 * (`ROUTES`), and the query parameters it may carry. A matching origin is not
 * enough: an allowlisted host still has endpoints this project has no business
 * calling on a stranger's behalf, and every request it relays spends the
 * goodwill of a service donating its bandwidth. Upstream redirects are not
 * followed, so an origin cannot hand the relay on to one that is not listed.
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

/**
 * Upstream origins. The same list as `relay-targets.json`, which the app and
 * the Vite dev proxy read; a test fails if the two drift apart. It is written
 * out here rather than imported because a function is bundled on its own and a
 * JSON import is not portable across the runtimes it may be built for.
 */
const UPSTREAM: Record<string, string> = {
  'adsb-lol': 'https://api.adsb.lol',
  'adsb-fi': 'https://opendata.adsb.fi',
  metno: 'https://api.met.no',
  awc: 'https://aviationweather.gov',
  'adsb-lol-traces': 'https://adsb.lol',
};

/** Identifies the project to upstream operators, as their terms ask. */
const USER_AGENT = 'PlanesView/1.0 (+https://github.com/Alexandre-Ginisty/Plane-s-View)';

/**
 * Edge-cache windows, seconds. Positions go stale in about a second; a surface
 * forecast changes over minutes. Caching is what keeps a popular deployment
 * from becoming a burden on services that are donating their bandwidth.
 */
const CACHE_SECONDS: Record<string, number> = {
  // Two seconds, not one: the client polls every two to three, so a one
  // second entry had usually expired before the next visitor asked. The
  // reply carries the feed's own clock, and the client dead-reckons from it,
  // so an answer a second older is drawn exactly where it should be.
  'adsb-lol': 2,
  'adsb-fi': 2,
  // MET Norway asks that a forecast not be re-requested before its `Expires`,
  // which is usually the better part of an hour; ten minutes is well inside it.
  metno: 600,
  // A METAR is issued every half hour; five minutes keeps a new one prompt.
  awc: 300,
  // A flight's track so far: rewritten upstream every minute or so.
  'adsb-lol-traces': 30,
};

/**
 * The paths each target answers, after the target segment, and the query
 * parameters allowed with them. Hex identifiers are ICAO 24-bit addresses,
 * with readsb's `~` prefix for the non-ICAO ones; coordinates are decimal.
 */
const NUM = String.raw`-?\d{1,3}(?:\.\d{1,6})?`;
const HEX = '~?[0-9a-f]{6}';
const READSB = new RegExp(`^v2/(?:point/${NUM}/${NUM}/\\d{1,3}|hex/${HEX}|type/[0-9a-z]{2,4})$`, 'i');
const ROUTES: Record<string, { path: RegExp; query: readonly string[]; values?: Record<string, RegExp> }> = {
  'adsb-lol': { path: READSB, query: [] },
  'adsb-fi': { path: new RegExp(`^api/v2/(?:lat/${NUM}/lon/${NUM}/dist/\\d{1,3}|hex/${HEX})/?$`, 'i'), query: [] },
  // `complete` rather than `compact`: only it carries the cloud layers and
  // the dew point. Coordinates are the client's business (MET Norway asks for
  // at most four decimals); the relay only fixes which endpoint is reachable.
  metno: { path: /^weatherapi\/locationforecast\/2\.0\/complete$/, query: ['lat', 'lon'] },
  // Up to four ICAO aerodromes, as JSON: the departure and arrival of the
  // aircraft being looked at. The values are checked too — this is someone
  // else's service and the relay asks only what the app asks.
  // The day's track of one aircraft, and its last minutes: readsb's own files.
  'adsb-lol-traces': { path: new RegExp(`^data/traces/[0-9a-f]{2}/trace_(?:full|recent)_${HEX}\\.json$`), query: [] },
  awc: {
    path: /^api\/data\/metar$/,
    query: ['ids', 'format'],
    values: { ids: /^[A-Z0-9]{4}(?:,[A-Z0-9]{4}){0,3}$/, format: /^json$/ },
  },
};

/** Longest URL the client ever builds, with room to spare. */
const MAX_URL_LENGTH = 512;

/** Largest body relayed: a dense 250 nm circle is a few megabytes. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

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
    // Data, never a document: nothing in a reply may run, frame or load.
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
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
 * exists, said by the code that owns the route.
 */
const methodNotAllowed = (): Response =>
  new Response(null, { status: 405, headers: baseHeaders({ Allow: 'GET' }) });

export const OPTIONS = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

/**
 * The path after `/feeds/`, split into segments.
 *
 * `vercel.json` rewrites `/feeds/:path*` to `/api/feeds?path=:path*`, so the
 * path normally arrives as the `path` query parameter. A request that reaches
 * the function under its public `/feeds/...` path is read from the path
 * instead, so either way of being called works. Vercel adds the `path`
 * parameter to the request even when the public path is kept, so it is dropped
 * in both cases: it belongs to the rewrite, never to the upstream, and no
 * route takes a parameter of that name.
 */
function relaySegments(incoming: URL): { segments: string[]; params: URLSearchParams } {
  const params = new URLSearchParams(incoming.search);
  const fromPath = /^\/feeds\/(.*)$/.exec(incoming.pathname);
  const joined = fromPath ? fromPath[1]! : (params.get('path') ?? '');
  params.delete('path');
  return { segments: joined.split('/').filter(Boolean), params };
}

export async function GET(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const { segments, params } = relaySegments(incoming);

  const target = segments[0];
  if (!target || !Object.hasOwn(UPSTREAM, target)) {
    return json(
      { error: 'Unknown relay target', allowed: Object.keys(UPSTREAM) },
      404,
    );
  }

  // Another website's page calling this deployment from its visitors'
  // browsers. Browsers say so; scripts elsewhere can lie, but then they spend
  // their own requests, not borrowed visitors'.
  const site = request.headers.get('Sec-Fetch-Site');
  if (site === 'cross-site') return json({ error: 'Forbidden' }, 403);

  const route = ROUTES[target];
  const rest = segments.slice(1).join('/');
  if (!route || !route.path.test(rest) || incoming.href.length > MAX_URL_LENGTH) {
    return json({ error: 'Unknown relay path' }, 404);
  }
  for (const [key, value] of params) {
    if (!route.query.includes(key)) return json({ error: 'Unknown relay path' }, 404);
    if (route.values?.[key] && !route.values[key]!.test(value)) return json({ error: 'Unknown relay path' }, 404);
  }

  const origin = UPSTREAM[target]!;
  const upstreamPath = segments.slice(1).map(encodeURIComponent).join('/');

  // Rebuilt from parts, never concatenated from user input, so the origin is
  // fixed by the allowlist and the path cannot escape it.
  const url = new URL(`/${upstreamPath}`, origin);
  url.search = params.toString() ? `?${params.toString()}` : '';

  const ttl = CACHE_SECONDS[target] ?? 5;

  try {
    const upstream = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      // A redirect would be the upstream choosing where the relay goes next.
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      return json({ error: 'Upstream redirected', target }, 502);
    }
    const length = Number(upstream.headers.get('Content-Length') ?? 0);
    if (length > MAX_BODY_BYTES) return json({ error: 'Upstream reply too large', target }, 502);

    const headers = baseHeaders({
      'Content-Type': safeContentType(upstream.headers.get('Content-Type')),
      // `s-maxage` is the CDN's: concurrent identical requests from every
      // visitor collapse into one upstream call.
      // Only a success is cached: a 429 or 503 stored for ten minutes would
      // keep an outage alive long after the upstream recovered.
      //
      // `stale-while-revalidate` lets the CDN answer from the entry it has
      // while one request refreshes it, so a crowd arriving as an entry
      // expires costs the upstream one request, not one each. The browser
      // keeps it a second at most: its own next poll must reach the CDN.
      'Cache-Control': upstream.ok
        ? `public, max-age=${Math.min(ttl, 1)}, s-maxage=${ttl}, stale-while-revalidate=${ttl}`
        : 'no-store',
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
