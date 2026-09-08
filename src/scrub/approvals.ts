import { createHash } from 'node:crypto';
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { AlbumEditor } from '../lastfm/albumEditor.js';
import type { Editor } from '../lastfm/editor.js';
import { COLOR, type DiscordEmbed } from '../report/discord.js';
import {
  type ProposalButton,
  type ProposalTransport,
  approveId,
  ignoreId,
} from '../report/proposals.js';
import { type CorrectionGroup, groupEmbed } from '../report/reporter.js';
import type { Executor, ResumableEdit } from './executor.js';
import { type EditGroup, type PlannedEdit, changedFields, tupleKey } from './types.js';

export interface ApprovalDeps {
  db: Db;
  executor: Executor;
  proposals: ProposalTransport;
  editor?: Editor;
  albumEditor?: AlbumEditor;
  /** Fresh per decision: the token stored at proposal time may be hours old. */
  freshToken: () => Promise<string | undefined>;
  albumArt?: (artist: string, album: string) => Promise<string | undefined>;
  ttlHours: number;
  log?: (msg: string) => void;
}

export type Decision = 'approved' | 'ignored';

export interface DecisionResult {
  outcome: Decision | 'gone' | 'already-decided' | 'stale';
  detail: string;
}

/**
 * Order-independent so a re-swept candidate matches its own pending row, and content-sensitive so a
 * group whose members changed is a different key rather than matching a stale one.
 */
export function groupKeyOf(group: EditGroup): string {
  const keys =
    group.kind === 'album'
      ? [
          tupleKey({
            track_name: '',
            artist_name: '',
            album_name: group.album.from,
            album_artist_name: group.album.artist,
          }),
        ]
      : group.edits.map((e) => tupleKey(e.original)).sort();
  return createHash('sha256').update([group.kind, ...keys].join('|')).digest('hex');
}

export class Approvals {
  constructor(private readonly deps: ApprovalDeps) {}

  private log(msg: string): void {
    (this.deps.log ?? ((m: string) => console.log(m)))(msg);
  }

