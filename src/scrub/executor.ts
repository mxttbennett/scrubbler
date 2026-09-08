import { eq, and } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import type { WriteLock } from '../core/writeLock.js';
import { schema } from '../db/index.js';
import type { AlbumEditor, PlannedAlbumEdit } from '../lastfm/albumEditor.js';
import type { AlbumDetails as AlbumSummary } from '../lastfm/types.js';
import type { Editor } from '../lastfm/editor.js';
import { EditRejectedError } from '../lastfm/errors.js';
import type { Reporter } from '../report/reporter.js';
import type { Correction, Outcome, RunTotals } from '../report/reporter.js';
import type { RuleTag } from '../rules/markers.js';
import { type EditGroup, type PlannedEdit, type Tuple, changedFields, tupleKey } from './types.js';
import type { SkipRecord } from './resolver.js';

const MAX_ATTEMPTS = 3;

export interface ExecutorOptions {
  dryRun: boolean;
  maxEditsPerRun: number;
  writeDelayMs: number;
  digestEvery: number;
  sleep?: (ms: number) => Promise<void>;
  /** Post-edit album art, looked up per album and cached by the API client. */
  albumArt?: (artist: string, album: string) => Promise<string | undefined>;
  /**
   * The release track list and the user's scrobble count. Must be read for the ORIGINAL title and
   * BEFORE the write: afterwards the old name has no scrobbles left to count.
   */
  albumDetails?: (artist: string, album: string) => Promise<AlbumSummary>;
  /**
   * Shared across every executor in the process. Omitted only in tests that write nothing
   * concurrently; production must pass one or the worker, an approval and a command can interleave.
   */
  writeLock?: WriteLock;
  /**
   * Fired only once a write actually landed as applied or verified — never on failure — so a custom
   * rule's apply count can never claim an edit that did not happen.
   */
  onApplied?: (tags: RuleTag[], entity: { kind: 'track' | 'album'; artist: string; title: string }) => void;
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
  /** Counted where the write happens, so an album rename cannot be tallied as a track edit. */
  byKind: Record<
    'track' | 'album',
    { applied: number; failed: number; tracksCovered: number; scrobblesCovered: number }
  >;
}

export type ResumableStatus = 'planned' | 'awaiting_approval';

