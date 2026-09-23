/**
 * Loader tests.
 *
 * These pin down the three behaviours the globe depends on and that are
 * invisible from the outside until something is subtly wrong for minutes:
 * ordering, reference-counted withdrawal, and the fact that callers sharing a
 * key share one buffer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpError } from '@/data/http';
import { TileLoader } from './loader';
import type { TileDiskCache } from './cache';

/** A disk cache that is always empty and never writes. */
function nullDisk(): TileDiskCache {
  return {
    get: async () => null,
    put: async () => undefined,
  } as unknown as TileDiskCache;
}

/** Resolve after the current microtask queue drains. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Served {
  url: string;
  resolve: (body: ArrayBuffer) => void;
  reject: (err: unknown) => void;
  signal: AbortSignal | undefined;
}

let served: Served[] = [];

beforeEach(() => {
  served = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      served.push({
        url,
        signal: init?.signal ?? undefined,
        resolve: (body) =>
          resolve(new Response(body, { status: 200, headers: { 'content-type': 'image/png' } })),
        reject,
      });
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const body = (n = 8): ArrayBuffer => new Uint8Array(n).fill(1).buffer;

describe('TileLoader ordering', () => {
  /**
   * The whole point of the scheduler. With one slot free, the request queued
   * *last* but ranked most urgent has to be the one that goes out.
   */
  it('serves the most urgent queued request first', async () => {
    const loader = new TileLoader(1, nullDisk());

    void loader.request('blocker', ['https://h/blocker'], 0);
    await settle();
    expect(served).toHaveLength(1);

    void loader.request('dull', ['https://h/dull'], 900);
    void loader.request('urgent', ['https://h/urgent'], 5);
    await settle();
    // Still only the blocker: concurrency is 1.
    expect(served).toHaveLength(1);

    served[0]!.resolve(body());
    await settle();

    expect(served).toHaveLength(2);
    expect(served[1]!.url).toBe('https://h/urgent');
  });

  /**
   * A tile requested again at a better priority must be re-ranked in place,
   * not queued twice. The quadtree re-requests the same keys every frame.
   */
  it('promotes an already-queued key rather than duplicating it', async () => {
    const loader = new TileLoader(1, nullDisk());

    void loader.request('blocker', ['https://h/blocker'], 0);
    await settle();

    void loader.request('a', ['https://h/a'], 900);
    void loader.request('b', ['https://h/b'], 500);
    void loader.request('a', ['https://h/a'], 1); // same key, now urgent
    await settle();

    expect(loader.getStats().queued).toBe(2);

    served[0]!.resolve(body());
    await settle();
    expect(served[1]!.url).toBe('https://h/a');
  });
});

describe('TileLoader withdrawal', () => {
  /**
   * The bug this guards: the globe aborted its own continuation when a tile
   * fell behind the aircraft but never told the loader, so the fetch ran to
   * completion and held one of the concurrency slots the ground ahead needed.
   */
  it('aborts an in-flight request once the last caller withdraws', async () => {
    const loader = new TileLoader(4, nullDisk());

    const p = loader.request('t', ['https://h/t'], 1);
    p.catch(() => undefined);
    await settle();

    expect(served[0]!.signal?.aborted).toBe(false);
    loader.cancel('t');
    expect(served[0]!.signal?.aborted).toBe(true);
  });

  /**
   * Two tiles can legitimately want the same elevation tile — above zoom 15
   * every node reuses its z15 ancestor's heightmap. One of them losing
   * interest must not cancel the other's fetch.
   */
  it('keeps the request alive while another caller still wants it', async () => {
    const loader = new TileLoader(4, nullDisk());

    const a = loader.request('shared', ['https://h/shared'], 1);
    const b = loader.request('shared', ['https://h/shared'], 1);
    await settle();

    expect(served).toHaveLength(1); // one fetch, two callers
    loader.cancel('shared');
    expect(served[0]!.signal?.aborted).toBe(false);

    served[0]!.resolve(body());
    await expect(a).resolves.toMatchObject({ key: 'shared' });
    await expect(b).resolves.toMatchObject({ key: 'shared' });
  });

  it('drops a queued request that no one wants any more', async () => {
    const loader = new TileLoader(1, nullDisk());

    void loader.request('blocker', ['https://h/blocker'], 0);
    await settle();

    const p = loader.request('doomed', ['https://h/doomed'], 5);
    expect(loader.getStats().queued).toBe(1);

    loader.cancel('doomed');
    await expect(p).rejects.toThrow(/no longer needed/i);
    expect(loader.getStats().queued).toBe(0);

    served[0]!.resolve(body());
    await settle();
    // The withdrawn tile was never fetched.
    expect(served.map((s) => s.url)).not.toContain('https://h/doomed');
  });
});

