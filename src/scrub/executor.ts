import { eq, and } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { Editor } from '../lastfm/editor.js';
import { EditRejectedError } from '../lastfm/errors.js';
import type { Reporter } from '../report/reporter.js';
import type { Correction, Outcome, RunTotals } from '../report/reporter.js';
import { type PlannedEdit, type Tuple, changedFields, tupleKey } from './types.js';
import type { SkipRecord } from './resolver.js';

const MAX_ATTEMPTS = 3;

export interface ExecutorOptions {
  dryRun: boolean;
  maxEditsPerRun: number;
  writeDelayMs: number;
  digestEvery: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ExecutionSummary {
  planned: number;
  applied: number;
  verified: number;
  unverified: number;
  failed: number;
  skippedByLedger: number;
  alsoHasRule: number;
  capped: boolean;
}

export class Executor {
  private readonly sleep: (ms: number) => Promise<void>;
  private stopRequested = false;

  /** Stops before the *next* write; the in-flight one always finishes and records its ledger row. */
  requestStop(): void {
    this.stopRequested = true;
  }

  get stopping(): boolean {
    return this.stopRequested;
  }

  constructor(
    private readonly db: Db,
    private readonly editor: Editor,
    private readonly reporter: Reporter,
    private readonly opts: ExecutorOptions,
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Persists a resolved tuple before any write, so an interrupted resolution can be resumed. */
  checkpoint(edit: PlannedEdit): void {
    const existing = this.ledgerRow(edit.original);
    if (existing && existing.status !== 'planned') return;
    this.upsert(edit, 'planned', existing?.attempts ?? 0, null);
  }

  /**
   * Rebuilds edits left as `planned` by an interrupted run. The CSRF token comes from the session
   * cookie rather than the page, so one fresh token serves every resumed write.
   */
  resumable(csrfToken: string): PlannedEdit[] {
    const rows = this.db
      .select()
      .from(schema.appliedEdits)
      .where(eq(schema.appliedEdits.status, 'planned'))
      .all();

    const out: PlannedEdit[] = [];
    for (const r of rows) {
      if (r.timestamp === null || r.action === null || r.refererPath === null) continue;
      out.push({
        original: {
          track_name: r.trackNameOriginal,
          artist_name: r.artistNameOriginal,
          album_name: r.albumNameOriginal,
          album_artist_name: r.albumArtistNameOriginal,
        },
        next: {
          track_name: r.trackName,
          artist_name: r.artistName,
          album_name: r.albumName,
          album_artist_name: r.albumArtistName,
        },
        timestamp: r.timestamp,
        csrfToken,
        action: r.action,
        refererPath: r.refererPath,
        groups: r.groups === '' ? [] : (r.groups.split(',') as PlannedEdit['groups']),
      });
    }
    return out;
  }

  recordSkips(skips: SkipRecord[]): void {
    for (const skip of skips) {
      this.db
        .insert(schema.skipped)
        .values({
          kind: skip.candidate.kind,
          artist: skip.candidate.artist,
          title: skip.candidate.title,
          reason: skip.reason,
        })
        .onConflictDoNothing()
        .run();
    }
  }

  private ledgerRow(original: Tuple) {
    return this.db
      .select()
      .from(schema.appliedEdits)
      .where(
        and(
          eq(schema.appliedEdits.trackNameOriginal, original.track_name),
          eq(schema.appliedEdits.artistNameOriginal, original.artist_name),
          eq(schema.appliedEdits.albumNameOriginal, original.album_name),
          eq(schema.appliedEdits.albumArtistNameOriginal, original.album_artist_name),
        ),
      )
      .get();
  }

  /** Streams one resolved tuple straight to a write, so corrections land during resolution. */
  async applyOne(edit: PlannedEdit, existingRuleKeys: ReadonlySet<string>): Promise<void> {
    await this.run([edit], existingRuleKeys, this.streamed);
  }

  get streamedSummary(): ExecutionSummary {
    return this.streamed;
  }

  private streamed: ExecutionSummary = blankSummary();

  async run(
    edits: PlannedEdit[],
    existingRuleKeys: ReadonlySet<string>,
    into?: ExecutionSummary,
  ): Promise<ExecutionSummary> {
    const summary: ExecutionSummary = into ?? blankSummary();
    summary.planned += edits.length;

    const totals = (): RunTotals => ({
      planned: summary.planned,
      applied: summary.applied,
      verified: summary.verified,
      unverified: summary.unverified,
      failed: summary.failed,
    });
    const pending: Correction[] = [];
    const flush = async () => {
      if (pending.length === 0) return;
      await this.reporter.corrections([...pending], totals());
      pending.length = 0;
    };
    const record = (edit: PlannedEdit, outcome: Outcome, error?: string) => {
      pending.push({
        artist: edit.original.artist_name,
        track: edit.original.track_name,
        album: edit.original.album_name,
        changes: changedFields(edit).map((f) => ({
          field: f,
          from: edit.original[f],
          to: edit.next[f],
        })),
        groups: edit.groups,
        outcome,
        ...(error === undefined ? {} : { error }),
      });
    };

    for (const edit of edits) {
      if (changedFields(edit).length === 0) continue;

      // A rule existing does NOT mean the work is done: a rule created without "apply to all past
      // scrobbles" fixes only future ones, so a still-dirty title proves the past ones need editing.
      if (existingRuleKeys.has(tupleKey(edit.original))) summary.alsoHasRule++;

      const existing = this.ledgerRow(edit.original);
      if (existing && (existing.status === 'verified' || existing.status === 'applied')) {
        summary.skippedByLedger++;
        continue;
      }
      if (existing && existing.attempts >= MAX_ATTEMPTS) {
        summary.skippedByLedger++;
        continue;
      }

      if (this.opts.dryRun) {
        this.upsert(edit, 'planned', existing?.attempts ?? 0, null);
        record(edit, 'planned');
        if (pending.length >= this.opts.digestEvery) await flush();
        continue;
      }

      if (summary.applied + summary.failed >= this.opts.maxEditsPerRun) {
        summary.capped = true;
        break;
      }
      if (this.stopRequested) break;

      try {
        const outcome = await this.editor.apply(edit);
        summary.applied++;
        if (outcome === 'verified') summary.verified++;
        else if (outcome === 'unverified') summary.unverified++;
        this.upsert(edit, outcome === 'applied' ? 'applied' : outcome, 0, null);
        record(edit, outcome);
      } catch (error) {
        summary.failed++;
        const message = error instanceof Error ? error.message : String(error);
        this.upsert(edit, 'failed', (existing?.attempts ?? 0) + 1, message);
        record(edit, 'failed', message);
        if (!(error instanceof EditRejectedError)) {
          await this.reporter.report(error, `edit ${edit.original.artist_name}`);
        }
      }

      if (pending.length >= this.opts.digestEvery) await flush();
      await this.sleep(this.opts.writeDelayMs);
    }

    await flush();
    return summary;
  }

  private upsert(edit: PlannedEdit, status: string, attempts: number, lastError: string | null) {
    const values = {
      trackNameOriginal: edit.original.track_name,
      artistNameOriginal: edit.original.artist_name,
      albumNameOriginal: edit.original.album_name,
      albumArtistNameOriginal: edit.original.album_artist_name,
      trackName: edit.next.track_name,
      artistName: edit.next.artist_name,
      albumName: edit.next.album_name,
      albumArtistName: edit.next.album_artist_name,
      groups: edit.groups.join(','),
      timestamp: edit.timestamp,
      action: edit.action,
      refererPath: edit.refererPath,
      status: status as 'applied' | 'verified' | 'unverified' | 'failed' | 'skipped' | 'planned',
      attempts,
      lastError,
      verifiedAt: status === 'verified' ? new Date() : null,
    };
    this.db
      .insert(schema.appliedEdits)
      .values(values)
      .onConflictDoUpdate({
        target: [
          schema.appliedEdits.trackNameOriginal,
          schema.appliedEdits.artistNameOriginal,
          schema.appliedEdits.albumNameOriginal,
          schema.appliedEdits.albumArtistNameOriginal,
        ],
        set: values,
      })
      .run();
  }
}

function blankSummary(): ExecutionSummary {
  return {
    planned: 0,
    applied: 0,
    verified: 0,
    unverified: 0,
    failed: 0,
    skippedByLedger: 0,
    alsoHasRule: 0,
    capped: false,
  };
}
