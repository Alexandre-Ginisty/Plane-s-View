import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('vectorTileTemplate', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  const answer = (tiles: unknown, ok = true) =>
    vi.fn(async () => ({ ok, json: async () => ({ tiles }) }) as Response);

  it('reads the dated tile URL from the TileJSON, and asks once', async () => {
    const fetchMock = answer(['https://tiles.openfreemap.org/planet/20260930_001001_pt/{z}/{x}/{y}.pbf']);
    vi.stubGlobal('fetch', fetchMock);
    const { vectorTileTemplate } = await import('./vectorTiles');
    const url = 'https://tiles.openfreemap.org/planet/20260930_001001_pt/{z}/{x}/{y}.pbf';
    expect(await vectorTileTemplate()).toBe(url);
    expect(await vectorTileTemplate()).toBe(url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a tile host that is not the expected one', async () => {
    vi.stubGlobal('fetch', answer(['https://evil.example/{z}/{x}/{y}.pbf']));
    const { vectorTileTemplate } = await import('./vectorTiles');
    expect(await vectorTileTemplate()).toBeNull();
  });

  it('refuses a plain-http URL', async () => {
    vi.stubGlobal('fetch', answer(['http://tiles.openfreemap.org/{z}/{x}/{y}.pbf']));
    const { vectorTileTemplate } = await import('./vectorTiles');
    expect(await vectorTileTemplate()).toBeNull();
  });

  it('gives null on a failed answer and tries again next time', async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tiles: ['https://tiles.openfreemap.org/planet/x/{z}/{x}/{y}.pbf'] }),
      } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { vectorTileTemplate } = await import('./vectorTiles');
    expect(await vectorTileTemplate()).toBeNull();
    expect(await vectorTileTemplate()).toContain('tiles.openfreemap.org');
  });

  it('gives null when the network throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const { vectorTileTemplate } = await import('./vectorTiles');
    expect(await vectorTileTemplate()).toBeNull();
  });
});
