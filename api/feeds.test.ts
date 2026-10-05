/**
 * The relay, which is the only code in this project a stranger can reach.
 *
 * Everything else runs in the visitor's own browser and can only hurt the
 * visitor. This runs on the project's infrastructure, answers anyone who sends
 * it a request, and makes outbound requests on their behalf — which is the
 * exact shape of an open proxy, and the reason the allowlist has to be proved
 * rather than asserted in a comment.
 *
 * The properties pinned here are the ones whose absence would be a real
 * vulnerability: that no input can steer the request off the fixed origins,
 * that a path cannot climb out of the one it was given, and that failures do
 * not narrate the infrastructure back to the caller.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import relayTargets from '../relay-targets.json';
import { GET, OPTIONS, POST } from './feeds';

interface Captured {
  url: string;
  init: RequestInit;
}

let captured: Captured[] = [];

/** A request as the public URL carries it: `/feeds/<target>/<upstream path>`. */
function contextFor(path: string[], search = '', headers: Record<string, string> = {}): Request {
  return new Request(`https://planesview.example/feeds/${path.join('/')}${search}`, { headers });
}

beforeEach(() => {
  captured = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    captured.push({ url: String(url), init });
    return Promise.resolve(
      new Response('{"ac":[]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the allowlist', () => {
  it('lists the same origins as relay-targets.json', () => {
    // The app and the dev proxy read the JSON; the function carries its own copy.
    return GET(contextFor(['nope'])).then(async (res) => {
      const body = (await res.json()) as { allowed: string[] };
      expect([...body.allowed].sort()).toEqual(Object.keys(relayTargets).sort());
    });
  });

  it('sends each target to the origin listed in relay-targets.json', async () => {
    for (const [target, origin] of Object.entries(relayTargets)) {
      captured = [];
      const path = target === 'metno' ? ['weatherapi', 'locationforecast', '2.0', 'complete'] : target === 'adsb-fi' ? ['api', 'v2', 'hex', '4ca7b5'] : ['v2', 'hex', '4ca7b5'];
      await GET(contextFor([target, ...path]));
      expect(captured[0]!.url.startsWith(`${origin}/`), target).toBe(true);
    }
  });

  it('ignores the `path` parameter the rewrite adds when the public path is kept', async () => {
    // What Vercel actually sends: the original /feeds/... path *and* ?path=...
    const res = await GET(
      new Request('https://planesview.example/feeds/adsb-lol/v2/hex/4ca7b5?path=adsb-lol%2Fv2%2Fhex%2F4ca7b5'),
    );
    expect(res.status).toBe(200);
    expect(captured[0]!.url).toBe('https://api.adsb.lol/v2/hex/4ca7b5');
  });

  it('relays the trailing slash the adsb.fi client sends', async () => {
    const res = await GET(contextFor(['adsb-fi', 'api', 'v2', 'lat', '51.47', 'lon', '-0.454', 'dist', '70', '']));
    expect(res.status).toBe(200);
  });

  it('reads the path vercel.json passes in the `path` parameter', async () => {
    const res = await GET(
      new Request('https://planesview.example/api/feeds?path=adsb-fi%2Fapi%2Fv2%2Flat%2F51.47%2Flon%2F-0.454%2Fdist%2F70%2F'),
    );
    expect(res.status).toBe(200);
    expect(captured[0]!.url).toBe('https://opendata.adsb.fi/api/v2/lat/51.47/lon/-0.454/dist/70');
    expect(captured[0]!.url).not.toContain('path=');
  });

  it('refuses a target that is not in the map', async () => {
    const res = await GET(contextFor(['not-a-feed', 'v2', 'all']));
    expect(res.status).toBe(404);
    expect(captured).toHaveLength(0);
  });

  it('refuses a request with no target at all', async () => {
    const res = await GET(contextFor([]));
    expect(res.status).toBe(404);
    expect(captured).toHaveLength(0);
  });

  it('cannot be pointed at an arbitrary origin', async () => {
    // The failure that makes a naive CORS proxy dangerous: the caller names
    // the destination. Every one of these must be read as a *target name*,
    // fail to match, and reach nothing.
    for (const hostile of [
      'https://evil.example',
      '//evil.example',
      'http://169.254.169.254',
      'localhost:8080',
    ]) {
      const res = await GET(contextFor([hostile, 'x']));
      expect(res.status).toBe(404);
    }
    expect(captured).toHaveLength(0);
  });

  it('sends every allowed target to its own fixed origin', async () => {
    const expected: Record<string, [string, string[]]> = {
      'adsb-lol': ['https://api.adsb.lol/', ['v2', 'hex', '4ca7b5']],
      'adsb-fi': ['https://opendata.adsb.fi/', ['api', 'v2', 'hex', '4ca7b5']],
      metno: ['https://api.met.no/', ['weatherapi', 'locationforecast', '2.0', 'complete']],
    };
    for (const [target, [origin, path]] of Object.entries(expected)) {
      captured = [];
      await GET(contextFor([target, ...path]));
      expect(captured[0]!.url.startsWith(origin)).toBe(true);
    }
  });
});

describe('path handling', () => {
  it('relays the paths the app sends', async () => {
    for (const path of [
      ['adsb-lol', 'v2', 'point', '48.85341', '2.34880', '120'],
      ['adsb-lol', 'v2', 'hex', '~a1b2c3'],
      ['adsb-lol', 'v2', 'type', 'A388'],
      ['adsb-fi', 'api', 'v2', 'lat', '48.85341', 'lon', '2.34880', 'dist', '120'],
      ['adsb-fi', 'api', 'v2', 'hex', '4ca7b5'],
    ]) {
      const res = await GET(contextFor(path));
      expect(res.status, path.join('/')).toBe(200);
    }
    await GET(contextFor(['metno', 'weatherapi', 'locationforecast', '2.0', 'complete'], '?lat=48.8534&lon=2.3488'));
    expect(new URL(captured.at(-1)!.url).search).toBe('?lat=48.8534&lon=2.3488');
  });

  it('refuses any other path on an allowed origin', async () => {
    for (const path of [
      ['adsb-lol', 'v2', 'all'],
      ['adsb-lol', 'v2', 'type', 'a380-800'],
      ['adsb-lol', 'v2', 'type', 'A388', 'extra'],
      ['adsb-fi', 'api', 'v2', 'type', 'A388'],
      ['adsb-lol', '..', '..', 'admin'],
      ['adsb-lol', 'https://evil.example/x'],
      ['adsb-lol', 'v2', 'hex', '4ca7b5', 'extra'],
      ['metno', 'weatherapi', 'locationforecast', '2.0', 'compact'],
      ['metno', 'weatherapi', 'nowcast', '2.0', 'complete'],
      // OpenSky was removed: metered, and its terms forbid commercial use.
      ['opensky', 'api', 'states', 'all'],
      ['adsb-fi', 'v2', 'hex', '4ca7b5'],
      ['adsb-fi', 'api', 'v2', 'all'],
    ]) {
      const res = await GET(contextFor(path));
      expect(res.status, path.join('/')).toBe(404);
    }
    expect(captured).toHaveLength(0);
  });

  it('refuses query parameters the route does not take', async () => {
    const lol = await GET(contextFor(['adsb-lol', 'v2', 'hex', '4ca7b5'], '?limit=200'));
    expect(lol.status).toBe(404);
    const met = await GET(
      contextFor(['metno', 'weatherapi', 'locationforecast', '2.0', 'complete'], '?lat=1&lon=2&altitude=9000'),
    );
    expect(met.status).toBe(404);
    expect(captured).toHaveLength(0);
  });

  it('refuses another website calling it from its visitors\' browsers', async () => {
    const res = await GET(contextFor(['adsb-lol', 'v2', 'hex', '4ca7b5'], '', { 'Sec-Fetch-Site': 'cross-site' }));
    expect(res.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it('does not follow an upstream redirect', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('manual');
      return Promise.resolve(new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }));
    });
    const res = await GET(contextFor(['adsb-lol', 'v2', 'hex', '4ca7b5']));
    expect(res.status).toBe(502);
    expect(res.headers.get('Location')).toBeNull();
  });
});

describe('what comes back', () => {
  it('identifies the project upstream, as the feeds ask', async () => {
    await GET(contextFor(['adsb-lol', 'v2', 'hex', '4ca7b5']));
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('PlanesView');
  });

  it('is not readable by another website', async () => {
    // It used to answer `Access-Control-Allow-Origin: *`, which let any site
    // on the internet spend this deployment's request budget.
    const res = await GET(contextFor(['adsb-lol', 'v2', 'hex', '4ca7b5']));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('never lets an upstream choose what type this origin serves', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response('<script>alert(1)</script>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
    );
    const res = await GET(contextFor(['adsb-lol', 'v2', 'hex', '4ca7b5']));
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('reports an unreachable upstream without describing it', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.reject(new Error('connect ECONNREFUSED 10.0.3.4:443 via relay-edge-7')),
    );
    const res = await GET(contextFor(['adsb-lol', 'v2', 'hex', '4ca7b5']));
    expect(res.status).toBe(502);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('Upstream unreachable');
    expect(JSON.stringify(body)).not.toContain('10.0.3.4');
    expect(JSON.stringify(body)).not.toContain('relay-edge');
  });

  it('answers only GET', async () => {
    expect(OPTIONS().status).toBe(405);
    expect(POST().status).toBe(405);
  });
});
