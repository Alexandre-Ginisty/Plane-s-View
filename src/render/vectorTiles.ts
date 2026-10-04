/**
 * Where the OpenStreetMap vector tiles are served from today.
 *
 * The planet's TileJSON names a dated directory that changes with each weekly
 * build, so the URL is read from it rather than written down. One answer is
 * shared by everything that draws from the tiles (the night map, the ground
 * detail), and a failed lookup is retried on the next ask, never in a loop.
 */

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const TILE_HOST = 'tiles.openfreemap.org';

let known: string | null = null;
let pending: Promise<string | null> | null = null;

/** The tile URL with `{z}`, `{x}`, `{y}`, or null while it cannot be had. */
export function vectorTileTemplate(): Promise<string | null> {
  if (known) return Promise.resolve(known);
  pending ??= (async () => {
    try {
      const res = await fetch(TILEJSON, { credentials: 'omit' });
      if (!res.ok) return null;
      const json = (await res.json()) as { tiles?: string[] };
      const url = json.tiles?.[0];
      if (!url) return null;
      const parsed = new URL(url.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'));
      if (parsed.protocol !== 'https:' || parsed.hostname !== TILE_HOST) return null;
      known = url;
      return url;
    } catch {
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}
