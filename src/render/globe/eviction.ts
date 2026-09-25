/**
 * Eviction.
 *
 * The globe holds more tiles than it draws — every ancestor of a drawn tile is
 * needed for texture inheritance, and tiles just off screen are needed again
 * the moment the camera turns — so "what can be thrown away" is a real
 * question with two non-obvious answers.
 *
 * **Farthest first, not least-recently-used.** Recency and distance disagree
 * in exactly the case that matters: an aircraft orbiting a city keeps
 * re-visiting the same ground, so LRU starts discarding tiles just off the
 * wingtip while keeping ones left behind an hour ago.
 *
 * **Leaves only.** Evicting a node whose children are still resident orphans
 * those children onto a disposed parent — which both degrades their texture
 * inheritance and leaks the parent, in the routine whose entire job is to free
 * memory.
 */

import { tileKey, type Vec3 } from '@/core/math/geo';
import { ROOT_ZOOM } from './constants';
import { distanceTo } from './metrics';
import type { TileNode } from './tileNode';

export type TileMap = Map<string, TileNode>;

export interface EvictionContext {
  nodes: TileMap;
  /** Tiles drawn this frame. They and their ancestors are untouchable. */
  renderSet: readonly TileNode[];
  camEcef: Vec3;
  maxResidentTiles: number;
  /**
   * Release a node's external resources: detach its mesh, withdraw its loader
   * requests, drop it from the streaming frontier.
   *
   * A callback rather than a direct dependency, because those three things
   * live in three different objects and threading all of them through here
   * would make an eviction policy depend on a worker pool.
   */
  onEvict(node: TileNode): void;
}

/**
 * Fraction of the cap the sweep trims down to once it runs.
 *
 * Without headroom the sweep trims to exactly the cap, so the very next tile
 * to arrive puts the tree over again and the whole thing runs afresh — a full
 * sort of several thousand nodes, every frame, for as long as the globe is at
 * its resident limit. Which is to say: permanently, near the ground, where
 * zoom-19 tiles fill the cap in seconds. Taking a tenth off instead means the
 * sweep runs once per few hundred new tiles and is invisible in the frame time.
 */
const EVICT_TARGET_FRACTION = 0.9;

export function evictDistantTiles(ctx: EvictionContext): void {
  if (ctx.nodes.size <= ctx.maxResidentTiles) return;

  // Rule 6: anything drawn this frame, and every ancestor of it (needed for
  // texture inheritance), is untouchable.
  const protectedNodes = new Set<TileNode>();
  for (const node of ctx.renderSet) {
    let n: TileNode | null = node;
    while (n && !protectedNodes.has(n)) {
      protectedNodes.add(n);
      n = n.parent;
    }
  }

  // Distance is measured once per node, not once per comparison.
  //
  // `sort` calls its comparator O(n log n) times, so computing `distanceTo`
  // inside it did two square roots per comparison — around 150 000 of them per
  // sweep at the six-thousand-tile cap, on the main thread, in a routine whose
  // whole purpose is to keep the frame cheap.
  const candidates: { node: TileNode; distance: number }[] = [];
  for (const node of ctx.nodes.values()) {
    if (node.z <= ROOT_ZOOM) continue; // roots are the fallback of last resort
    if (protectedNodes.has(node)) continue;
    if (node.children?.some((c) => protectedNodes.has(c))) continue;
    candidates.push({ node, distance: distanceTo(node, ctx.camEcef) });
  }

  // Farthest first, not least-recently-used.
  //
  // Recency and distance disagree in exactly the case that matters: an
  // aircraft orbiting a city keeps re-visiting the same ground, so LRU
  // starts discarding tiles just off the wingtip while keeping ones left
  // behind an hour ago. Distance is what the viewer can actually perceive,
  // so terrain only ever dissolves far away, where nothing shows it.
  candidates.sort((a, b) => b.distance - a.distance);

  // `max(1, ...)` so a very small cap — which only a test sets, but which the
  // arithmetic still has to survive — cannot round its way down to evicting
  // everything.
  const keep = Math.max(1, Math.round(ctx.maxResidentTiles * EVICT_TARGET_FRACTION));
  const target = ctx.nodes.size - keep;
  let removed = 0;

  for (const { node } of candidates) {
    if (removed >= target) break;
    // Leaves only.
    //
    // Evicting a node whose children are still resident leaves those
    // children in the map pointing at a disposed parent that nothing else
    // references — so `textureAncestor` walks a dead chain and inherits from
    // some distant root instead of the nearest live ancestor (visibly
    // blurrier ground), and the disposed parents are kept alive by those
    // very pointers, which is a leak in the routine whose whole job is to
    // free memory. Children sort before their parents here anyway (a smaller
    // bounding radius puts them marginally farther away), so skipping is
    // nearly free: the parent becomes evictable on the next pass.
    if (hasResidentChildren(ctx.nodes, node)) continue;

    ctx.onEvict(node);
    node.dispose();
    ctx.nodes.delete(node.key);
    // The parent's array now holds a disposed node, so drop it and let
    // `ensureChildren` rebuild from the map, which is the authority.
    if (node.parent?.children) node.parent.children = null;
    removed++;
  }
}

/**
 * True while any of this node's children are still in the tile map.
 *
 * Derived from the node's own coordinates rather than read off
 * `node.children`, because this loop nulls a parent's `children` array the
 * moment it evicts one child. Reading the array would then report "no
 * children" for a parent whose other three are still resident — the guard
 * would disable itself on exactly the nodes it exists to protect, and within
 * a single pass, since children sort before their parents. The map is the
 * authority; ask it.
 */
function hasResidentChildren(nodes: TileMap, node: TileNode): boolean {
  const z = node.z + 1;
  const x = node.x * 2;
  const y = node.y * 2;
  return (
    nodes.has(tileKey(z, x, y)) ||
    nodes.has(tileKey(z, x + 1, y)) ||
    nodes.has(tileKey(z, x, y + 1)) ||
    nodes.has(tileKey(z, x + 1, y + 1))
  );
}
