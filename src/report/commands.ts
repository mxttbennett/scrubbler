import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { Approvals } from '../scrub/approvals.js';
import { RuleRejected, type CustomRules } from '../rules/customRules.js';
import { ALL_GROUPS, type Field } from '../rules/markers.js';
import type { ShadowStore } from '../scrub/shadowStore.js';
import { readPackageVersion } from '../core/version.js';

export interface CommandDeps {
  db: Db;
  approvals: Approvals;
  customRules: CustomRules;
  /**
   * Resolves and applies one named entity now. A new rule cannot be discovered until the next full
   * sweep, which is weekly, so without this the command would appear to do nothing.
   */
  applyNow: (rule: { kind: Field; artist: string; fromTitle: string }) => Promise<string>;
  /** Any rule at the `gated` tier — a proposal can exist without the legacy global. */
  gatedRules: ReadonlySet<string>;
  dryRun: boolean;
  shadowStore: ShadowStore;
  shadowMode: boolean;
  /** So an already-enabled rule is answered honestly rather than shown as an empty list. */
  enabledRules: ReadonlySet<string>;
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
    {
      type: 1,
      name: 'replace',
      description: 'Replace a title the rule catalogue cannot express',
      options: [
        {
          type: 3,
          name: 'kind',
          description: 'track or album',
          required: true,
          choices: [
            { name: 'track', value: 'track' },
            { name: 'album', value: 'album' },
          ],
        },
        { type: 3, name: 'artist', description: 'Artist name, exactly as scrobbled', required: true },
        { type: 3, name: 'from', description: 'The current title', required: true },
        { type: 3, name: 'to', description: 'What it should be', required: true },
      ],
    },
    { type: 1, name: 'rules', description: 'The custom replacements you have set' },
    {
      type: 1,
      name: 'unrule',
      description: 'Remove a custom replacement',
      options: [
        {
          type: 3,
          name: 'kind',
          description: 'track or album',
          required: true,
          choices: [
            { name: 'track', value: 'track' },
            { name: 'album', value: 'album' },
          ],
        },
        { type: 3, name: 'artist', description: 'Artist name', required: true },
        { type: 3, name: 'from', description: 'The current title', required: true },
      ],
    },
    {
      type: 1,
      name: 'shadow',
      description: 'What a rule that is off would have caught',
      options: [
        {
          type: 3,
          name: 'rule',
          description: 'Limit to one rule',
          required: false,
          choices: ALL_GROUPS.map((g) => ({ name: g, value: g })),
        },
        { type: 4, name: 'page', description: '1-based page', required: false },
      ],
    },
    {
      type: 1,
      name: 'shadow-clear',
      description: 'Forget recorded shadow hits so they are announced again',
      options: [
        {
          type: 3,
          name: 'rule',
          description: 'Limit to one rule',
          required: false,
          choices: ALL_GROUPS.map((g) => ({ name: g, value: g })),
        },
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

  async handle(
    sub: string,
    args: Record<string, string | number> = {},
  ): Promise<CommandReply> {
    switch (sub) {
      case 'status':
        return { text: this.status() };
      case 'stats':
        return { text: this.stats() };
      case 'pending':
      case 'approve-all': {
        const off = this.requireApprovalMode();
        if (off !== undefined) return { text: off };
        return sub === 'pending' ? { text: this.pendingList() } : this.approveAll();
      }
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
      case 'replace':
        return { text: await this.replace(args) };
      case 'rules':
        return { text: this.rulesList() };
      case 'unrule':
        return { text: this.unrule(args) };
      case 'shadow':
        return { text: this.shadowList(args) };
      case 'shadow-clear':
        return { text: this.shadowClear(args) };
      case 'retry-dead':
        return { text: this.retryDead() };
      default:
        return { text: `Unknown subcommand: ${sub}` };
    }
  }

  /**
   * Replies rather than hiding: the command list is the same in both modes, so a missing command
   * would read as a broken bot instead of a mode that is off.
   */
  /** Groups by tier, so the answer to "why is this not being corrected?" is on the status card. */
  private tierLine(): string {
    const gated = [...this.deps.gatedRules].sort();
    const auto = [...this.deps.enabledRules].filter((r) => !this.deps.gatedRules.has(r)).sort();
    return (
      `${auto.length} auto${auto.length > 0 ? ` (${auto.join(', ')})` : ''}` +
      `, ${gated.length} gated${gated.length > 0 ? ` (${gated.join(', ')})` : ''}`
    );
  }

  private requireApprovalMode(): string | undefined {
    if (this.deps.gatedRules.size > 0) return undefined;
    const pending = this.deps.approvals.pending().length;
    return (
      'No rule is gated — corrections apply unattended, so there is nothing to approve.' +
      (pending > 0
        ? ` ${pending} proposal(s) are still queued from an earlier run; the next sweep drains them.`
        : ' Set a rule to `gated` in RULES and restart to turn it on.')
    );
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
      `version     ${readPackageVersion()}`,
      `mode        ${this.deps.gatedRules.size > 0 ? 'approval' : 'unattended'}${this.deps.dryRun ? ' (dry run)' : ''}`,
      `rules       ${this.tierLine()}`,
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

  private static kindOf(raw: unknown): Field | undefined {
    return raw === 'track' || raw === 'album' ? raw : undefined;
  }

  private async replace(args: Record<string, string | number>): Promise<string> {
    const kind = Commands.kindOf(args['kind']);
    if (kind === undefined) return 'kind must be track or album.';

    const state = this.state();
    // The apply is a real write; running it against a paused service would contradict the pause.
    if (state?.paused === true) {
      return 'The service is paused. Run /scrub resume first, or the rule cannot be applied.';
    }

    const artist = String(args['artist'] ?? '');
    const fromTitle = String(args['from'] ?? '');
    const toTitle = String(args['to'] ?? '');

    let rule;
    try {
      rule = this.deps.customRules.add({ kind, artist, fromTitle, toTitle });
    } catch (error) {
      if (error instanceof RuleRejected) return error.message;
      throw error;
    }

    const outcome = await this.deps.applyNow({
      kind: rule.kind,
      artist: rule.artist,
      fromTitle: rule.fromTitle,
    });
    return (
      `Rule saved: ${rule.kind} "${rule.fromTitle}" by ${rule.artist} -> "${rule.toTitle}".\n` +
      `${outcome}\nIt will also be applied to anything else matching on the next full sweep.`
    );
  }

  private rulesList(): string {
    const rules = this.deps.customRules.list();
    if (rules.length === 0) return 'No custom replacements set.';
    const lines = rules.slice(0, PAGE_SIZE).map((r) => {
      const applied = r.timesApplied === 0 ? 'never applied' : `applied ${r.timesApplied}x`;
      return `${r.kind} ${r.artist}\n  "${r.fromTitle}"\n  -> "${r.toTitle}"  (${applied})`;
    });
    if (rules.length > PAGE_SIZE) lines.push(`… ${rules.length - PAGE_SIZE} more`);
    return fence(lines);
  }

  private unrule(args: Record<string, string | number>): string {
    const kind = Commands.kindOf(args['kind']);
    if (kind === undefined) return 'kind must be track or album.';
    const artist = String(args['artist'] ?? '');
    const fromTitle = String(args['from'] ?? '');
    if (artist === '' || fromTitle === '') return 'Both artist and the current title are required.';

    const removed = this.deps.customRules.remove(kind, artist, fromTitle);
    return removed
      ? `Removed the ${kind} rule for ${artist} — "${fromTitle}".`
      : `No ${kind} rule for ${artist} — "${fromTitle}".`;
  }

  private shadowList(args: Record<string, string | number>): string {
    const raw = args['rule'] === undefined ? undefined : String(args['rule']);
    if (raw !== undefined && !ALL_GROUPS.includes(raw as never)) {
      return `\`${raw}\` is not a rule. Try: ${ALL_GROUPS.join(', ')}`;
    }
    if (raw !== undefined && this.deps.enabledRules.has(raw)) {
      // Shadow rows only exist for rules that are off, so an empty list would read as "clean".
      return `\`${raw}\` is not off, so it corrects for real and records no shadow hits.`;
    }

    const rows = this.deps.shadowStore.list(raw);
    if (rows.length === 0) {
      return this.deps.shadowMode
        ? 'Nothing recorded yet. A full sweep is what finds these.'
        : 'Shadow mode is off. Set SHADOW_MODE=true and restart to start recording.';
    }

    const page = Math.max(1, Number(args['page'] ?? 1));
    const start = (page - 1) * PAGE_SIZE;
    const slice = rows.slice(start, start + PAGE_SIZE);
    if (slice.length === 0) return `Page ${page} is past the end (${rows.length} entries).`;

    const counts = this.deps.shadowStore
      .countsByRule()
      .map((c) => `${c.rule} ${c.n}`)
      .join(' · ');
    const lines = slice.map(
      (r) => `[${r.rule}] ${r.kind} ${r.artist} — "${r.title}"\n  -> "${r.wouldBe}"`,
    );
    const pages = Math.ceil(rows.length / PAGE_SIZE);
    return fence([...lines, ``, `page ${page}/${pages} · ${counts}`]);
  }

  private shadowClear(args: Record<string, string | number>): string {
    const raw = args['rule'] === undefined ? undefined : String(args['rule']);
    const before = this.deps.shadowStore.list(raw).length;
    this.deps.db
      .delete(schema.shadowHits)
      .where(raw === undefined ? undefined : eq(schema.shadowHits.rule, raw))
      .run();
    return `Forgot ${before} shadow hit(s)${raw === undefined ? '' : ` for ${raw}`}. They will be announced again.`;
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
