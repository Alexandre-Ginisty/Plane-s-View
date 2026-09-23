/**
 * Selection: choosing what to draw this frame.
 *
 * A depth-first walk of the quadtree that answers one question per node —
 * draw this, or refine into its children? — and leaves behind two lists: the
 * tiles to render, and the quads that would need loading to refine further.
 *
 * Three of the seven no-loading rules are enforced here, and all three are
 * easier to get wrong than they look:
 *
 *  - **Refine only into a complete quad** (rule 3). Refining into a quad with
 *    three of four children built leaves a hole, and a hole is worse than
 *    blur. It also means part-funding a quad buys literally nothing, which is
 *    why the frontier is a list of quads rather than of tiles.
 *  - **Keep the parent drawn underneath until the children are opaque**
 *    (rule 4), so there is no frame in which the globe is see-through.
 *  - **Only an on-screen child can hold its parent back.** An off-screen child
 *    never enters the render set, so its opacity stays at 0 for ever — and an
 *    unconditional test therefore pins the parent into the render set
 *    permanently. That bug had every quad straddling the frustum edge, at
 *    every level, drawing a second full-resolution layer underneath itself
 *    that nothing could ever see.
 */

import type { Frustum, Sphere } from 'three';

import type { Vec3 } from '@/core/math/geo';
import type { FloatingOrigin } from '@/core/frame';
import { tileKey } from '@/core/math/geo';
import type { TileMap } from './eviction';
import { isTileVisible, screenSpaceError } from './metrics';
import type { LoadFrontier, TileStreamer } from './streaming';
import { TileNode } from './tileNode';

export interface SelectionContext {
  nodes: TileMap;
  streamer: TileStreamer;
  frustum: Frustum;
  origin: FloatingOrigin;
  scratchSphere: Sphere;
  frame: number;
  maxZoom: number;
  maxScreenSpaceError: number;
  /** Yardstick for the refinement test: imagery texels, not mesh quads. */
  refineResolution: number;
  /** Filled with the tiles to draw, in visit order. */
  renderSet: TileNode[];
  /** Filled with the quads worth loading, spent by the streamer. */
  frontier: LoadFrontier;
}

/**
 * Depth-first selection.
 *
 * Returns true when this subtree has something to draw, so a caller can fall
 * back to drawing itself.
 */
export function selectTiles(
  node: TileNode,
  camEcef: Vec3,
  sseScale: number,
  ctx: SelectionContext,
): boolean {
  if (!isTileVisible(node, camEcef, ctx.frustum, ctx.origin, ctx.scratchSphere)) return true; // nothing needed here

  node.lastUsedFrame = ctx.frame;
  node.onScreenFrame = ctx.frame;
  // A node we are about to draw is never deferred — it is already needed.
  ctx.streamer.ensureContent(node);

  if (!node.contentReady) {
    // Not loaded yet. The caller (the parent) keeps covering this area.
    return false;
  }

  const error = screenSpaceError(node, camEcef, sseScale, ctx.refineResolution);

  if (node.z < ctx.maxZoom && error > ctx.maxScreenSpaceError) {
    const children = ensureChildren(ctx, node);

    // Rule 3: refine only once every child is built. A partially built quad
    // would leave holes, and holes are worse than blur.
    let pending: TileNode[] | null = null;
    for (const child of children) {
      child.lastUsedFrame = ctx.frame;
      if (!child.contentReady) (pending ??= []).push(child);
    }

    if (pending) {
      // Queued as one quad, not four tiles: `flushLoads` spends the frame's
      // budget once the whole tree is known, and `error` is this node's own
      // — the blur currently on screen where the children should be.
      ctx.frontier.push({ pending, error });
    }

    if (!pending) {
      let allOpaque = true;
      for (const child of children) {
        selectTiles(child, camEcef, sseScale, ctx);
        // Only a child that is on screen can hold the parent back. An
        // off-screen child is never added to the render set, so
        // `applyRenderSet` keeps its opacity at 0 for ever — and the old
        // unconditional test therefore pinned the parent into the render set
        // permanently. Every quad straddling the frustum edge, at every
        // level, was drawing a second full-resolution layer underneath
        // itself that nothing could ever see.
        if (child.onScreenFrame === ctx.frame && child.opacity < 0.999) {
          allOpaque = false;
        }
      }
      // Rule 4: stay drawn underneath until the children are fully opaque.
      if (!allOpaque) ctx.renderSet.push(node);
      return true;
    }
  }

  ctx.renderSet.push(node);
  return true;
}

function ensureChildren(ctx: SelectionContext, node: TileNode): TileNode[] {
  if (node.children) return node.children;

  const children: TileNode[] = [];
  const z = node.z + 1;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const x = node.x * 2 + dx;
      const y = node.y * 2 + dy;
      const key = tileKey(z, x, y);
      let child = ctx.nodes.get(key);
      if (!child) {
        child = new TileNode(z, x, y, node);
        ctx.nodes.set(key, child);
      }
      children.push(child);
    }
  }
  node.children = children;
  return children;
}
