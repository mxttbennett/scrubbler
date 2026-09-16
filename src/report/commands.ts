import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { Approvals } from '../scrub/approvals.js';
import { RuleRejected, type CustomRules } from '../rules/customRules.js';
import { ALL_GROUPS, type Field, isGroupName } from '../rules/markers.js';
import { reproposeId } from './proposals.js';
import { clearCursor, clearDead, clearShadow, isResetTarget } from '../scrub/resets.js';
import type { ShadowStore } from '../scrub/shadowStore.js';
import { readPackageVersion } from '../core/version.js';

type RuleSet = ReadonlySet<string> | (() => ReadonlySet<string>);

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
  gatedRules: RuleSet;
  dryRun: boolean;
  shadowStore: ShadowStore;
  shadowMode: boolean;
  /** So an already-enabled rule is answered honestly rather than shown as an empty list. */
  enabledRules: RuleSet;
  configPanel?: { handle(customId?: string): { content: string; components: unknown[] } };
  overridesPanel?: { handle(customId?: string): { content: string; components: unknown[] } };
  channelId: string | undefined;
  guildId: string | undefined;
}

export interface CommandReply {
  text: string;
  components?: unknown[];
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
    { type: 1, name: 'config', description: 'Rule tiers and pause state' },
    {
      type: 1,
      name: 'pending',
      description: 'Proposals awaiting a decision',
      options: [{ type: 4, name: 'page', description: '1-based page', required: false }],
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
      name: 'overrides',
      description: 'The replacements and ignores you have set, with remove buttons',
    },
    {
      type: 1,
      name: 'reset',
      description: 'Forget derived state so the service works it out again',
      options: [
        {
          type: 3,
          name: 'target',
          description: 'What to forget',
          required: true,
          choices: [
            { name: 'cursor — re-sweep the whole library', value: 'cursor' },
            { name: 'dead — retry candidates that resolved to nothing', value: 'dead' },
            { name: 'proposals — drop one rule’s pending proposals', value: 'proposals' },
            { name: 'shadow — announce recorded shadow hits again', value: 'shadow' },
          ],
        },
        {
          type: 3,
          name: 'rule',
          description: 'Required for proposals, optional for shadow',
          required: false,
          choices: ALL_GROUPS.map((g) => ({ name: g, value: g })),
        },
      ],
    },
  ],
} as const;

const PAGE_SIZE = 15;

export class Commands {
  constructor(private readonly deps: CommandDeps) {}

  private enabledRules(): ReadonlySet<string> {
    return typeof this.deps.enabledRules === 'function'
      ? this.deps.enabledRules()
      : this.deps.enabledRules;
  }

  private gatedRules(): ReadonlySet<string> {
    return typeof this.deps.gatedRules === 'function' ? this.deps.gatedRules() : this.deps.gatedRules;
  }

  async handle(
    sub: string,
    args: Record<string, string | number> = {},
  ): Promise<CommandReply> {
    switch (sub) {
      case 'status':
        return { text: this.status() };
      case 'config':
        return this.configPanel();
      case 'pending': {
        const off = this.requireApprovalMode();
        if (off !== undefined) return { text: off };
        return this.pending(Number(args['page'] ?? 1));
      }
      case 'replace':
        return { text: await this.replace(args) };
      case 'overrides':
        return this.overrides();
      case 'shadow':
        return { text: this.shadowList(args) };
      case 'reset':
        return this.reset(args);
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
    const gatedRules = this.gatedRules();
    const gated = [...gatedRules].sort();
    const auto = [...this.enabledRules()].filter((r) => !gatedRules.has(r)).sort();
    return (
      `${auto.length} auto${auto.length > 0 ? ` (${auto.join(', ')})` : ''}` +
      `, ${gated.length} gated${gated.length > 0 ? ` (${gated.join(', ')})` : ''}`
    );
  }

  private requireApprovalMode(): string | undefined {
    if (this.gatedRules().size > 0) return undefined;
    const pending = this.deps.approvals.pending().length;
    return (
      'No rule is gated — corrections apply unattended, so there is nothing to approve.' +
      (pending > 0
        ? ` ${pending} proposal(s) are still queued from an earlier run; the next sweep drains them.`
        : ' Set a rule to `gated` in RULES and restart to turn it on.')
    );
  }

  private overrides(): CommandReply {
    const panel = this.deps.overridesPanel;
    if (panel === undefined) return { text: 'Overrides panel is not available.' };
    const payload = panel.handle();
    return { text: payload.content, components: payload.components };
  }

  private configPanel(): CommandReply {
    const panel = this.deps.configPanel;
    if (panel === undefined) return { text: 'Config panel is not available.' };
    const payload = panel.handle();
    return { text: payload.content, components: payload.components };
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
      `mode        ${this.gatedRules().size > 0 ? 'approval' : 'unattended'}${this.deps.dryRun ? ' (dry run)' : ''}`,
      `rules       ${this.tierLine()}`,
      `phase       ${s?.phase ?? 'idle'}${s?.paused === true ? ' — PAUSED' : ''}`,
      `progress    ${s?.candidatesDone ?? 0}/${s?.candidatesTotal ?? 0} candidates`,
      `verified    ${counts.get('verified') ?? 0}`,
      `unverified  ${counts.get('unverified') ?? 0}`,
      `failed      ${counts.get('failed') ?? 0}`,
      `pending     ${pending} awaiting approval`,
      `cursor      ${s?.lastScrobbleUts ?? 'none — next sweep is full'}`,
      ``,
      ...this.ledgerTable(),
    ];
    return fence(lines);
  }

