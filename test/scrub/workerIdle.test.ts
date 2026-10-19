import { describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../../src/db/index.js';
import { ScrubWorker } from '../../src/scrub/worker.js';

/**
 * Drives the real loop with a `sleep` that resolves at once and stops the worker after a couple of
 * cycles. The session stub rejects, so `runOnce` fails fast — the loop is meant to survive that, and
 * it is what proves the idle hook still runs on the error path. `stop()` re-awaits that same
 * rejected `inFlight` promise, hence `settle()`.
 */
function harness(onIdle?: (budgetMs: number) => Promise<void>) {
  const db = createDb(':memory:');
  runMigrations(db);
  const reported: string[] = [];
  let cycles = 0;
  let sleepSpy: (() => void) | undefined;
  let reachedSleep!: () => void;
  const firstSleep = new Promise<void>((resolve) => {
    reachedSleep = resolve;
  });

  const worker = new ScrubWorker({
    config: { sweepIntervalMs: 1000, fullSweepIntervalMs: 10_000, shutdownGraceMs: 100 },
    db,
    // Fails fast and predictably, so every cycle reaches the idle hook by the error path.
    session: { ensureSession: () => Promise.reject(new Error('no session in test')) },
    planner: {},
    resolver: {},
    editor: {},
    albumEditor: {},
    reporter: {
      corrections: () => Promise.resolve(),
      group: () => Promise.resolve(),
      summary: () => Promise.resolve(),
      shadow: () => Promise.resolve(),
      report: (_error: unknown, where: string) => {
        reported.push(where);
        return Promise.resolve();
      },
    },
    approvals: {},
    ...(onIdle === undefined ? {} : { onIdle }),
    sleep: () => {
      cycles++;
      sleepSpy?.();
      reachedSleep();
      if (cycles >= 2) void worker.stop().catch(() => undefined);
      return Promise.resolve();
    },
  } as never);

  /**
   * Reaching the sleep proves the cycle got past the idle hook; stopping before that would race it.
   * `stop()` re-awaits the failed cycle, which is not what these tests are about, hence the catch.
   */
  const settle = async () => {
    await firstSleep;
    await worker.stop().catch(() => undefined);
  };

  return {
    worker,
    reported,
    settle,
    cycleCount: () => cycles,
    onSleep: (fn: () => void) => {
      sleepSpy = fn;
    },
  };
}

describe('ScrubWorker idle hook', () => {
  it('is optional — a worker without one still cycles', async () => {
    const h = harness();

    h.worker.start();
    await h.settle();

    expect(h.cycleCount()).toBeGreaterThanOrEqual(1);
  });

  it('runs between cycles and is given the sweep interval as its budget', async () => {
    const budgets: number[] = [];
    const h = harness((budgetMs) => {
      budgets.push(budgetMs);
      return Promise.resolve();
    });

    h.worker.start();
    await h.settle();

    expect(budgets.length).toBeGreaterThanOrEqual(1);
    expect(budgets[0]).toBe(1000);
  });

  it('reports a throwing hook under its own label without killing the loop', async () => {
    const h = harness(() => Promise.reject(new Error('crawl exploded')));

    h.worker.start();
    await h.settle();

    expect(h.reported).toContain('idle');
    expect(h.cycleCount()).toBeGreaterThanOrEqual(1);
  });

  it('runs the hook before the sleep, so it uses the gap rather than delaying it', async () => {
    const order: string[] = [];
    const h = harness(() => {
      order.push('idle');
      return Promise.resolve();
    });
    h.onSleep(() => order.push('sleep'));

    h.worker.start();
    await h.settle();

    expect(order.slice(0, 2)).toEqual(['idle', 'sleep']);
  });
});
