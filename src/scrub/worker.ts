import type { Config } from '../core/config.js';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { AlbumEditor } from '../lastfm/albumEditor.js';
import type { Editor } from '../lastfm/editor.js';
import { readExistingRules } from '../lastfm/rules.js';
import type { Session } from '../lastfm/session.js';
import type { Reporter } from '../report/reporter.js';
import { eq } from 'drizzle-orm';
import { Executor } from './executor.js';
import type { Planner } from './planner.js';
import type { Resolver } from './resolver.js';
import type { Candidate } from './types.js';

export interface WorkerHooks {
  sleep?: (ms: number) => Promise<void>;
}

export class ScrubWorker {
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | undefined;
  private executor: Executor | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly session: Session,
    private readonly planner: Planner,
    private readonly resolver: Resolver,
    private readonly editor: Editor,
    private readonly albumEditor: AlbumEditor,
    private readonly reporter: Reporter,
    private readonly albumArt: (artist: string, album: string) => Promise<string | undefined>,
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

  /**
   * Requests a stop and resolves once the in-flight edit and its verification have finished, so a
   * deploy cannot kill a write between the Last.fm POST and the ledger row that records it.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    this.executor?.requestStop();
    await this.inFlight;
  }

  async runOnce(): Promise<void> {
    await this.session.ensureSession();
    const rules = await readExistingRules(this.session, (m) => console.log(m));
    console.log(
      `existing automatic-edit rules: ${rules.albumCount} album, ${rules.trackCount} track${rules.partial ? ' (partial read)' : ''}`,
    );

    const executor = new Executor(this.db, this.editor, this.albumEditor, this.reporter, {
      dryRun: this.config.dryRun,
      maxEditsPerRun: this.config.maxEditsPerRun,
      writeDelayMs: this.config.writeDelayMs,
      digestEvery: this.config.digestEvery,
      sleep: this.sleep,
      albumArt: this.albumArt,
    });
    this.executor = executor;

    // Apply anything a previous run resolved but never wrote, before spending hours re-scraping.
    const token = await this.session.freshCsrfToken(`/user/${this.config.username}/library`);
    const carried = token === undefined ? [] : executor.resumable(token);
    if (carried.length > 0) {
      console.log(`resuming ${carried.length} tuple(s) planned by an earlier run`);
      await executor.run(carried, rules.keys);
    }

    const state = this.db.select().from(schema.sweepState).where(eq(schema.sweepState.id, 1)).get();
    const cursor = state?.lastScrobbleUts ?? null;
    const lastFull = state?.lastFullSweepAt?.getTime() ?? 0;
    const fullDue = cursor === null || Date.now() - lastFull >= this.config.fullSweepIntervalMs;

    let candidates: Candidate[];
    let newestUts: number | undefined;
    if (fullDue) {
      console.log(cursor === null ? 'full sweep (no cursor yet)' : 'full sweep (interval elapsed)');
      candidates = await this.planner.sweep((seen, hits) =>
        console.log(`swept ${seen} entities, ${hits} candidates`),
      );
    } else {
      console.log(`incremental sweep from uts ${cursor}`);
      const r = await this.planner.sweepIncremental(cursor, (seen, hits) =>
        console.log(`examined ${seen} new scrobbles, ${hits} candidates`),
      );
      candidates = r.candidates;
      newestUts = r.newestUts;
    }
    console.log(`sweep complete: ${candidates.length} candidates`);

    let albumApplied = 0;
    const { skips } = await this.resolver.resolve(candidates, {
      onGroup: async (group) => {
        const before = executor.streamedSummary.applied;
        await executor.applyGroup(group, rules.keys);
        if (group.kind === 'album' && executor.streamedSummary.applied > before) albumApplied++;
      },
      onProgress: (doneCount, total, edits, candidate) => {
        const s = executor.streamedSummary;
        console.log(
          `[${doneCount}/${total}] ${candidate.kind} ${candidate.artist} — ${candidate.title} · ` +
            `${albumApplied} albums · ${edits} tuples · ${s.applied} applied · ` +
            `${s.verified} verified · ${s.unverified} unverified · ${s.failed} failed`,
        );
      },
    });

    for (const skip of skips) this.planner.recordDead(skip.candidate, skip.reason);
    executor.recordSkips(skips);
    const summary = executor.streamedSummary;

    // The cursor advances only after a completed cycle, so an interrupted one re-examines.
    const finished = !this.stopped;
    const advanced =
      finished && newestUts !== undefined ? { lastScrobbleUts: newestUts } : {};
    const fullStamp = finished && fullDue ? { lastFullSweepAt: new Date() } : {};
    this.db
      .insert(schema.sweepState)
      .values({
        id: 1,
        lastFullSweepAt: new Date(),
        lastSweepEditCount: summary.applied,
        ...(newestUts !== undefined ? { lastScrobbleUts: newestUts } : {}),
      })
      .onConflictDoUpdate({
        target: schema.sweepState.id,
        set: { lastSweepEditCount: summary.applied, ...advanced, ...fullStamp },
      })
      .run();

    await this.reporter.summary(
      this.config.dryRun ? 'Dry run complete — nothing written' : 'Sweep complete',
      [
        `candidates      ${candidates.length}`,
        `album renames   ${albumApplied}`,
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
        this.inFlight = this.runOnce();
        await this.inFlight;
      } catch (error) {
        await this.reporter.report(error, 'sweep');
      }
      await this.sleep(this.config.sweepIntervalMs);
    }
  }
}
