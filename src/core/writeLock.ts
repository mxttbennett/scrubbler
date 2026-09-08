/**
 * Serialises every Last.fm write in the process. Last.fm returns 200 for an accepted-but-no-op
 * edit, so two interleaved writes are not merely slow — the loser is misreported as success. The
 * worker, an approval click and a slash command are three independent writers with no other
 * ordering between them.
 *
 * Not re-entrant, deliberately: a depth counter cannot tell a nested acquire from a second caller
 * arriving while the lock is held, and guessing wrong the permissive way lets exactly the
 * concurrent writes this exists to stop. Acquire only at the innermost write, and a mistake
 * deadlocks loudly instead of corrupting quietly.
 */
export class WriteLock {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;
  private locked = false;

  /** How many callers are queued behind the holder, so a command can say it is waiting. */
  get queueLength(): number {
    return this.waiting;
  }

  get held(): boolean {
    return this.locked;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.waiting++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    this.waiting--;
    this.locked = true;
    try {
      return await fn();
    } finally {
      this.locked = false;
      release();
    }
  }
}
