/**
 * Eviction is the routine whose job is to free memory, so a bug in it leaks —
 * which is the failure that takes an hour of flying to notice and is almost
 * impossible to attribute afterwards. Both of the rules here were bugs first.
 */

import { describe, expect, it } from 'vitest';

import { geodeticToEcef, type Vec3 } from '@/core/math/geo';
import { evictDistantTiles, type TileMap } from './eviction';
import { TileNode } from './tileNode';

/** A tile map holding `nodes`, keyed the way `Globe` keys it. */
function mapOf(...nodes: TileNode[]): TileMap {
  const map: TileMap = new Map();
  for (const node of nodes) map.set(node.key, node);
  return map;
}

/** A node plus its four children, all resident. */
function family(z: number, x: number, y: number): { parent: TileNode; children: TileNode[] } {
  const parent = new TileNode(z, x, y, null);
  const children: TileNode[] = [];
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      children.push(new TileNode(z + 1, x * 2 + dx, y * 2 + dy, parent));
    }
  }
  parent.children = children;
  return { parent, children };
}

const CAM: Vec3 = geodeticToEcef(51.5, -0.45, 10_000);

describe('evictDistantTiles', () => {
  it('does nothing while under the limit', () => {
    const nodes = mapOf(new TileNode(6, 1, 1, null), new TileNode(6, 2, 1, null));
    const evicted: string[] = [];
    evictDistantTiles({
      nodes,
      renderSet: [],
      camEcef: CAM,
      maxResidentTiles: 10,
      onEvict: (n) => evicted.push(n.key),
    });
    expect(evicted).toEqual([]);
    expect(nodes.size).toBe(2);
  });

  it('never evicts a tile being drawn, or any of its ancestors', () => {
    // Ancestors matter as much as the tile itself: a drawn tile inherits its
    // texture from the nearest loaded ancestor, so evicting one silently
    // blurs the ground under the aircraft.
    const { parent, children } = family(9, 255, 170);
    const drawn = children[0]!;
    const nodes = mapOf(parent, ...children);

    const evicted: string[] = [];
    evictDistantTiles({
      nodes,
      renderSet: [drawn],
      camEcef: CAM,
      maxResidentTiles: 1,
      onEvict: (n) => evicted.push(n.key),
    });

    expect(evicted).not.toContain(drawn.key);
    expect(evicted).not.toContain(parent.key);
    expect(nodes.has(drawn.key)).toBe(true);
    expect(nodes.has(parent.key)).toBe(true);
  });

  it('never evicts a root', () => {
    // The roots are the fallback of last resort: with one gone there is a
    // sixteenth of the planet that can show nothing at all.
    const root = new TileNode(2, 1, 1, null);
    const nodes = mapOf(root);
    evictDistantTiles({
      nodes,
      renderSet: [],
      camEcef: CAM,
      maxResidentTiles: 0,
      onEvict: () => undefined,
    });
    expect(nodes.has(root.key)).toBe(true);
  });

  it('evicts leaves before their parents, never orphaning a child', () => {
    // Evicting a parent whose children are still resident leaves those
    // children pointing at a disposed node that nothing else references: they
    // then inherit their texture from some distant root instead of their real
    // ancestor (visibly blurrier), and the disposed parents are kept alive by
    // those very pointers — a leak, in the routine that exists to free memory.
    const { parent, children } = family(9, 255, 170);
    const nodes = mapOf(parent, ...children);

    evictDistantTiles({
      nodes,
      renderSet: [],
      camEcef: CAM,
      maxResidentTiles: 0,
      onEvict: () => undefined,
    });

    // Whatever survived, no surviving node may have a dead parent.
    for (const node of nodes.values()) {
      if (node.parent) expect(nodes.has(node.parent.key)).toBe(true);
    }
  });

  it('clears the parent link of an evicted child so the tree is rebuilt', () => {
    // The parent's array would otherwise hold a disposed node, which `visit`
    // would happily try to draw.
    const { parent, children } = family(9, 255, 170);
    const nodes = mapOf(parent, ...children);

    evictDistantTiles({
      nodes,
      renderSet: [parent],
      camEcef: CAM,
      maxResidentTiles: 1,
      onEvict: () => undefined,
    });

    if (children.some((c) => !nodes.has(c.key))) {
      expect(parent.children).toBeNull();
    }
  });

  it('discards the farthest tiles first, not the least recently used', () => {
    // Recency and distance disagree in exactly the case that matters: an
    // aircraft orbiting a city keeps re-visiting the same ground, so LRU
    // starts discarding tiles just off the wingtip while keeping ones left
    // behind an hour ago.
    const near = new TileNode(9, tileX(-0.45, 9), tileY(51.5, 9), null);
    const far = new TileNode(9, tileX(150, 9), tileY(-30, 9), null);
    // The far tile is the *more* recently used one, so LRU would keep it.
    far.lastUsedFrame = 1000;
    near.lastUsedFrame = 1;

    const nodes = mapOf(near, far);
    const evicted: string[] = [];
    evictDistantTiles({
      nodes,
      renderSet: [],
      camEcef: CAM,
      maxResidentTiles: 1,
      onEvict: (n) => evicted.push(n.key),
    });

    expect(evicted).toEqual([far.key]);
    expect(nodes.has(near.key)).toBe(true);
  });

  it('reports every eviction exactly once, so no owner is missed', () => {
    // Three owners have to be told about an eviction — the scene, the
    // streamer and the node itself — and missing any one of them was a leak.
    const nodes = mapOf(
      ...Array.from({ length: 6 }, (_, i) => new TileNode(9, 100 + i, 170, null)),
    );
    const evicted: string[] = [];
    evictDistantTiles({
      nodes,
      renderSet: [],
      camEcef: CAM,
      maxResidentTiles: 2,
      onEvict: (n) => evicted.push(n.key),
    });

    expect(evicted).toHaveLength(4);
    expect(new Set(evicted).size).toBe(4);
    expect(nodes.size).toBe(2);
  });

  /**
   * Regression: the leaves-only guard used to disable itself.
   *
   * Evicting a child nulls its parent's `children` array so `ensureChildren`
   * can rebuild from the map. The guard read that same array, so the moment
   * one child went, the parent looked childless — and was evicted in the same
   * pass while its three siblings were still resident, leaving them pointing
   * at a disposed node. Asking the map instead of the array is what makes the
   * guard mean anything.
   */
  it('never leaves a resident tile pointing at an evicted parent', () => {
    // A single hand-built family cannot reach this: within one lineage the
    // children always sort before the parent, so the parent is only judged
    // once they are all gone. It takes a *ragged* tree — one where some
    // branches were refined and others were not — run over several frames,
    // which is what the quadtree actually is after a few minutes of flying.
    //
    // Measured on the previous implementation, which read `node.children`:
    // 19 orphaned tiles across this sweep. The array is nulled the moment one
    // child is evicted, so it reports "no children" for a parent whose
    // siblings are still resident, and the guard disables itself exactly
    // where it is needed. Asking the map instead gives 0.
    let orphans = 0;

    for (let seed = 0; seed < 400; seed++) {
      const nodes: TileMap = new Map();
      const root = new TileNode(5, 16, 11, null);
      nodes.set(root.key, root);

      const grow = (n: TileNode, depth: number): void => {
        if (depth === 0) return;
        const kids: TileNode[] = [];
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const c = new TileNode(n.z + 1, n.x * 2 + dx, n.y * 2 + dy, n);
            kids.push(c);
            nodes.set(c.key, c);
          }
        }
        n.children = kids;
        // Refine only some branches: this is what makes the tree ragged.
        for (const k of kids) if ((seed + k.x + k.y) % 3 !== 0) grow(k, depth - 1);
      };
      grow(root, 3);

      for (let frame = 0; frame < 6; frame++) {
        const cam: Vec3 = geodeticToEcef(45 + (seed % 7), 5 + (frame % 5), 3000 + seed * 40);
        evictDistantTiles({
          nodes,
          renderSet: [],
          camEcef: cam,
          maxResidentTiles: Math.max(2, nodes.size - 3 - (frame % 4)),
          onEvict: () => {},
        });
        for (const n of nodes.values()) {
          if (n.parent && !nodes.has(n.parent.key)) orphans++;
        }
      }
    }

    expect(orphans).toBe(0);
  });
});

function tileX(lonDeg: number, z: number): number {
  return Math.floor(((lonDeg + 180) / 360) * (1 << z));
}

function tileY(latDeg: number, z: number): number {
  const rad = (latDeg * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return Math.floor(y * (1 << z));
}
