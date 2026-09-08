import { COLOR, Discord, fenceLines } from './discord.js';

export interface RunTotals {
  applied: number;
  verified: number;
  unverified: number;
  failed: number;
  planned: number;
}

export type Outcome = 'planned' | 'applied' | 'verified' | 'unverified' | 'failed';

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export interface Correction {
  artist: string;
  changes: FieldChange[];
  groups: string[];
  outcome: Outcome;
  error?: string;
}

export interface Reporter {
  corrections(items: Correction[], totals: RunTotals): Promise<void>;
  summary(headline: string, lines: string[], totals: RunTotals): Promise<void>;
  report(error: unknown, context: string): Promise<void>;
}

const MARK: Record<Outcome, string> = {
  planned: '·',
  applied: '+',
  verified: '+',
  unverified: '?',
  failed: '!',
};

const OUTCOME_COLOR: Record<Outcome, number> = {
  planned: COLOR.dryRun,
  applied: COLOR.applied,
  verified: COLOR.done,
  unverified: COLOR.warn,
  failed: COLOR.failed,
};

const OUTCOME_WORD: Record<Outcome, string> = {
  planned: 'Would correct',
  applied: 'Corrected',
  verified: 'Corrected',
  unverified: 'Corrected, unconfirmed',
  failed: 'Failed to correct',
};

export function describeCorrection(c: Correction): string {
  const parts = c.changes.map((ch) => `${ch.field}: "${ch.from}" -> "${ch.to}"`);
  const tail = c.error === undefined ? '' : ` — ${c.error}`;
  return `${MARK[c.outcome]} ${c.artist} — ${parts.join(' | ')} [${c.groups.join(',')}]${tail}`;
}

export class ConsoleAndDiscordReporter implements Reporter {
  constructor(
    private readonly discord: Discord,
    private readonly log: (msg: string) => void = (m) => console.log(m),
    private readonly logError: (msg: string) => void = (m) => console.error(m),
  ) {}

  async corrections(items: Correction[], totals: RunTotals): Promise<void> {
    for (const c of items) this.log(describeCorrection(c));
    if (items.length === 0) return;
    if (items.length === 1) {
      await this.discord.send(this.single(items[0]!, totals));
      return;
    }
    await this.discord.send({
      title: `${items.length} corrections`,
      color: items.some((c) => c.outcome === 'failed') ? COLOR.failed : COLOR.applied,
      description: fenceLines(items.map(describeCorrection)),
      footer: { text: progressText(totals) },
    });
  }

  /** One correction gets real fields rather than a one-line code fence. */
  private single(c: Correction, totals: RunTotals) {
    const fields = c.changes.map((ch) => ({
      name: ch.field.replace(/_/g, ' '),
      value: `~~${escapeMd(ch.from)}~~\n**${escapeMd(ch.to)}**`,
    }));
    if (c.error !== undefined) fields.push({ name: 'error', value: escapeMd(c.error) });
    fields.push({ name: 'rule', value: c.groups.join(', ') || '—' });
    return {
      title: `${OUTCOME_WORD[c.outcome]} · ${c.artist}`,
      color: OUTCOME_COLOR[c.outcome],
      fields,
      footer: { text: progressText(totals) },
    };
  }

  async summary(headline: string, lines: string[], totals: RunTotals): Promise<void> {
    this.log(headline);
    for (const line of lines) this.log(line);
    await this.discord.send({
      title: headline,
      color: totals.failed > 0 ? COLOR.failed : COLOR.done,
      ...(lines.length > 0 ? { description: fenceLines(lines) } : {}),
      fields: [
        { name: 'Tuples', value: String(totals.planned), inline: true },
        { name: 'Applied', value: String(totals.applied), inline: true },
        { name: 'Verified', value: String(totals.verified), inline: true },
        { name: 'Unverified', value: String(totals.unverified), inline: true },
        { name: 'Failed', value: String(totals.failed), inline: true },
      ],
    });
  }

  async report(error: unknown, context: string): Promise<void> {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.logError(`[${context}] ${detail}`);
    await this.discord.send({
      title: `Failed: ${context}`,
      color: COLOR.failed,
      description: '```\n' + detail.slice(0, 1500) + '\n```',
    });
  }
}

/** Titles routinely contain *, _, ~ and backticks, which would otherwise format the embed. */
export function escapeMd(value: string): string {
  return value.replace(/([\\`*_~|>[\]()#-])/g, '\\$1');
}

function progressText(t: RunTotals): string {
  if (t.applied === 0 && t.failed === 0) {
    return `${t.planned} planned · nothing written`;
  }
  return `${t.applied} applied · ${t.verified} verified · ${t.unverified} unverified · ${t.failed} failed`;
}