  /** All-time: applied_edits is a durable one-row-per-tuple ledger, not a per-run counter. */
  private ledgerTable(): string[] {
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

    return [
      `                albums  tracks`,
      `corrected       ${pad(done('album'))}  ${pad(done('track'))}`,
      `unverified      ${pad(at('album', 'unverified'))}  ${pad(at('track', 'unverified'))}`,
      `failed          ${pad(at('album', 'failed'))}  ${pad(at('track', 'failed'))}`,
      `awaiting        ${pad(at('album', 'awaiting_approval'))}  ${pad(at('track', 'awaiting_approval'))}`,
      `ignored         ${pad(at('album', 'ignored'))}  ${pad(at('track', 'ignored'))}`,
      ``,
      `total corrected ${done('album') + done('track')} since the ledger began`,
    ];
  }

  private pendingList(page: number): string {
    const rows = this.deps.approvals.pending();
    if (rows.length === 0) return 'Nothing awaiting approval.';
    const start = Math.max(0, (Math.max(1, page) - 1) * PAGE_SIZE);
    const slice = rows.slice(start, start + PAGE_SIZE);
    if (slice.length === 0) return `Page ${page} is past the end (${rows.length} entries).`;
    const lines = slice.map((r) => {
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
    const pages = Math.ceil(rows.length / PAGE_SIZE);
    // Not fenced, unlike the ignore list: a fence stops Discord linkifying the jump URLs.
    return [...lines, ``, `page ${Math.max(1, page)}/${pages} · ${rows.length} entries`].join('\n');
  }

  private repropose(rule: string): CommandReply {
    if (!isGroupName(rule)) return { text: `Unknown rule: ${rule}` };
    const n = this.deps.approvals.reproposable(rule).length;
    if (n === 0) return { text: `No pending proposal carries ${rule}.` };
    return {
      text:
        `Drop ${n} pending proposal(s) carrying ${rule}? Their cards are retired and the ledger ` +
        `rows deleted, so a later sweep re-resolves them under the rule as it stands now. ` +
        `Nothing is written to Last.fm.`,
      confirm: { customId: reproposeId(rule), label: `Drop ${n}` },
    };
  }

  /**
   * The list and the bulk action are one reply, so the decision is taken while looking at what it
   * covers — which is also why the button needs no second confirmation step of its own.
   */
  private pending(page: number): CommandReply {
    const n = this.deps.approvals.pending().length;
    const text = this.pendingList(page);
    if (n === 0) return { text };
    return {
      text: `${text}\n\nApplying all ${n} is for real and cannot be undone.`,
      confirm: { customId: 'approve-all:0', label: `Apply all ${n}` },
    };
  }


  /**
   * One verb for every "forget this and work it out again". Only `proposals` confirms: the others
   * clear derived state the next sweep rebuilds, while that one discards recorded decisions.
   */
  private reset(args: Record<string, string | number>): CommandReply {
    const target = String(args['target'] ?? '');
    if (!isResetTarget(target)) return { text: `Unknown target: ${target}` };

    const rule = args['rule'] === undefined ? undefined : String(args['rule']);
    if (rule !== undefined && (target === 'cursor' || target === 'dead')) {
      return { text: `\`${target}\` takes no rule.` };
    }
    if (rule !== undefined && !isGroupName(rule)) return { text: `Unknown rule: ${rule}` };

    switch (target) {
      case 'cursor':
        clearCursor(this.deps.db);
        return { text: 'Cursor cleared. The next sweep walks the whole library.' };
      case 'dead': {
        const n = clearDead(this.deps.db);
        return { text: `Forgot ${n} learned-empty candidate(s). They will be tried again.` };
      }
      case 'shadow': {
        const n = clearShadow(this.deps.db, rule);
        const scope = rule === undefined ? '' : ` for ${rule}`;
        return { text: `Forgot ${n} shadow hit(s)${scope}. They will be announced again.` };
      }
      case 'proposals':
        if (rule === undefined) return { text: '`proposals` needs a rule.' };
        return this.repropose(rule);
    }
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
      return 'The service is paused. Resume it from /scrub config, or the rule cannot be applied.';
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

  private shadowList(args: Record<string, string | number>): string {
    const raw = args['rule'] === undefined ? undefined : String(args['rule']);
    if (raw !== undefined && !ALL_GROUPS.includes(raw as never)) {
      return `\`${raw}\` is not a rule. Try: ${ALL_GROUPS.join(', ')}`;
    }
    if (raw !== undefined && this.enabledRules().has(raw)) {
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

}

function pad(n: number): string {
  return String(n).padStart(6);
}

function fence(lines: string[]): string {
  return '```\n' + lines.join('\n') + '\n```';
}
