/**
 * The queue's job is ordering and shared ownership, and both of its failure
 * modes are silent: a request dropped while someone still wants it leaves a
 * tile that never loads and never retries, and a request kept after everyone
 * withdrew holds a concurrency slot that the ground ahead of the aircraft
 * needed.
 */

import { describe, expect, it, vi } from 'vitest';

import { RequestQueue, attachCaller, type QueueEntry, type TileBytes } from './requestQueue';

function entry(key: string, priority: number): QueueEntry {
  return {
    key,
    priority,
    urls: [`https://example.test/${key}`],
    resolve: () => undefined,
    reject: () => undefined,
    controller: new AbortController(),
    refs: 1,
  };
}

const bytes = (key: string): TileBytes => ({
  key,
  data: new ArrayBuffer(8),
  sourceIndex: 0,
  fromDisk: false,
});

describe('RequestQueue', () => {
  it('serves the most urgent entry first, whatever the arrival order', () => {
    const q = new RequestQueue();
    q.add(entry('far', 16_000));
    q.add(entry('near', 9_000));
    q.add(entry('middle', 12_000));

    expect(q.take()?.key).toBe('near');
    expect(q.take()?.key).toBe('middle');
    expect(q.take()?.key).toBe('far');
    expect(q.take()).toBeUndefined();
  });

  it('re-sorts after a priority change', () => {
    // The camera moved: a tile that was urgent two seconds ago may now be
    // behind the aircraft and worthless, and vice versa.
    const q = new RequestQueue();
    q.add(entry('a', 10_000));
    q.add(entry('b', 12_000));

    q.setPriority('b', 1_000);
    expect(q.take()?.key).toBe('b');
  });

  it('lowers a shared entry to the most urgent caller, never raises it', () => {
    // A tile some node considers urgent does not become less urgent because a
    // distant node also wants it.
    const q = new RequestQueue();
    const e = entry('shared', 10_000);
    q.add(e);

    q.share(e, 2_000);
    expect(e.priority).toBe(2_000);

    q.share(e, 40_000);
    expect(e.priority).toBe(2_000);
    expect(e.refs).toBe(3);
  });

  it('keeps a shared request alive until the last caller withdraws', () => {
    // Two visible tiles routinely share one heightmap. Dropping on the first
    // withdrawal has one tile repeatedly cancelling the request its
    // neighbour is waiting on.
    const q = new RequestQueue();
    const e = entry('shared', 10_000);
    q.add(e);
    q.share(e, 10_000);

    expect(q.withdraw('shared')).toBeNull();
    expect(q.size).toBe(1);

    expect(q.withdraw('shared')).toBe(e);
    expect(q.size).toBe(0);
  });

  it('ignores a withdrawal for something it does not hold', () => {
    const q = new RequestQueue();
    expect(q.withdraw('never-queued')).toBeNull();
  });

  it('rejects every waiting caller when flushed', () => {
    const q = new RequestQueue();
    const rejects = [vi.fn(), vi.fn()];
    for (const [i, reject] of rejects.entries()) {
      q.add({ ...entry(`k${i}`, i), reject });
    }

    const reason = new DOMException('Loader flushed', 'AbortError');
    q.clear(reason);

    for (const reject of rejects) expect(reject).toHaveBeenCalledWith(reason);
    expect(q.size).toBe(0);
    expect(q.take()).toBeUndefined();
  });

  it('does not re-serve an entry that was taken', () => {
    const q = new RequestQueue();
    q.add(entry('once', 1));
    expect(q.take()?.key).toBe('once');
    expect(q.get('once')).toBeUndefined();
    expect(q.size).toBe(0);
  });
});

describe('attachCaller', () => {
  it('settles every caller from one outcome', async () => {
    const e = entry('shared', 1);
    const first = new Promise<TileBytes>((resolve, reject) => {
      e.resolve = resolve;
      e.reject = reject;
    });
    const second = attachCaller(e);
    const third = attachCaller(e);

    const result = bytes('shared');
    e.resolve(result);

    // All three get the *same* buffer, which is exactly why `loadGeometry`
    // copies before handing it to a worker that transfers it.
    for (const p of [first, second, third]) {
      await expect(p).resolves.toBe(result);
    }
  });

  it('propagates a rejection to every caller', async () => {
    const e = entry('shared', 1);
    const first = new Promise<TileBytes>((resolve, reject) => {
      e.resolve = resolve;
      e.reject = reject;
    });
    const second = attachCaller(e);

    const boom = new Error('no source served it');
    e.reject(boom);

    await expect(first).rejects.toBe(boom);
    await expect(second).rejects.toBe(boom);
  });
});