  /**
   * Three phases, because a button's custom_id needs the row id and the id only exists after the
   * insert. A pending_post row is never actionable and marks no edits, so a failed post strands
   * nothing — the group is simply re-proposed on a later sweep.
   */
  async propose(group: EditGroup): Promise<'proposed' | 'duplicate' | 'post-failed'> {
    const { db, executor, proposals } = this.deps;
    const key = groupKeyOf(group);

    const existing = db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.groupKey, key))
      .get();
    if (existing && (existing.status === 'pending' || existing.status === 'pending_post')) {
      return 'duplicate';
    }
    if (existing) db.delete(schema.approvals).where(eq(schema.approvals.id, existing.id)).run();

    const editIds: number[] = [];
    if (group.kind === 'album') {
      executor.checkpointAlbum(group.album);
      const id = executor.ledgerId({
        track_name: '',
        artist_name: '',
        album_name: group.album.from,
        album_artist_name: group.album.artist,
      });
      if (id !== undefined) editIds.push(id);
    } else {
      for (const edit of group.edits) {
        if (changedFields(edit).length === 0) continue;
        executor.checkpoint(edit);
        const id = executor.ledgerId(edit.original);
        if (id !== undefined) editIds.push(id);
      }
    }
    if (editIds.length === 0) return 'duplicate';

    const shared = group.shared;
    const inserted = db
      .insert(schema.approvals)
      .values({
        groupKey: key,
        artist: group.artist,
        kind: group.kind,
        ...(shared === undefined
          ? {}
          : { sharedField: shared.field, sharedFrom: shared.from, sharedTo: shared.to }),
        itemCount: editIds.length,
        status: 'pending_post',
      })
      .returning({ id: schema.approvals.id })
      .all();
    const approvalId = inserted[0]!.id;

    try {
      const embed = await this.embedFor(group, approvalId);
      const { messageId } = await proposals.postProposal(embed, buttonsFor(approvalId));
      db.update(schema.approvals)
        .set({
          messageId,
          ...(proposals.channelId === undefined ? {} : { channelId: proposals.channelId }),
          status: 'pending',
        })
        .where(eq(schema.approvals.id, approvalId))
        .run();
      db.update(schema.appliedEdits)
        .set({ status: 'awaiting_approval' })
        .where(inArray(schema.appliedEdits.id, editIds))
        .run();
      for (const editId of editIds) {
        db.insert(schema.approvalEdits)
          .values({ approvalId, appliedEditId: editId })
          .onConflictDoNothing()
          .run();
      }
      return 'proposed';
    } catch (error) {
      // Leaves the edits planned, so the next sweep proposes them again.
      db.delete(schema.approvals).where(eq(schema.approvals.id, approvalId)).run();
      this.log(`approval post failed, left ${editIds.length} edit(s) planned: ${String(error)}`);
      return 'post-failed';
    }
  }

  async approve(approvalId: number, userId: string): Promise<DecisionResult> {
    const { db, executor, freshToken } = this.deps;
    const claimed = this.claim(approvalId, 'approved', userId);
    if (claimed.outcome !== 'ok') return claimed;

    const token = await freshToken();
    if (token === undefined) {
      db.update(schema.approvals)
        .set({ status: 'pending', decidedBy: null, decidedAt: null })
        .where(eq(schema.approvals.id, approvalId))
        .run();
      return { outcome: 'stale', detail: 'could not get a Last.fm token; try again' };
    }

    let applied = 0;
    for (const item of this.editsFor(approvalId, token)) {
      db.update(schema.appliedEdits)
        .set({ status: 'planned' })
        .where(eq(schema.appliedEdits.id, item.id))
        .run();
      if (item.kind === 'album') await executor.applyOneAlbum(item.edit);
      else await executor.applyOne(item.edit, new Set());
      applied++;
    }
    await this.retire(approvalId, 'approved');
    return { outcome: 'approved', detail: `${applied} edit(s) applied` };
  }

  async ignore(approvalId: number, userId: string): Promise<DecisionResult> {
    const { db } = this.deps;
    const claimed = this.claim(approvalId, 'ignored', userId);
    if (claimed.outcome !== 'ok') return claimed;

    const ids = this.editIdsFor(approvalId);
    if (ids.length > 0) {
      db.update(schema.appliedEdits)
        .set({ status: 'ignored', lastError: `ignored by ${userId}` })
        .where(inArray(schema.appliedEdits.id, ids))
        .run();
    }
    for (const entity of this.entitiesFor(approvalId, claimed.row.kind)) {
      db.insert(schema.ignored)
        .values({ ...entity, reason: 'rejected in discord', decidedBy: userId })
        .onConflictDoNothing()
        .run();
    }
    await this.retire(approvalId, 'ignored');
    return { outcome: 'ignored', detail: `${ids.length} edit(s) ignored` };
  }

  /**
   * The blocker fix: approval mode must never let the resume path write a carried row without a
   * decision. Called instead of applyCarried, never alongside it.
   */
  async carryOver(): Promise<{ proposed: number; duplicate: number; failed: number }> {
    const carried = this.deps.executor.resumable('carry-over-has-no-token');
    const out = { proposed: 0, duplicate: 0, failed: 0 };
    for (const group of groupCarried(carried)) {
      const result = await this.propose(group);
      if (result === 'proposed') out.proposed++;
      else if (result === 'duplicate') out.duplicate++;
      else out.failed++;
    }
    return out;
  }

  /** An unattended write landing on a proposed tuple must not leave live buttons behind. */
  async supersede(editIds: number[]): Promise<number> {
    const { db } = this.deps;
    if (editIds.length === 0) return 0;
    const links = db
      .select()
      .from(schema.approvalEdits)
      .where(inArray(schema.approvalEdits.appliedEditId, editIds))
      .all();
    let count = 0;
    for (const id of [...new Set(links.map((l) => l.approvalId))]) {
      const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
      if (!row || row.status !== 'pending') continue;
      db.update(schema.approvals)
        .set({ status: 'superseded', decidedAt: new Date(), decidedBy: 'system' })
        .where(eq(schema.approvals.id, id))
        .run();
      await this.retire(id, 'superseded');
      count++;
    }
    return count;
  }

  /**
   * Incremental discovery only sees new scrobbles, so pending entities would otherwise wait for the
   * weekly full sweep after the mode is switched off. Corrects them by the ordinary path instead.
   */
  async drainOnModeOff(): Promise<number> {
    const { db, executor, freshToken } = this.deps;
    const pending = this.pending();
    if (pending.length === 0) return 0;

    const token = await freshToken();
    if (token === undefined) {
      this.log(`approval mode is off but no token was available to drain ${pending.length}`);
      return 0;
    }

    let drained = 0;
    for (const row of pending) {
      for (const item of this.editsFor(row.id, token)) {
        db.update(schema.appliedEdits)
          .set({ status: 'planned' })
          .where(eq(schema.appliedEdits.id, item.id))
          .run();
        if (item.kind === 'album') await executor.applyOneAlbum(item.edit);
        else await executor.applyOne(item.edit, new Set());
      }
      db.update(schema.approvals)
        .set({ status: 'superseded', decidedAt: new Date(), decidedBy: 'system' })
        .where(eq(schema.approvals.id, row.id))
        .run();
      await this.retire(row.id, 'superseded');
      drained++;
    }
    return drained;
  }

  /** Expired entities are re-proposed later, never ignored: an unread week must not discard work. */
  async expire(now = new Date()): Promise<number> {
    const { db, ttlHours } = this.deps;
    const cutoff = new Date(now.getTime() - ttlHours * 3600_000);
    const stale = db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.status, 'pending'), lt(schema.approvals.createdAt, cutoff)))
      .all();
    for (const row of stale) {
      const ids = this.editIdsFor(row.id);
      if (ids.length > 0) {
        db.update(schema.appliedEdits)
          .set({ status: 'planned' })
          .where(inArray(schema.appliedEdits.id, ids))
          .run();
      }
      db.update(schema.approvals)
        .set({ status: 'expired', decidedAt: now })
        .where(eq(schema.approvals.id, row.id))
        .run();
      await this.retire(row.id, 'expired');
    }
    return stale.length;
  }

  pending(): (typeof schema.approvals.$inferSelect)[] {
    return this.deps.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.status, 'pending'))
      .all();
  }

  async approveAll(userId: string): Promise<{ approved: number; failed: number }> {
    const out = { approved: 0, failed: 0 };
    for (const row of this.pending()) {
      const result = await this.approve(row.id, userId);
      if (result.outcome === 'approved') out.approved++;
      else out.failed++;
    }
    return out;
  }

  /**
   * Marks the row decided before any slow work, so a second click inside the ~20s apply window
   * finds it already claimed instead of applying twice.
   */
  private claim(
    approvalId: number,
    to: Decision,
    userId: string,
  ):
    | { outcome: 'ok'; row: typeof schema.approvals.$inferSelect }
    | { outcome: 'gone' | 'already-decided'; detail: string } {
    const { db } = this.deps;
    const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)).get();
    if (!row) return { outcome: 'gone', detail: 'that proposal no longer exists' };
    if (row.status !== 'pending') {
      return { outcome: 'already-decided', detail: `already ${row.status}` };
    }
    db.update(schema.approvals)
      .set({ status: to, decidedBy: userId, decidedAt: new Date() })
      .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.status, 'pending')))
      .run();
    return { outcome: 'ok', row };
  }

  private editIdsFor(approvalId: number): number[] {
    return this.deps.db
      .select()
      .from(schema.approvalEdits)
      .where(eq(schema.approvalEdits.approvalId, approvalId))
      .all()
      .map((r) => r.appliedEditId);
  }

  private editsFor(approvalId: number, token: string): ResumableEdit[] {
    const ids = new Set(this.editIdsFor(approvalId));
    return this.deps.executor
      .resumable(token, 'awaiting_approval')
      .filter((item) => ids.has(item.id));
  }

  private entitiesFor(
    approvalId: number,
    kind: 'track' | 'album',
  ): { kind: 'track' | 'album'; artist: string; title: string }[] {
    const ids = this.editIdsFor(approvalId);
    if (ids.length === 0) return [];
    const rows = this.deps.db
      .select()
      .from(schema.appliedEdits)
      .where(inArray(schema.appliedEdits.id, ids))
      .all();
    const out = new Map<string, { kind: 'track' | 'album'; artist: string; title: string }>();
    for (const r of rows) {
      const entity =
        kind === 'album'
          ? {
              kind: 'album' as const,
              artist: r.albumArtistNameOriginal,
              title: r.albumNameOriginal,
            }
          : { kind: 'track' as const, artist: r.artistNameOriginal, title: r.trackNameOriginal };
      out.set(`${entity.kind} ${entity.artist} ${entity.title}`, entity);
    }
    return [...out.values()];
  }

  /** Best effort: the decision is already durable, so a failed edit costs only a stale card. */
  private async retire(
    approvalId: number,
    outcome: 'approved' | 'ignored' | 'expired' | 'superseded',
  ): Promise<void> {
    const { db, proposals } = this.deps;
    const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)).get();
    if (!row || row.messageId === null) return;
    try {
      await proposals.editMessage(row.messageId, retiredEmbed(row, outcome), []);
    } catch (error) {
      this.log(`could not retire approval ${approvalId}: ${String(error)}`);
    }
  }

  private async embedFor(group: EditGroup, approvalId: number): Promise<DiscordEmbed> {
    const items: CorrectionGroup['items'] =
      group.kind === 'album'
        ? [
            {
              artist: group.album.artist,
              kind: 'album',
              track: '(whole album)',
              album: group.album.from,
              changes: [{ field: 'album_name', from: group.album.from, to: group.album.to }],
              groups: group.album.groups,
              outcome: 'planned',
            },
          ]
        : group.edits.map((edit) => ({
            artist: edit.original.artist_name,
            kind: 'track' as const,
            track: edit.original.track_name,
            album: edit.original.album_name,
            changes: changedFields(edit).map((f) => ({
              field: f,
              from: edit.original[f],
              to: edit.next[f],
            })),
            groups: edit.groups,
            outcome: 'planned' as const,
          }));

    const art = await artFor(group, this.deps.albumArt);
    const embed = groupEmbed(
      {
        artist: group.artist,
        kind: group.kind,
        shared: group.shared,
        items,
        outcome: 'planned',
        ...(art === undefined ? {} : { imageUrl: art }),
      },
      `awaiting approval · #${approvalId}`,
    );
    return { ...embed, title: embed.title.replace(/^Would correct/, 'Approve'), color: COLOR.warn };
  }
}

