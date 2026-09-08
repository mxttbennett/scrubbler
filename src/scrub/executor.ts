import { eq, and } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { Editor } from '../lastfm/editor.js';
import { EditRejectedError } from '../lastfm/errors.js';
import type { Reporter } from '../report/reporter.js';
import { type PlannedEdit, type Tuple, changedFields, tupleKey } from './types.js';
import type { SkipRecord } from './resolver.js';

const MAX_ATTEMPTS = 3;

export interface ExecutorOptions {
  dryRun: boolean;
  maxEditsPerRun: number;
  writeDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ExecutionSummary {
  planned: number;
  applied: number;
  verified: number;
  unverified: number;
  failed: number;
  skippedByLedger: number;
  skippedByRule: number;
  capped: boolean;
  samples: string[];
}

export class Executor {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly db: Db,
    private readonly editor: Editor,
    private readonly reporter: Reporter,
    private readonly opts: ExecutorOptions,
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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

  async run(edits: PlannedEdit[], existingRuleKeys: ReadonlySet<string>): Promise<ExecutionSummary> {
    const summary: ExecutionSummary = {
      planned: edits.length,
      applied: 0,
      verified: 0,
      unverified: 0,
      failed: 0,
      skippedByLedger: 0,
      skippedByRule: 0,
      capped: false,
      samples: [],
    };

    let writes = 0;
    for (const edit of edits) {
      if (changedFields(edit).length === 0) continue;

      if (existingRuleKeys.has(tupleKey(edit.original))) {
        summary.skippedByRule++;
        continue;
      }

      const existing = this.ledgerRow(edit.original);
      if (existing && (existing.status === 'verified' || existing.status === 'applied')) {
        summary.skippedByLedger++;
        continue;
      }
      if (existing && existing.attempts >= MAX_ATTEMPTS) {
        summary.skippedByLedger++;
        continue;
      }

      if (summary.samples.length < 20) summary.samples.push(this.editor.describe(edit));

      if (this.opts.dryRun) {
        this.upsert(edit, 'planned', existing?.attempts ?? 0, null);
        continue;
      }

      if (writes >= this.opts.maxEditsPerRun) {
        summary.capped = true;
        break;
      }

      try {
        const outcome = await this.editor.apply(edit);
        writes++;
        summary.applied++;
        if (outcome === 'verified') summary.verified++;
        else if (outcome === 'unverified') summary.unverified++;
        this.upsert(edit, outcome === 'applied' ? 'applied' : outcome, 0, null);
      } catch (error) {
        writes++;
        summary.failed++;
        const message = error instanceof Error ? error.message : String(error);
        this.upsert(edit, 'failed', (existing?.attempts ?? 0) + 1, message);
        if (!(error instanceof EditRejectedError)) {
          await this.reporter.report(error, `edit ${edit.original.artist_name}`);
        }
      }

      await this.sleep(this.opts.writeDelayMs);
    }

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
