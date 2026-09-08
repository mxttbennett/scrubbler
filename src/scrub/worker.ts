import type { Config } from '../core/config.js';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { Editor } from '../lastfm/editor.js';
import { readExistingRules } from '../lastfm/rules.js';
import type { Session } from '../lastfm/session.js';
import type { Reporter } from '../report/reporter.js';
import { Executor } from './executor.js';
import type { Planner } from './planner.js';
import type { Resolver } from './resolver.js';

export interface WorkerHooks {
  sleep?: (ms: number) => Promise<void>;
}

export class ScrubWorker {
  private running = false;
  private stopped = false;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly session: Session,
    private readonly planner: Planner,
    private readonly resolver: Resolver,
    private readonly editor: Editor,
    private readonly reporter: Reporter,
    hooks: WorkerHooks = {},
  ) {
    this.sleep = hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
  }

  async runOnce(): Promise<void> {
    await this.session.ensureSession();
    const rules = await readExistingRules(this.session, (m) => console.log(m));
    console.log(
      `existing automatic-edit rules: ${rules.albumCount} album, ${rules.trackCount} track${rules.partial ? ' (partial read)' : ''}`,
    );

    const candidates = await this.planner.sweep((seen, hits) =>
      console.log(`swept ${seen} entities, ${hits} candidates`),
    );
    console.log(`sweep complete: ${candidates.length} candidates`);

    const { edits, skips } = await this.resolver.resolve(candidates);
    console.log(`resolved to ${edits.length} distinct tuples, ${skips.length} skipped`);

    const executor = new Executor(this.db, this.editor, this.reporter, {
      dryRun: this.config.dryRun,
      maxEditsPerRun: this.config.maxEditsPerRun,
      writeDelayMs: this.config.writeDelayMs,
      digestEvery: this.config.digestEvery,
      sleep: this.sleep,
    });
    executor.recordSkips(skips);
    const summary = await executor.run(edits, rules.keys);

    this.db
      .insert(schema.sweepState)
      .values({ id: 1, lastFullSweepAt: new Date(), lastSweepEditCount: summary.applied })
      .onConflictDoUpdate({
        target: schema.sweepState.id,
        set: { lastFullSweepAt: new Date(), lastSweepEditCount: summary.applied },
      })
      .run();

    await this.reporter.summary(
      this.config.dryRun ? 'Dry run complete — nothing written' : 'Sweep complete',
      [
        `candidates      ${candidates.length}`,
        `distinct tuples ${summary.planned}`,
        `already done    ${summary.skippedByLedger}`,
        `also had a rule ${summary.alsoHasRule}`,
        `skipped         ${skips.length}`,
        ...(summary.capped ? [`CAPPED at MAX_EDITS_PER_RUN`] : []),
      ],
      {
        planned: summary.planned,
        applied: summary.applied,
        verified: summary.verified,
        unverified: summary.unverified,
        failed: summary.failed,
      },
    );
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (error) {
        await this.reporter.report(error, 'sweep');
      }
      await this.sleep(this.config.sweepIntervalMs);
    }
  }
}
