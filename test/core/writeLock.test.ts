import { describe, expect, it } from 'vitest';
import { WriteLock } from '../../src/core/writeLock.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('WriteLock', () => {
  it('runs overlapping writes strictly one at a time', async () => {
    const lock = new WriteLock();
    const order: string[] = [];

    const write = (name: string) =>
      lock.run(async () => {
        order.push(`${name} start`);
        await tick();
        await tick();
        order.push(`${name} end`);
      });

    await Promise.all([write('a'), write('b'), write('c')]);

    expect(order).toEqual([
      'a start',
      'a end',
      'b start',
      'b end',
      'c start',
      'c end',
    ]);
  });

  it('keeps FIFO order, so the worker is not starved by a stream of commands', async () => {
    const lock = new WriteLock();
    const finished: number[] = [];

    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        lock.run(async () => {
          await tick();
          finished.push(n);
        }),
      ),
    );

    expect(finished).toEqual([1, 2, 3, 4, 5]);
  });

  it('releases when the body throws, or one failed edit would wedge the service', async () => {
    const lock = new WriteLock();

    await expect(
      lock.run(async () => {
        throw new Error('edit rejected');
      }),
    ).rejects.toThrow('edit rejected');

    expect(lock.held).toBe(false);
    await expect(lock.run(async () => 'next one still runs')).resolves.toBe(
      'next one still runs',
    );
  });

  it('does not treat a second caller as a nested one while the lock is held', async () => {
    const lock = new WriteLock();
    const order: string[] = [];

    const first = lock.run(async () => {
      order.push('first start');
      await tick();
      await tick();
      order.push('first end');
    });
    // Arrives while the lock is held — a depth counter would read this as re-entrancy and let it run.
    const second = lock.run(async () => void order.push('second start'));

    await Promise.all([first, second]);
    expect(order).toEqual(['first start', 'first end', 'second start']);
  });

  it('reports how many callers are queued, so a command can say it is waiting', async () => {
    const lock = new WriteLock();
    let observed = -1;

    const held = lock.run(async () => {
      await tick();
      await tick();
    });
    await tick();
    const queued = lock.run(async () => {
      observed = lock.queueLength;
    });

    expect(lock.queueLength).toBeGreaterThan(0);
    await Promise.all([held, queued]);
    expect(observed).toBe(0);
  });

  it('returns the body value untouched', async () => {
    const lock = new WriteLock();
    expect(await lock.run(async () => ({ ok: true }))).toEqual({ ok: true });
  });
});
