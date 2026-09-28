/**
 * When a tile is allowed to be drawn.
 *
 * One getter, and it earns a file because the version it replaced is what the
 * ground looked like: a grid of sharp and blurry rectangles, refining at
 * different moments and meeting along hard tile edges. `contentReady` is the
 * only gate between "the quadtree wants this tile" and "the viewer is looking
 * at it", so everything about how the ground *arrives* is decided here.
 */

import { BufferGeometry, Texture } from 'three';
import { describe, expect, it } from 'vitest';

import { TileNode } from './tileNode';

function node(): TileNode {
  return new TileNode(12, 2130, 1440, null);
}

describe('contentReady', () => {
  it('is false with geometry alone', () => {
    /*
     * The regression. Geometry is nearly free — one z15 heightmap serves
     * sixteen tiles and is usually already in cache — so gating on it alone
     * let a quad go ready within a frame or two of being wanted, be drawn
     * stretching its parent's imagery, and then sharpen tile by tile as each
     * texture happened to land.
     */
    const tile = node();
    tile.geometry = new BufferGeometry();
    expect(tile.contentReady).toBe(false);
  });

  it('is false with imagery alone', () => {
    const tile = node();
    tile.texture = new Texture();
    expect(tile.contentReady).toBe(false);
  });

  it('is true once both have arrived', () => {
    const tile = node();
    tile.geometry = new BufferGeometry();
    tile.texture = new Texture();
    expect(tile.contentReady).toBe(true);
  });

  it('accepts a tile whose imagery provably cannot exist', () => {
    /*
     * `exhausted` is terminal: past the layer's maximum zoom, or given up on
     * after the retry budget. The tile will inherit its ancestor's imagery for
     * ever, and refusing it would stop refinement dead at the edge of the
     * imagery's coverage — every tile past z18 on a layer that stops there,
     * permanently unrefinable.
     */
    const tile = node();
    tile.geometry = new BufferGeometry();
    tile.textureState = 'exhausted';
    expect(tile.contentReady).toBe(true);
  });

  it('does not accept a tile that merely failed', () => {
    // `failed` is retried with backoff, so waiting costs a few frames and
    // gains the real image. Only `exhausted` means there is nothing to wait
    // for.
    const tile = node();
    tile.geometry = new BufferGeometry();
    tile.textureState = 'failed';
    expect(tile.contentReady).toBe(false);
  });
});