async function artFor(
  group: EditGroup,
  albumArt: ApprovalDeps['albumArt'],
): Promise<string | undefined> {
  if (albumArt === undefined) return undefined;
  const [artist, album] =
    group.kind === 'album'
      ? [group.album.artist, group.album.to]
      : [
          group.edits[0]?.next.album_artist_name || group.edits[0]?.next.artist_name || '',
          group.edits[0]?.next.album_name ?? '',
        ];
  if (artist === '' || album === '') return undefined;
  return await albumArt(artist, album).catch(() => undefined);
}

export function buttonsFor(approvalId: number): ProposalButton[] {
  return [
    { customId: approveId(approvalId), label: 'Apply', style: 3 },
    { customId: ignoreId(approvalId), label: 'Never', style: 4 },
  ];
}

const RETIRED_WORD = {
  approved: 'Applied',
  ignored: 'Ignored — will not be proposed again',
  expired: 'Expired unanswered — will be proposed again',
  superseded: 'Applied by the unattended sweep',
} as const;

const RETIRED_COLOR = {
  approved: COLOR.done,
  ignored: COLOR.dryRun,
  expired: COLOR.warn,
  superseded: COLOR.applied,
} as const;

function retiredEmbed(
  row: typeof schema.approvals.$inferSelect,
  outcome: keyof typeof RETIRED_WORD,
): DiscordEmbed {
  const subject =
    row.sharedFrom !== null && row.sharedTo !== null
      ? `${row.sharedFrom} → ${row.sharedTo}`
      : `${row.itemCount} edit(s)`;
  const by = row.decidedBy === 'system' ? 'the sweep' : row.decidedBy;
  return {
    title: RETIRED_WORD[outcome],
    color: RETIRED_COLOR[outcome],
    description: `**${row.artist}**\n${subject}`,
    footer: { text: by === null ? `#${row.id}` : `#${row.id} · by ${by}` },
  };
}

/** Carried rows have no candidate context, so each tuple stands alone rather than faking a group. */
function groupCarried(carried: ResumableEdit[]): EditGroup[] {
  return carried.map((item) =>
    item.kind === 'album'
      ? {
          kind: 'album' as const,
          artist: item.edit.artist,
          album: item.edit,
          shared: { field: 'album_name' as const, from: item.edit.from, to: item.edit.to },
        }
      : trackGroupOf(item.edit),
  );
}

function trackGroupOf(edit: PlannedEdit): EditGroup {
  const fields = changedFields(edit);
  const only = fields.length === 1 ? fields[0]! : undefined;
  return {
    kind: 'track',
    artist: edit.original.artist_name,
    edits: [edit],
    shared:
      only === undefined
        ? undefined
        : { field: only, from: edit.original[only], to: edit.next[only] },
  };
}
