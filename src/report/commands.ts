import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { Approvals } from '../scrub/approvals.js';

export interface CommandDeps {
  db: Db;
  approvals: Approvals;
  approvalMode: boolean;
  dryRun: boolean;
  channelId: string | undefined;
  guildId: string | undefined;
}

export interface CommandReply {
  text: string;
  /** Set when the command needs a yes before it does anything irreversible. */
  confirm?: { customId: string; label: string };
}

export const COMMAND_NAME = 'scrub';

/** Guild-scoped so registration is instant, unlike the hour-long global propagation. */
export const COMMAND_DEFINITION = {
  name: COMMAND_NAME,
  description: 'Inspect and steer the scrubbler',
  options: [
    { type: 1, name: 'status', description: 'Mode, phase, progress and pending count' },
    { type: 1, name: 'stats', description: 'All-time corrections, by kind' },
    { type: 1, name: 'pending', description: 'Proposals awaiting a decision' },
    { type: 1, name: 'approve-all', description: 'Approve every pending proposal' },
    {
      type: 1,
      name: 'ignored',
      description: 'The ignore list',
      options: [{ type: 4, name: 'page', description: '1-based page', required: false }],
    },
    {
      type: 1,
      name: 'unignore',
      description: 'Allow an ignored entity to be proposed again',
      options: [
        { type: 3, name: 'artist', description: 'Artist name', required: true },
        { type: 3, name: 'title', description: 'Track or album title', required: true },
      ],
    },
    { type: 1, name: 'pause', description: 'Stop at the next candidate boundary' },
    { type: 1, name: 'resume', description: 'Carry on sweeping' },
    { type: 1, name: 'resweep', description: 'Clear the scrobble cursor so the next sweep is full' },
    { type: 1, name: 'retry-dead', description: 'Forget the learned-empty candidates' },
  ],
} as const;

const PAGE_SIZE = 15;

export class Commands {
  constructor(private readonly deps: CommandDeps) {}

  handle(sub: string, args: Record<string, string | number> = {}): CommandReply {
    switch (sub) {
      case 'status':
        return { text: this.status() };
      case 'stats':
        return { text: this.stats() };
      case 'pending':
        return { text: this.pendingList() };
      case 'approve-all':
        return this.approveAll();
      case 'ignored':
        return { text: this.ignoredList(Number(args['page'] ?? 1)) };
      case 'unignore':
        return { text: this.unignore(String(args['artist'] ?? ''), String(args['title'] ?? '')) };
      case 'pause':
        return { text: this.setPaused(true) };
      case 'resume':
        return { text: this.setPaused(false) };
      case 'resweep':
        return { text: this.resweep() };
      case 'retry-dead':
        return { text: this.retryDead() };
      default:
        return { text: `Unknown subcommand: ${sub}` };
    }
  }

  private state() {
    return this.deps.db
      .select()
      .from(schema.sweepState)
      .where(eq(schema.sweepState.id, 1))
      .get();
  }

  private countsByStatus(): Map<string, number> {
    const rows = this.deps.db
      .select({
        status: schema.appliedEdits.status,
        n: sql<number>`count(*)`,
      })
      .from(schema.appliedEdits)
      .groupBy(schema.appliedEdits.status)
      .all();
    return new Map(rows.map((r) => [r.status, r.n]));
  }

  status(): string {
    const s = this.state();
    const counts = this.countsByStatus();
    const pending = this.deps.approvals.pending().length;
    const lines = [
      `mode        ${this.deps.approvalMode ? 'approval' : 'unattended'}${this.deps.dryRun ? ' (dry run)' : ''}`,
      `phase       ${s?.phase ?? 'idle'}${s?.paused === true ? ' — PAUSED' : ''}`,
      `progress    ${s?.candidatesDone ?? 0}/${s?.candidatesTotal ?? 0} candidates`,
      `verified    ${counts.get('verified') ?? 0}`,
      `unverified  ${counts.get('unverified') ?? 0}`,
      `failed      ${counts.get('failed') ?? 0}`,
      `pending     ${pending} awaiting approval`,
      `cursor      ${s?.lastScrobbleUts ?? 'none — next sweep is full'}`,
    ];
    return fence(lines);
  }

