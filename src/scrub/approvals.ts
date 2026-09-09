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
  stripId,
} from '../report/proposals.js';
import { type CorrectionGroup, type Links, groupEmbed } from '../report/reporter.js';
import type { Executor, ResumableEdit } from './executor.js';
import { type NormalizeAction, cleanTitle } from '../rules/engine.js';
import type { CustomRuleLookup } from '../rules/customRules.js';
import { DASH_NORMALIZED, type GroupName, type Tier, isGroupName } from '../rules/markers.js';
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
  /** Same library links the reports use, so a proposal and its correction read alike. */
  links?: Links;
  /**
   * Answers whether the entity is still in the library under its original title. A proposal can
   * sit for a week, and firing a write whose *_original tuple no longer matches silently no-ops.
   */
  stillThere?: (item: ResumableEdit) => Promise<boolean>;
  ttlHours: number;
  /** Needed to re-derive an edit when a decision asks for a different answer than the one proposed. */
  enabledGroups: () => ReadonlySet<GroupName>;
  tiers: () => Readonly<Record<GroupName, Tier>>;
  overrides?: CustomRuleLookup;
  log?: (msg: string) => void;
}

export type Decision = 'approved' | 'ignored';

export interface DecisionResult {
  outcome: Decision | 'gone' | 'already-decided' | 'stale' | 'no-op' | 'discarded';
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

/** resumable() bakes its token into each edit; proposing never POSTs, so it needs no real one. */
export const CARRY_OVER_TOKEN = 'carry-over-has-no-token';

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
      const { messageId } = await proposals.postProposal(embed, buttonsFor(approvalId, groupTags(group)));
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
    return await this.decide(approvalId, userId, 'rewrite');
  }

  /** Applies the same edit the card proposed, but with the live label removed rather than rewritten. */
  async strip(approvalId: number, userId: string): Promise<DecisionResult> {
    return await this.decide(approvalId, userId, 'strip');
  }

  private async decide(
    approvalId: number,
    userId: string,
    action: NormalizeAction,
  ): Promise<DecisionResult> {
    const { db, executor, freshToken } = this.deps;
    const claimed = this.claim(approvalId, 'approved', userId);
    if (claimed.outcome !== 'ok') return claimed;

    if (action === 'strip' && this.proposalTier(approvalId) === 'off') {
      await this.releaseAndRetire(approvalId);
      return {
        outcome: 'discarded',
        detail: 'that rule is switched off; the proposal has been discarded',
      };
    }

    const token = await freshToken();
    if (token === undefined) {
      db.update(schema.approvals)
        .set({ status: 'pending', decidedBy: null, decidedAt: null })
        .where(eq(schema.approvals.id, approvalId))
        .run();
      return { outcome: 'stale', detail: 'could not get a Last.fm token; try again' };
    }

    const items = this.editsFor(approvalId, token);
    // Recomputed before any ledger status moves: a row left `planned` is written with no approval.
    const rebuilt = action === 'strip' ? this.strippedEdits(items) : new Map<number, ResumableEdit>();
    if (action === 'strip' && rebuilt.size === 0) {
      db.update(schema.approvals)
        .set({ status: 'pending', decidedBy: null, decidedAt: null })
        .where(eq(schema.approvals.id, approvalId))
        .run();
      return { outcome: 'no-op', detail: 'nothing to remove — the label is not there to strip' };
    }

    let applied = 0;
    let stale = 0;
    for (const item of items) {
      const toApply = action === 'strip' ? rebuilt.get(item.id) : item;
      if (toApply === undefined) {
        stale++;
        continue;
      }
      if (this.deps.stillThere !== undefined && !(await this.deps.stillThere(item))) {
        db.update(schema.appliedEdits)
          .set({ status: 'skipped', lastError: 'changed before approval' })
          .where(eq(schema.appliedEdits.id, item.id))
          .run();
        stale++;
        continue;
      }
      db.update(schema.appliedEdits)
        .set({ status: 'planned' })
        .where(eq(schema.appliedEdits.id, item.id))
        .run();
      if (action === 'strip') {
        if (toApply.kind === 'album') executor.checkpointAlbum(toApply.edit);
        else executor.checkpoint(toApply.edit);
      }
      if (toApply.kind === 'album') await executor.applyOneAlbum(toApply.edit);
      else await executor.applyOne(toApply.edit, new Set());
      applied++;
    }
    if (action === 'strip') this.syncStrippedSubject(approvalId, rebuilt);
    await this.retire(approvalId, 'approved', action === 'strip' ? 'stripped' : undefined);
    return {
      outcome: 'approved',
      detail:
        stale === 0
          ? `${applied} edit(s) applied`
          : `${applied} applied, ${stale} changed since the proposal and were skipped`,
    };
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
   * A carried row belonging to a gated rule must never be written without a decision. Proposing
   * needs no CSRF token, hence the sentinel — and because proposing moves these rows to
   * `awaiting_approval`, a later resumable() cannot see them. Never runs for the *same row* as
   * applyCarried; both may run in one cycle when tiers are mixed.
   */
  async carryOver(
    rows?: ResumableEdit[],
  ): Promise<{ proposed: number; duplicate: number; failed: number }> {
    const carried = rows ?? this.deps.executor.resumable(CARRY_OVER_TOKEN);
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

  async drainOnTierChange(
    tiers: Readonly<Record<GroupName, Tier>>,
  ): Promise<{ applied: number; retired: number; kept: number }> {
    const { db, executor, freshToken } = this.deps;
    const pending = this.pending();
    const out = { applied: 0, retired: 0, kept: 0 };
    if (pending.length === 0) return out;

    let token: string | undefined;

    for (const row of pending) {
      const tier = this.proposalTier(row.id, tiers);
      if (tier === 'gated') {
        out.kept++;
        continue;
      }
      if (tier === 'off') {
        await this.releaseAndRetire(row.id);
        out.retired++;
        continue;
      }
      token ??= await freshToken();
      if (token === undefined) {
        this.log(`could not drain pending proposal ${row.id}: no Last.fm token was available`);
        out.kept++;
        continue;
      }
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
      out.applied++;
    }
    return out;
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

  /** Pending proposals carrying `rule`, so a count can be shown before anything is dropped. */
  reproposable(rule: GroupName): (typeof schema.approvals.$inferSelect)[] {
    return this.pending().filter((row) => this.groupsFor(row.id).includes(rule));
  }

  /**
   * Drops the outstanding proposals for one rule so a later sweep re-resolves them under the rule's
   * current meaning. Deletes the ledger rows rather than re-statusing them: `checkpoint` refuses to
   * refresh a row that is not `planned`, and a `planned` row is re-proposed straight from the ledger
   * by `carryOver`, so either status would re-post the target the card already showed.
   *
   * Safe to run against a live service, unlike `deploy/repropose-stale.mjs` reaching the same rows
   * from outside the process: `releaseAndRetire` supersedes each row in one synchronous transaction,
   * and a click that arrives afterwards fails its `claim` instead of writing.
   */
  async repropose(rule: GroupName): Promise<number> {
    const rows = this.reproposable(rule);
    for (const row of rows) await this.releaseAndRetire(row.id);
    return rows.length;
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

  /**
   * Every item that still yields an edit once the live label is removed instead of rewritten, keyed
   * by ledger id. An item whose recomputation leaves the title unchanged is absent, and an empty map
   * means there is nothing to strip at all.
   */
  private strippedEdits(items: ResumableEdit[]): Map<number, ResumableEdit> {
    const { enabledGroups, overrides } = this.deps;
    const opts = { normalizeAction: 'strip' as NormalizeAction };
    const lookup = (artist: string) =>
      overrides === undefined ? undefined : { artist, lookup: overrides };
    const out = new Map<number, ResumableEdit>();

    for (const item of items) {
      if (item.kind === 'album') {
        const album = cleanTitle(
          item.edit.from,
          'album',
          enabledGroups(),
          lookup(item.edit.artist),
          opts,
        );
        if (album === null) continue;
        out.set(item.id, { ...item, edit: { ...item.edit, to: album.clean } });
        continue;
      }

      const { original } = item.edit;
      const track = cleanTitle(
        original.track_name,
        'track',
        enabledGroups(),
        lookup(original.artist_name),
        opts,
      );
      const album =
        original.album_name === ''
          ? null
          : cleanTitle(
              original.album_name,
              'album',
              enabledGroups(),
              lookup(original.album_artist_name || original.artist_name),
              opts,
            );
      if (track === null && album === null) continue;
      const next = {
        ...original,
        track_name: track?.clean ?? original.track_name,
        album_name: album?.clean ?? original.album_name,
      };
      out.set(item.id, { ...item, edit: { ...item.edit, next } });
    }

    return out;
  }

  /**
   * `retiredEmbed` renders the subject from the approval row, not from the edit, so a stripped card
   * would otherwise say the label was removed above the rewrite it was proposed as.
   */
  private syncStrippedSubject(approvalId: number, rebuilt: Map<number, ResumableEdit>): void {
    const { db } = this.deps;
    const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)).get();
    if (!row || row.sharedTo === null || row.sharedField === null) return;
    const first = [...rebuilt.values()][0];
    if (first === undefined) return;
    const to =
      first.kind === 'album'
        ? first.edit.to
        : first.edit.next[row.sharedField as keyof typeof first.edit.next];
    if (typeof to !== 'string' || to === row.sharedTo) return;
    db.update(schema.approvals)
      .set({ sharedTo: to })
      .where(eq(schema.approvals.id, approvalId))
      .run();
  }

  private editsFor(approvalId: number, token: string): ResumableEdit[] {
    const ids = new Set(this.editIdsFor(approvalId));
    return this.deps.executor
      .resumable(token, 'awaiting_approval')
      .filter((item) => ids.has(item.id));
  }

  private proposalTier(
    approvalId: number,
    tiers: Readonly<Record<GroupName, Tier>> = this.deps.tiers(),
  ): Tier {
    const groups = this.groupsFor(approvalId);
    if (groups.some((group) => tiers[group] === 'off')) return 'off';
    if (groups.some((group) => tiers[group] === 'gated')) return 'gated';
    return 'auto';
  }

  private groupsFor(approvalId: number): GroupName[] {
    const ids = this.editIdsFor(approvalId);
    if (ids.length === 0) return [];
    const rows = this.deps.db
      .select({ groups: schema.appliedEdits.groups })
      .from(schema.appliedEdits)
      .where(inArray(schema.appliedEdits.id, ids))
      .all();
    const groups = new Set<GroupName>();
    for (const row of rows) {
      for (const group of row.groups.split(',')) if (isGroupName(group)) groups.add(group);
    }
    return [...groups];
  }

  private async releaseAndRetire(approvalId: number): Promise<void> {
    const { db } = this.deps;
    const ids = this.editIdsFor(approvalId);
    db.transaction((tx) => {
      tx.update(schema.approvals)
        .set({ status: 'superseded', decidedAt: new Date(), decidedBy: 'system' })
        .where(eq(schema.approvals.id, approvalId))
        .run();
      tx.delete(schema.approvalEdits)
        .where(eq(schema.approvalEdits.approvalId, approvalId))
        .run();
      if (ids.length > 0) {
        tx.delete(schema.appliedEdits).where(inArray(schema.appliedEdits.id, ids)).run();
      }
    });
    await this.retire(approvalId, 'superseded', 'discarded');
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
    word?: keyof typeof EXTRA_RETIRED_WORD,
  ): Promise<void> {
    const { db, proposals } = this.deps;
    const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)).get();
    if (!row || row.messageId === null) return;
    try {
      await proposals.editMessage(row.messageId, retiredEmbed(row, outcome, word), []);
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
      this.deps.links,
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

/**
 * Strip only appears for a rule that *rewrites* a segment, because that is the only case where
 * "remove it entirely" is a third outcome — where the proposal is already a removal, Apply is it.
 */
/** Every rule tag across a group's members, which is what decides whether Strip is offered. */
function groupTags(group: EditGroup): string[] {
  return group.kind === 'album' ? group.album.groups : group.edits.flatMap((e) => e.groups);
}

export function buttonsFor(approvalId: number, groups: readonly string[] = []): ProposalButton[] {
  const rewrites = groups.some((g) => isGroupName(g) && DASH_NORMALIZED[g] !== undefined);
  return [
    { customId: approveId(approvalId), label: 'Apply', style: 3 },
    ...(rewrites ? [{ customId: stripId(approvalId), label: 'Strip', style: 2 as const }] : []),
    { customId: ignoreId(approvalId), label: 'Never', style: 4 },
  ];
}

/** A decision that applied something other than what the card proposed still retires as approved. */
const EXTRA_RETIRED_WORD = {
  stripped: 'Applied — label removed',
  discarded: 'Discarded — rule switched off',
} as const;

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
  word?: keyof typeof EXTRA_RETIRED_WORD,
): DiscordEmbed {
  const subject =
    row.sharedFrom !== null && row.sharedTo !== null
      ? `${row.sharedFrom} → ${row.sharedTo}`
      : `${row.itemCount} edit(s)`;
  const by = row.decidedBy === 'system' ? 'the sweep' : row.decidedBy;
  return {
    title: word === undefined ? RETIRED_WORD[outcome] : EXTRA_RETIRED_WORD[word],
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