describe('TileLoader delivery', () => {
  /**
   * Callers sharing a key share one ArrayBuffer.
   *
   * This is deliberate — copying for every one of sixteen nodes reading the
   * same z15 heightmap would be waste — but it makes the buffer *unowned*, so
   * no caller may transfer or mutate it. `Globe.loadGeometry` copies before
   * handing it to a worker precisely because of this; the test exists so the
   * sharing is never quietly turned into per-caller copies (which would make
   * that copy look redundant) or the other way round.
   */
  it('hands every caller of a shared key the same buffer', async () => {
    const loader = new TileLoader(4, nullDisk());

    const a = loader.request('shared', ['https://h/shared'], 1);
    const b = loader.request('shared', ['https://h/shared'], 1);
    await settle();
    served[0]!.resolve(body());

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.data).toBe(rb.data);
  });

  /** A 404 over ocean is routine; the next provider in the chain answers. */
  it('falls through the URL chain and reports which source served it', async () => {
    const loader = new TileLoader(4, nullDisk());

    const p = loader.request('t', ['https://a/t', 'https://b/t'], 1);
    await settle();

    served[0]!.reject(new HttpError('not found', 404, 'https://a/t'));
    await settle();

    expect(served).toHaveLength(2);
    expect(served[1]!.url).toBe('https://b/t');
    served[1]!.resolve(body());

    await expect(p).resolves.toMatchObject({ sourceIndex: 1, fromDisk: false });
  });

  /** An empty 200 is a failure dressed as a success; it must not be cached. */
  it('rejects a zero-length body', async () => {
    const puts: string[] = [];
    const disk = {
      get: async () => null,
      put: async (key: string) => {
        puts.push(key);
      },
    } as unknown as TileDiskCache;

    const loader = new TileLoader(4, disk);
    const p = loader.request('t', ['https://a/t'], 1);
    await settle();

    served[0]!.resolve(new ArrayBuffer(0));
    await expect(p).rejects.toThrow(/empty tile body/i);
    expect(puts).toHaveLength(0);
  });

  it('serves from disk without touching the network', async () => {
    const disk = {
      get: async () => body(16),
      put: async () => undefined,
    } as unknown as TileDiskCache;

    const loader = new TileLoader(4, disk);
    await expect(loader.request('t', ['https://a/t'], 1)).resolves.toMatchObject({
      fromDisk: true,
    });
    expect(served).toHaveLength(0);
  });

  /** Finishing a request must free its slot for the next one. */
  it('pumps the next request as slots free up', async () => {
    const loader = new TileLoader(2, nullDisk());

    void loader.request('a', ['https://h/a'], 1);
    void loader.request('b', ['https://h/b'], 2);
    void loader.request('c', ['https://h/c'], 3);
    await settle();

    expect(served).toHaveLength(2);
    expect(loader.getStats().inFlight).toBe(2);

    served[0]!.resolve(body());
    await settle();

    expect(served).toHaveLength(3);
    expect(served[2]!.url).toBe('https://h/c');
  });
});
