export interface RateLimiterHooks {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export class RateLimiter {
  private nextFree = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly minIntervalMs: number,
    hooks: RateLimiterHooks = {},
    /** Spread added on top of the minimum, so a fixed cadence cannot beat against a rate-limit window. */
    private readonly jitterMs = 0,
  ) {
    this.sleep = hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = hooks.now ?? Date.now;
    this.random = hooks.random ?? Math.random;
  }

  private interval(): number {
    return this.jitterMs > 0
      ? this.minIntervalMs + Math.floor(this.random() * this.jitterMs)
      : this.minIntervalMs;
  }

  async acquire(): Promise<void> {
    const now = this.now();
    const scheduled = Math.max(now, this.nextFree);
    // Bumped before the await so concurrent callers each get a distinct FIFO slot.
    this.nextFree = scheduled + this.interval();
    const wait = scheduled - now;
    if (wait > 0) await this.sleep(wait);
  }
}
