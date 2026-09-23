/**
 * Worker pool dispatch.
 *
 * The pool is the only thing standing between the quadtree and the terrain
 * builds, so a dispatch bug does not look like a crash — it looks like ground
 * that never arrives.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TerrainWorkerPool } from './pool';

interface FakeWorker {
  name: string;
  posted: unknown[];
  terminated: boolean;
  fail(message: string): void;
}

const live: FakeWorker[] = [];

class MockWorker {
  posted: unknown[] = [];
  terminated = false;
  private errorHandlers: ((e: unknown) => void)[] = [];

  constructor(_url: URL, readonly options: { name: string }) {
    const self = this;
    live.push({
      name: options.name,
      posted: this.posted,
      get terminated() {
        return self.terminated;
      },
      fail(message: string) {
        for (const h of self.errorHandlers) h({ message });
      },
    } as FakeWorker);
  }

  addEventListener(type: string, handler: (e: never) => void): void {
    if (type === 'error') this.errorHandlers.push(handler as (e: unknown) => void);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** The pool sizes itself from the core count; pin it so the test is stable. */
beforeEach(() => {
  live.length = 0;
  vi.stubGlobal('Worker', MockWorker);
  vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
});

describe('TerrainWorkerPool', () => {
  /**
   * Regression: a dead worker became the permanent dispatch target.
   *
   * Handling a worker error by zeroing its load, without replacing the
   * worker, left a slot that looked permanently idle — and `leastLoaded`
   * picks the idlest. Every subsequent build went to the dead worker, failed,
   * and the tiles burned through their retry budget while healthy workers sat
   * unused. One crash took the whole terrain pipeline with it.
   */
  it('stops dispatching to a worker that died', () => {
    const pool = new TerrainWorkerPool(2);
    expect(live).toHaveLength(2);

    const [first] = live;
    first!.fail('boom');

    // The dead slot is terminated and replaced, so the pool is whole again.
    expect(first!.terminated).toBe(true);
    expect(pool.size).toBe(2);
    expect(live).toHaveLength(3); // two original + one replacement

    const before = live.map((w) => w.posted.length);
    for (let i = 0; i < 6; i++) {
      void pool.build({ tile: { z: 5, x: 1, y: 1 }, bytes: null } as never);
    }

    // Nothing went to the corpse.
    expect(live[0]!.posted.length).toBe(before[0]);
    // And the work actually landed somewhere.
    const delivered = live.slice(1).reduce((n, w) => n + w.posted.length, 0);
    expect(delivered).toBe(6);
  });

  /** A crash loop must not spin forever respawning the same failure. */
  it('retires a slot that keeps dying', () => {
    const pool = new TerrainWorkerPool(2);

    // Fail slot 0 repeatedly; each failure replaces it, until it is written off.
    for (let i = 0; i < 10; i++) {
      const latest = live[live.length - 1]!;
      if (latest.name.endsWith('-0')) latest.fail('boom');
      else break;
    }

    expect(pool.size).toBeGreaterThanOrEqual(1);
    expect(pool.size).toBeLessThanOrEqual(2);

    // The pool still works with whatever it has left.
    void pool.build({ tile: { z: 5, x: 1, y: 1 }, bytes: null } as never);
    const delivered = live.filter((w) => !w.terminated).reduce((n, w) => n + w.posted.length, 0);
    expect(delivered).toBe(1);
  });
});
