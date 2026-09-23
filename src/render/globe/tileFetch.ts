/**
 * Fetching one tile's two resources.
 *
 * Split from the state machine that calls them because they are where the
 * ownership rules bite, and those rules are subtle enough to deserve being
 * read on their own:
 *
 *  - **The loader's bytes are shared and must never be transferred.** Above
 *    zoom 15 Terrarium has no tiles, so up to sixteen nodes are handed the
 *    *same* `ArrayBuffer` for one z15 heightmap. The worker pool transfers
 *    what it is given, so the first node through detaches the buffer and every
 *    other one throws `DataCloneError`. `loadGeometry` copies; `loadTexture`
 *    relies on `new Blob([...])` copying. Neither may stop.
 *  - **Every exit settles.** Aborted, failed, superseded or successful, the
 *    node's state must end up somewhere `ensureContent` can act on again.
 *  - **A stale continuation writes nothing.** Each load captures the
 *    generation it began in and checks it after every `await`.
 *
 * Both take a `LoadContext` rather than living on the streamer so that the
 * rules above are visible in one screen, next to the comments that explain
 * them, instead of buried mid-class.
 */

import { BufferAttribute, BufferGeometry, Sphere, Texture, Vector3 } from 'three';

import { wrapTileX } from '@/core/math/geo';
import type { TileLoader } from '@/tiles/loader';
import { IMAGERY_FALLBACK_ORDER, TERRARIUM, type ImagerySource } from '@/tiles/sources';
import type { TerrainWorkerPool } from '@/workers/pool';
import { MIN_SKIRT_M } from './constants';
import { elevationRequest, priorityOf } from './metrics';
import type { TileNode } from './tileNode';

/** Mesh-building settings the loaders need from the globe's options. */
export interface StreamerOptions {
  baseResolution: number;
  nearResolution: number;
  exaggeration: number;
}

/** How a load outcome is recorded. Implemented by `TileStreamer.finish`. */
export type FinishFn = (
  node: TileNode,
  kind: 'geometry' | 'texture',
  gen: number,
  outcome: 'ready' | 'aborted' | 'failed' | 'exhausted',
) => void;

export interface LoadContext {
  loader: TileLoader;
  workers: TerrainWorkerPool;
  imagery: ImagerySource;
  options: StreamerOptions;
  maxAnisotropy: number;
  /** Current globe frame, for request priority. */
  frame: number;
  finish: FinishFn;
}

export async function loadGeometry(node: TileNode, ctx: LoadContext): Promise<void> {
  const gen = ++node.geometryGen;
  node.geometryState = 'loading';
  node.abort ??= new AbortController();
  const signal = node.abort.signal;

  const req = elevationRequest(node);
  const key = `terrarium/${req.z}/${req.x}/${req.y}`;
  const wrappedX = wrapTileX(req.x, req.z);

  let bytes: ArrayBuffer | null = null;
  let cancelled = false;
  node.geometryRequestKey = key;
  try {
    const result = await ctx.loader.request(
      key,
      [TERRARIUM.url(req.z, wrappedX, req.y)],
      priorityOf(node, ctx.frame),
    );
    // Copied, not used directly.
    //
    // The loader hands every caller of a shared key the *same* ArrayBuffer,
    // and the worker pool transfers the buffer it is given. Above zoom 15
    // Terrarium has no tiles, so up to sixteen nodes share one z15
    // heightmap — the first to reach the worker detached it and every other
    // one threw `DataCloneError`, marked itself failed and was never asked
    // for again. That is a whole quad of permanently unrefinable ground at
    // exactly the zoom the cockpit view spends its time in.
    bytes = result.data.slice(0);
  } catch (err) {
    // A cancelled request is not an answer about the terrain.
    //
    // `cancelAllQueued` rejects every queued entry, and it is called for
    // reasons that have nothing to do with elevation — switching the imagery
    // layer flushes the whole queue, heightmap requests included. Swallowing
    // that as "no elevation here" builds a flat patch and marks the node
    // ready, so the tile stays flat until it is evicted. Rethrow to the
    // abort check below, which retries properly.
    if (err instanceof DOMException && err.name === 'AbortError') cancelled = true;
    // No elevation here — ocean, a gap in coverage, or the service is down.
    // A smooth ellipsoid patch is the correct answer, not a failure: the
    // tile still gets geometry and imagery, it is simply flat.
    bytes = null;
  } finally {
    // Only if it is still ours: an abandoned load resuming here must not
    // clear the key a replacement load has since registered, or that one
    // becomes impossible to withdraw.
    if (node.geometryRequestKey === key) node.geometryRequestKey = null;
  }

  if (signal.aborted || cancelled) {
    ctx.finish(node, 'geometry', gen, 'aborted');
    return;
  }
  if (node.geometryGen !== gen) return;

  // Near tiles get a denser grid; distant ones do not need it and the
  // vertex count is what bounds the whole system.
  const resolution =
    node.z >= 10 ? ctx.options.nearResolution : ctx.options.baseResolution;

  try {
    const built = await ctx.workers.build(
      {
        tile: { z: node.z, x: node.x, y: node.y },
        bytes,
        resolution,
        sampleRect: req.rect,
        exaggeration: ctx.options.exaggeration,
        skirtDepth: MIN_SKIRT_M,
      },
      signal,
    );

    if (signal.aborted) {
      ctx.finish(node, 'geometry', gen, 'aborted');
      return;
    }
    if (node.geometryGen !== gen) return;

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(built.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(built.normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(built.uvs, 2));
    geometry.setIndex(new BufferAttribute(built.indices, 1));
    geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), built.boundingRadius);

    node.geometry = geometry;
    node.heights = built.heights;
    node.gridWidth = built.gridWidth;
    ctx.finish(node, 'geometry', gen, 'ready');
  } catch {
    // Retryable: the usual cause is a worker that died under load, and the
    // attempt cap stops a genuinely undecodable tile from looping.
    ctx.finish(node, 'geometry', gen, signal.aborted ? 'aborted' : 'failed');
  }
}

