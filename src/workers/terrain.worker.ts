/**
 * Terrain worker: the message loop.
 *
 * Nothing but dispatch. Decoding lives in `terrain/heightmap.ts` and meshing
 * in `terrain/mesh.ts`, both ordinary modules a test can import directly —
 * which is the point of the split, because a worker entry point is the one
 * kind of module a test cannot reach.
 *
 * The reply transfers its buffers rather than copying them. A z16 tile at the
 * near resolution is roughly a megabyte of vertex data, and structured-cloning
 * that on every tile is most of a frame's budget spent on nothing.
 */

import { builtTileTransferables } from './protocol';
import type { BuildTileRequest, WorkerResponse } from './protocol';
import { decodeHeightmap } from './terrain/heightmap';
import { buildTileMesh } from './terrain/mesh';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<BuildTileRequest>) => {
  const req = event.data;
  if (req.type !== 'build') return;

  void (async () => {
    try {
      const map = req.bytes ? await decodeHeightmap(req.bytes) : null;
      const built = buildTileMesh(req, map);
      const response: WorkerResponse = built;
      // The transferable list lives with the message type, not here: the two
      // have to agree exactly, and a buffer added to `BuiltTile` without being
      // added to this list is a silent structured-clone copy of a megabyte of
      // vertices on every tile.
      ctx.postMessage(response, builtTileTransferables(built));
    } catch (err) {
      ctx.postMessage({
        type: 'error',
        id: req.id,
        message: err instanceof Error ? err.message : String(err),
      } satisfies WorkerResponse);
    }
  })();
});
