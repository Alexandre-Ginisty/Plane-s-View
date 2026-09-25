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

import { onRequestGet, onRequestOptions, onRequestPost } from './[[path]]';

interface Captured {
  url: string;
  init: RequestInit;
}

let captured: Captured[] = [];

/** A context shaped like the one Cloudflare Pages hands the function. */
function contextFor(path: string[], search = ''): Parameters<typeof onRequestGet>[0] {
  return {
    request: new Request(`https://planesview.example/feeds/${path.join('/')}${search}`),
    params: { path },
    waitUntil: () => undefined,
  };
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
  it('refuses a target that is not in the map', async () => {
    const res = await onRequestGet(contextFor(['not-a-feed', 'v2', 'all']));
    expect(res.status).toBe(404);
    expect(captured).toHaveLength(0);
  });

  it('refuses a request with no target at all', async () => {
    const res = await onRequestGet(contextFor([]));
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
      const res = await onRequestGet(contextFor([hostile, 'x']));
      expect(res.status).toBe(404);
    }
    expect(captured).toHaveLength(0);
  });

  it('sends every allowed target to its own fixed origin', async () => {
    const expected: Record<string, string> = {
      'adsb-lol': 'https://api.adsb.lol/',
      'adsb-fi': 'https://opendata.adsb.fi/',
      'airplanes-live': 'https://api.airplanes.live/',
      opensky: 'https://opensky-network.org/',
      planespotters: 'https://api.planespotters.net/',
    };
    for (const [target, origin] of Object.entries(expected)) {
      captured = [];
      await onRequestGet(contextFor([target, 'v2', 'all']));
      expect(captured[0]!.url.startsWith(origin)).toBe(true);
    }
  });
});

describe('path handling', () => {
  it('cannot climb out of the upstream origin with traversal', async () => {
    await onRequestGet(contextFor(['adsb-lol', '..', '..', 'admin']));
    const url = new URL(captured[0]!.url);
    expect(url.origin).toBe('https://api.adsb.lol');
    // Encoded, so it is a path segment named ".." rather than a move upwards.
    expect(url.pathname).not.toContain('/../');
  });

  it('cannot smuggle a second host through the path', async () => {
    await onRequestGet(contextFor(['adsb-lol', 'https://evil.example/x']));
    expect(new URL(captured[0]!.url).origin).toBe('https://api.adsb.lol');
  });

  it('passes the query string through, since the feeds need it', async () => {
    await onRequestGet(contextFor(['adsb-lol', 'v2', 'lat', '51.5'], '?limit=200'));
    expect(new URL(captured[0]!.url).search).toBe('?limit=200');
  });
});

describe('what comes back', () => {
  it('identifies the project upstream, as the feeds ask', async () => {
    await onRequestGet(contextFor(['adsb-lol', 'v2', 'all']));
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('PlanesView');
  });

  it('is not readable by another website', async () => {
    // It used to answer `Access-Control-Allow-Origin: *`, which let any site
    // on the internet spend this deployment's request budget.
    const res = await onRequestGet(contextFor(['adsb-lol', 'v2', 'all']));
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
    const res = await onRequestGet(contextFor(['adsb-lol', 'v2', 'all']));
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('reports an unreachable upstream without describing it', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.reject(new Error('connect ECONNREFUSED 10.0.3.4:443 via relay-edge-7')),
    );
    const res = await onRequestGet(contextFor(['adsb-lol', 'v2', 'all']));
    expect(res.status).toBe(502);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('Upstream unreachable');
    expect(JSON.stringify(body)).not.toContain('10.0.3.4');
    expect(JSON.stringify(body)).not.toContain('relay-edge');
  });

  it('answers only GET', async () => {
    expect(onRequestOptions().status).toBe(405);
    expect(onRequestPost().status).toBe(405);
  });
});