export type ResumableEdit =
  | { kind: 'track'; id: number; edit: PlannedEdit }
  | { kind: 'album'; id: number; edit: PlannedAlbumEdit };

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
    private readonly albumEditor: AlbumEditor,
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
  /**
   * Discriminated by kind: an album row carries '' for every track field, so rebuilding one as a
   * PlannedEdit would POST a track rename with an empty track name.
   */
  resumable(csrfToken: string, status: ResumableStatus = 'planned'): ResumableEdit[] {
    const rows = this.db
      .select()
      .from(schema.appliedEdits)
      .where(eq(schema.appliedEdits.status, status))
      .all();

    const out: ResumableEdit[] = [];
    for (const r of rows) {
      if (r.action === null || r.refererPath === null) continue;
      if (r.kind === 'album') {
        out.push({
          kind: 'album',
          id: r.id,
          edit: {
            artist: r.albumArtistNameOriginal,
            from: r.albumNameOriginal,
            to: r.albumName,
            csrfToken,
            action: r.action,
            refererPath: r.refererPath,
            groups: r.groups === '' ? [] : r.groups.split(','),
          },
        });
        continue;
      }
      if (r.timestamp === null) continue;
      out.push({
        kind: 'track',
        id: r.id,
        edit: {
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
        },
      });
    }
    return out;
  }

  /** Album rows use '' for the track fields, so the tuple index keeps them distinct from tracks. */
  private albumTuple(edit: PlannedAlbumEdit): Tuple {
    return {
      track_name: '',
      artist_name: '',
      album_name: edit.from,
      album_artist_name: edit.artist,
    };
  }

  checkpointAlbum(edit: PlannedAlbumEdit): void {
    const existing = this.ledgerRow(this.albumTuple(edit));
    if (existing && existing.status !== 'planned') return;
    this.upsertAlbum(edit, 'planned', existing?.attempts ?? 0, null);
  }

  /** Mirrors applyOne, so album renames are deduped, backed off and counted like track edits. */
  async applyOneAlbum(edit: PlannedAlbumEdit): Promise<void> {
    const summary = this.streamed;
    summary.planned += 1;

    const existing = this.ledgerRow(this.albumTuple(edit));
    if (existing && (existing.status === 'verified' || existing.status === 'applied')) {
      summary.skippedByLedger++;
      return;
    }
    if (existing && existing.attempts >= MAX_ATTEMPTS) {
      summary.skippedByLedger++;
      return;
    }
    if (this.opts.dryRun) {
      this.upsertAlbum(edit, 'planned', existing?.attempts ?? 0, null);
      return;
    }
    if (summary.applied + summary.failed >= this.opts.maxEditsPerRun) {
      summary.capped = true;
      return;
    }
    if (this.stopRequested) return;

    // Before the write, and for the ORIGINAL title: those scrobbles move to the new name the moment
    // the rename lands. Swallowed because this is reporting only and must never stop a correction.
    const before = await this.opts
      .albumDetails?.(edit.artist, edit.from)
      .catch(() => undefined);

    try {
      const outcome = await this.locked(() => this.albumEditor.apply(edit));
      summary.applied++;
      summary.byKind.album.applied++;

      // The track list comes from the POST-edit name: Last.fm catalogues a release under its
      // canonical title, so asking about the cruft-laden one returns a play count and no tracks.
      // Same lookup the art already needed, so this costs no extra request.
      const after = await this.opts
        .albumDetails?.(edit.artist, edit.to)
        .catch(() => undefined);
      const imageUrl = after?.imageUrl ?? (await this.opts.albumArt?.(edit.artist, edit.to));

      // The album's own library page, which the resolver already fetched, lists exactly the tracks
      // scrobbled under the old name — including any the API's release list never knew about.
      const scrobbledTracks = edit.trackNames ?? [];

      summary.byKind.album.tracksCovered += scrobbledTracks.length;
      summary.byKind.album.scrobblesCovered += before?.scrobbles ?? 0;
      if (outcome === 'verified') summary.verified++;
      else if (outcome === 'unverified') summary.unverified++;
      this.upsertAlbum(edit, outcome === 'applied' ? 'applied' : outcome, 0, null);
      this.opts.onApplied?.(edit.groups as RuleTag[], {
        kind: 'album',
        artist: edit.artist,
        title: edit.from,
      });
      await this.emit(
        [
          {
            artist: edit.artist,
            kind: 'album',
            track: '(whole album)',
            album: edit.from,
            changes: [{ field: 'album_name', from: edit.from, to: edit.to }],
            groups: edit.groups,
            outcome: outcome === 'applied' ? 'applied' : outcome,
            ...(imageUrl === undefined ? {} : { imageUrl }),
            ...(scrobbledTracks.length === 0 ? {} : { scrobbledTracks }),
            ...(before?.scrobbles === undefined ? {} : { scrobbles: before.scrobbles }),
          },
        ],
        this.totalsOf(summary),
      );
    } catch (error) {
      summary.failed++;
      const message = error instanceof Error ? error.message : String(error);
      summary.byKind.album.failed++;
      this.upsertAlbum(edit, 'failed', (existing?.attempts ?? 0) + 1, message);
      if (!(error instanceof EditRejectedError)) {
        await this.reporter.report(error, `album edit ${edit.artist} — ${edit.from}`);
      }
    }
    await this.sleep(this.opts.writeDelayMs);
  }

  private upsertAlbum(
    edit: PlannedAlbumEdit,
    status: string,
    attempts: number,
    lastError: string | null,
  ) {
    const values = {
      trackNameOriginal: '',
      artistNameOriginal: '',
      albumNameOriginal: edit.from,
      albumArtistNameOriginal: edit.artist,
      trackName: '',
      artistName: '',
      albumName: edit.to,
      albumArtistName: edit.artist,
      kind: 'album' as const,
      groups: edit.groups.join(','),
      timestamp: '',
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

  private totalsOf(s: ExecutionSummary): RunTotals {
    return {
      planned: s.planned,
      applied: s.applied,
      verified: s.verified,
      unverified: s.unverified,
      failed: s.failed,
      dryRun: this.opts.dryRun,
      albums: s.byKind.album.applied,
      tracks: s.byKind.track.applied,
    };
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

  /**
   * The POST and its verification read are one critical section: Last.fm serves stale rows briefly
   * after a write, so another writer landing between them makes the verification read the wrong row.
   */
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const lock = this.opts.writeLock;
    return lock === undefined ? await fn() : await lock.run(fn);
  }

  /** The approval row's buttons address ledger rows by id, so the caller needs the id back. */
  ledgerId(original: Tuple): number | undefined {
    return this.ledgerRow(original)?.id;
  }

  /** Streams one resolved tuple straight to a write, so corrections land during resolution. */
  async applyOne(edit: PlannedEdit, existingRuleKeys: ReadonlySet<string>): Promise<void> {
    await this.run([edit], existingRuleKeys, this.streamed);
  }

  async applyCarried(
    carried: ResumableEdit[],
    existingRuleKeys: ReadonlySet<string>,
  ): Promise<void> {
    for (const item of carried) {
      if (item.kind === 'album') await this.applyOneAlbum(item.edit);
      else await this.run([item.edit], existingRuleKeys, this.streamed);
    }
  }

  /** Set while a group is applying, so its members report as one card instead of one card each. */
  private collector: Correction[] | null = null;

  private async emit(items: Correction[], totals: RunTotals): Promise<void> {
    if (this.collector !== null) {
      this.collector.push(...items);
      return;
    }
    await this.reporter.corrections(items, totals);
  }

  /**
   * Applies a whole candidate and reports it once. The group is reported even when the ledger
   * skipped every member, because an empty card is how a no-op candidate stays visible.
   */
  async applyGroup(group: EditGroup, existingRuleKeys: ReadonlySet<string>): Promise<void> {
    const collected: Correction[] = [];
    this.collector = collected;
    try {
      if (group.kind === 'album') {
        this.checkpointAlbum(group.album);
        await this.applyOneAlbum(group.album);
      } else {
        for (const edit of group.edits) this.checkpoint(edit);
        await this.run(group.edits, existingRuleKeys, this.streamed);
      }
    } finally {
      this.collector = null;
    }
    if (collected.length === 0) return;

    await this.reporter.group(
      {
        artist: group.artist,
        kind: group.kind,
        shared: group.shared,
        items: collected,
        outcome: worstOutcome(collected),
        ...(collected.find((c) => c.imageUrl !== undefined)?.imageUrl === undefined
          ? {}
          : { imageUrl: collected.find((c) => c.imageUrl !== undefined)!.imageUrl }),
      },
      this.totalsOf(this.streamed),
    );
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

    const totals = (): RunTotals => this.totalsOf(summary);
    const pending: Correction[] = [];
    const flush = async () => {
      if (pending.length === 0) return;
      await this.emit([...pending], totals());
      pending.length = 0;
    };
    const record = (edit: PlannedEdit, outcome: Outcome, error?: string, imageUrl?: string) => {
      pending.push({
        artist: edit.original.artist_name,
        kind: 'track',
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
        ...(imageUrl === undefined ? {} : { imageUrl }),
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
        const outcome = await this.locked(() => this.editor.apply(edit));
        summary.applied++;
        summary.byKind.track.applied++;
        if (outcome === 'verified') summary.verified++;
        else if (outcome === 'unverified') summary.unverified++;
        this.upsert(edit, outcome === 'applied' ? 'applied' : outcome, 0, null);
        this.opts.onApplied?.(edit.groups, {
          kind: 'track',
          artist: edit.original.artist_name,
          title: edit.original.track_name,
        });
        const art = await this.opts.albumArt?.(
          edit.next.album_artist_name || edit.next.artist_name,
          edit.next.album_name,
        );
        record(edit, outcome, undefined, art);
      } catch (error) {
        summary.failed++;
        summary.byKind.track.failed++;
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
    byKind: {
      track: { applied: 0, failed: 0, tracksCovered: 0, scrobblesCovered: 0 },
      album: { applied: 0, failed: 0, tracksCovered: 0, scrobblesCovered: 0 },
    },
  };
}

/** The card's colour must reflect the worst member, not the last one applied. */
const OUTCOME_RANK: Record<Outcome, number> = {
  verified: 0,
  applied: 1,
  planned: 2,
  unverified: 3,
  failed: 4,
};

function worstOutcome(items: Correction[]): Outcome {
  let worst: Outcome = 'verified';
  for (const item of items) {
    if (OUTCOME_RANK[item.outcome] > OUTCOME_RANK[worst]) worst = item.outcome;
  }
  return worst;
}