export async function loadTexture(node: TileNode, ctx: LoadContext): Promise<void> {
  const gen = ++node.textureGen;
  node.textureState = 'loading';
  node.abort ??= new AbortController();
  const signal = node.abort.signal;

  const wrappedX = wrapTileX(node.x, node.z);
  const source = ctx.imagery;

  // Fallback chain: the active layer first, then the others that cover this
  // zoom. A 404 over open ocean at deep zoom is routine.
  const urls = [source, ...IMAGERY_FALLBACK_ORDER.filter((s) => s.id !== source.id)]
    .filter((s) => node.z >= s.minZoom && node.z <= s.maxZoom)
    .map((s) => s.url(node.z, wrappedX, node.y));

  if (urls.length === 0) {
    // Past this layer's max zoom: inherit from the ancestor permanently.
    // Terminal, not a failure — retrying it would burn the retry budget on
    // a request that cannot exist.
    ctx.finish(node, 'texture', gen, 'exhausted');
    return;
  }

  const key = `${source.id}/${node.z}/${wrappedX}/${node.y}`;
  node.textureRequestKey = key;
  let bitmap: ImageBitmap | null = null;

  try {
    const result = await ctx.loader.request(key, urls, priorityOf(node, ctx.frame));
    if (node.textureRequestKey === key) node.textureRequestKey = null;

    if (signal.aborted || node.textureGen !== gen) {
      if (signal.aborted) ctx.finish(node, 'texture', gen, 'aborted');
      return;
    }

    // `new Blob([...])` copies, so the shared buffer is safe here — but it
    // must stay that way: never transfer `result.data`.
    bitmap = await createImageBitmap(new Blob([result.data]), {
      imageOrientation: 'flipY',
      premultiplyAlpha: 'none',
    });

    if (signal.aborted || node.textureGen !== gen) {
      bitmap.close();
      if (signal.aborted) ctx.finish(node, 'texture', gen, 'aborted');
      return;
    }

    const texture = new Texture(bitmap as unknown as HTMLImageElement);
    texture.needsUpdate = true;
    texture.anisotropy = ctx.maxAnisotropy;
    texture.generateMipmaps = true;
    // Tiles butt against their neighbours; wrapping would bleed the opposite
    // edge into the seam.
    texture.wrapS = texture.wrapT = 1001; // ClampToEdgeWrapping
    texture.colorSpace = 'srgb';

    node.texture = texture;
    node.textureBlend = 0; // start the cross-fade from the inherited image
    ctx.finish(node, 'texture', gen, 'ready');
  } catch {
    if (node.textureRequestKey === key) node.textureRequestKey = null;
    ctx.finish(node, 'texture', gen, signal.aborted ? 'aborted' : 'failed');
  }
}