  /**
   * All-time, not per-run: applied_edits is a durable one-row-per-tuple ledger, so these numbers
   * cover every sweep since the first.
   */
  stats(): string {
    const rows = this.deps.db
      .select({
        kind: schema.appliedEdits.kind,
        status: schema.appliedEdits.status,
        n: sql<number>`count(*)`,
      })
      .from(schema.appliedEdits)
      .groupBy(schema.appliedEdits.kind, schema.appliedEdits.status)
      .all();

    const at = (kind: string, status: string) =>
      rows.find((r) => r.kind === kind && r.status === status)?.n ?? 0;
    const done = (kind: string) => at(kind, 'verified') + at(kind, 'applied');

    const lines = [
      `                albums  tracks`,
      `corrected       ${pad(done('album'))}  ${pad(done('track'))}`,
      `unverified      ${pad(at('album', 'unverified'))}  ${pad(at('track', 'unverified'))}`,
      `failed          ${pad(at('album', 'failed'))}  ${pad(at('track', 'failed'))}`,
      `awaiting        ${pad(at('album', 'awaiting_approval'))}  ${pad(at('track', 'awaiting_approval'))}`,
      `ignored         ${pad(at('album', 'ignored'))}  ${pad(at('track', 'ignored'))}`,
      ``,
      `total corrected ${done('album') + done('track')} since the ledger began`,
    ];
    return fence(lines);
  }

  private pendingList(): string {
    const rows = this.deps.approvals.pending();
    if (rows.length === 0) return 'Nothing awaiting approval.';
    const lines = rows.slice(0, PAGE_SIZE).map((r) => {
      const change =
        r.sharedFrom !== null && r.sharedTo !== null
          ? `${r.sharedFrom} -> ${r.sharedTo}`
          : `${r.itemCount} edit(s)`;
      const jump =
        this.deps.guildId !== undefined && r.channelId !== null && r.messageId !== null
          ? ` https://discord.com/channels/${this.deps.guildId}/${r.channelId}/${r.messageId}`
          : '';
      return `#${r.id} ${r.kind} ${r.artist} — ${change}${jump}`;
    });
    if (rows.length > PAGE_SIZE) lines.push(`… ${rows.length - PAGE_SIZE} more`);
    return lines.join('\n');
  }

  private approveAll(): CommandReply {
    const n = this.deps.approvals.pending().length;
    if (n === 0) return { text: 'Nothing awaiting approval.' };
    return {
      text: `Approve all ${n} pending proposal(s)? Each is applied for real and cannot be undone.`,
      confirm: { customId: 'approve-all:0', label: `Apply all ${n}` },
    };
  }

  private ignoredList(page: number): string {
    const rows = this.deps.db.select().from(schema.ignored).all();
    if (rows.length === 0) return 'The ignore list is empty.';
    const start = Math.max(0, (Math.max(1, page) - 1) * PAGE_SIZE);
    const slice = rows.slice(start, start + PAGE_SIZE);
    if (slice.length === 0) return `Page ${page} is past the end (${rows.length} entries).`;
    const lines = slice.map((r) => `${r.kind} ${r.artist} — ${r.title}`);
    const pages = Math.ceil(rows.length / PAGE_SIZE);
    return fence([...lines, ``, `page ${Math.max(1, page)}/${pages} · ${rows.length} entries`]);
  }

  private unignore(artist: string, title: string): string {
    if (artist === '' || title === '') return 'Both artist and title are required.';
    const before = this.deps.db.select().from(schema.ignored).all().length;
    this.deps.db
      .delete(schema.ignored)
      .where(sql`${schema.ignored.artist} = ${artist} and ${schema.ignored.title} = ${title}`)
      .run();
    const after = this.deps.db.select().from(schema.ignored).all().length;
    if (before === after) return `Not on the ignore list: ${artist} — ${title}`;
    return `Removed ${artist} — ${title}. It can be proposed again on the next sweep.`;
  }

  /** Live, unlike the mode: the worker reads this at every candidate boundary. */
  private setPaused(paused: boolean): string {
    this.deps.db
      .insert(schema.sweepState)
      .values({ id: 1, paused })
      .onConflictDoUpdate({ target: schema.sweepState.id, set: { paused } })
      .run();
    return paused
      ? 'Paused. The current candidate finishes, then nothing new starts.'
      : 'Resumed.';
  }

  private resweep(): string {
    this.deps.db
      .insert(schema.sweepState)
      .values({ id: 1, lastScrobbleUts: null })
      .onConflictDoUpdate({ target: schema.sweepState.id, set: { lastScrobbleUts: null } })
      .run();
    return 'Cursor cleared. The next sweep walks the whole library.';
  }

  private retryDead(): string {
    const n = this.deps.db.select().from(schema.deadCandidates).all().length;
    this.deps.db.delete(schema.deadCandidates).run();
    return `Forgot ${n} learned-empty candidate(s). They will be tried again.`;
  }
}

function pad(n: number): string {
  return String(n).padStart(6);
}

function fence(lines: string[]): string {
  return '```\n' + lines.join('\n') + '\n```';
}
