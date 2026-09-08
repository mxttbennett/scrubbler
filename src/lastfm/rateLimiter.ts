export class RateLimiter {
  private nextFree = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly minIntervalMs: number,
    hooks?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
  ) {
    this.sleep = hooks?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = hooks?.now ?? Date.now;
  }

  async acquire(): Promise<void> {
    const now = this.now();
    const scheduled = Math.max(now, this.nextFree);
    // Bumped before the await so concurrent callers each get a distinct FIFO slot.
    this.nextFree = scheduled + this.minIntervalMs;
    const wait = scheduled - now;
    if (wait > 0) await this.sleep(wait);
  }
}
