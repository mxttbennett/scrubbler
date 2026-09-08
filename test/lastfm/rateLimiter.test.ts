import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/lastfm/rateLimiter.js';

function harness(interval: number, jitter: number, random: () => number) {
  let clock = 0;
  const waits: number[] = [];
  const limiter = new RateLimiter(
    interval,
    { now: () => clock, sleep: async (ms) => { clock += ms; waits.push(ms); }, random },
    jitter,
  );
  return { limiter, waits, tick: (ms: number) => (clock += ms) };
}

describe('RateLimiter', () => {
  it('does not wait for the first acquire', async () => {
    const { limiter, waits } = harness(15_000, 0, () => 0);
    await limiter.acquire();
    expect(waits).toEqual([]);
  });

  it('spaces subsequent acquires by the interval', async () => {
    const { limiter, waits } = harness(15_000, 0, () => 0);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(waits).toEqual([15_000, 15_000]);
  });

  it('adds jitter within [interval, interval + jitter)', async () => {
    const { limiter, waits } = harness(15_000, 5_000, () => 0.5);
    await limiter.acquire();
    await limiter.acquire();
    expect(waits[0]).toBe(17_500);
  });

  it('keeps jitter inside its bounds at both extremes', async () => {
    const low = harness(15_000, 5_000, () => 0);
    await low.limiter.acquire();
    await low.limiter.acquire();
    expect(low.waits[0]).toBe(15_000);

    const high = harness(15_000, 5_000, () => 0.999999);
    await high.limiter.acquire();
    await high.limiter.acquire();
    expect(high.waits[0]).toBe(19_999);
  });

  it('does not wait when the caller was already slower than the interval', async () => {
    const { limiter, waits, tick } = harness(15_000, 0, () => 0);
    await limiter.acquire();
    tick(60_000);
    await limiter.acquire();
    expect(waits).toEqual([]);
  });

  it('gives concurrent callers distinct slots rather than one shared wait', async () => {
    const { limiter, waits } = harness(1_000, 0, () => 0);
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    expect(waits.filter((w) => w > 0)).toHaveLength(2);
  });
});
