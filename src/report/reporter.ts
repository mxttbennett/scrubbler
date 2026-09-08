import { COLOR, Discord, type DiscordEmbed, type DiscordEmbedField, fenceLines } from './discord.js';

export interface RunTotals {
  applied: number;
  verified: number;
  unverified: number;
  failed: number;
  planned: number;
  /** Set so the footer can say "nothing written" honestly, instead of inferring it from zeroes. */
  dryRun?: boolean;
}

export type Outcome = 'planned' | 'applied' | 'verified' | 'unverified' | 'failed';

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export interface Correction {
  /** Album corrections carry the ALBUM artist here; track corrections the track artist. */
  artist: string;
  kind: 'track' | 'album';
  /** The tuple's identity, so a correction that only changed the album still names its track. */
  track: string;
  album: string;
  changes: FieldChange[];
  groups: string[];
  outcome: Outcome;
  error?: string;
  /** Art for the post-edit album, so the embed shows what it will be. */
  imageUrl?: string;
}

export interface CorrectionGroup {
  artist: string;
  kind: 'track' | 'album';
  shared: { field: string; from: string; to: string } | undefined;
  items: Correction[];
  outcome: Outcome;
  imageUrl?: string;
}

export interface Reporter {
  corrections(items: Correction[], totals: RunTotals): Promise<void>;
  group(group: CorrectionGroup, totals: RunTotals): Promise<void>;
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

/** "Corrected album (4 tracks)" or "Corrected 2 tracks" — the subject, not the artist. */
export function embedTitle(outcome: Outcome, kind: 'track' | 'album', count: number): string {
  const word = OUTCOME_WORD[outcome];
  if (kind === 'album') {
    return count > 1 ? `${word} album (${count} tracks)` : `${word} album`;
  }
  return `${word} ${count} track${count === 1 ? '' : 's'}`;
}

export function describeCorrection(c: Correction): string {
  const parts = c.changes.map((ch) => `${ch.field}: "${ch.from}" -> "${ch.to}"`);
  const tail = c.error === undefined ? '' : ` — ${c.error}`;
  return `${MARK[c.outcome]} ${c.artist} — ${c.track} [${c.album}] — ${parts.join(' | ')} [${c.groups.join(',')}]${tail}`;
}

const FIELD_VALUE_LIMIT = 1024;

/** Fits as many whole track names as the embed field allows, then says how many are left. */
export function trackList(items: Correction[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const [i, item] of items.entries()) {
    const line = `• ${escapeMd(item.track)}`;
    const more = `\n… ${items.length - i} more`;
    if (size + line.length + 1 + more.length > FIELD_VALUE_LIMIT) {
      lines.push(`… ${items.length - i} more`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * Shared with proposals so an approval card and the report it becomes look the same — the only
 * difference is the buttons and the footer.
 */
export function groupEmbed(g: CorrectionGroup, footer: string): DiscordEmbed {
  const n = g.items.length;
  const shared = g.shared;
  return {
    title: embedTitle(g.outcome, g.kind, n),
    color: OUTCOME_COLOR[g.outcome],
    description: `**${escapeMd(g.artist)}**`,
    fields: [
      ...(shared === undefined
        ? []
        : [
            {
              name: shared.field.replace(/_/g, ' '),
              value: `~~${escapeMd(shared.from)}~~\n**${escapeMd(shared.to)}**`,
            },
          ]),
      ...(n > 1 ? [{ name: `tracks (${n})`, value: trackList(g.items) }] : []),
      { name: 'rule', value: [...new Set(g.items.flatMap((i) => i.groups))].join(', ') || '—' },
    ],
    ...(g.imageUrl === undefined ? {} : { thumbnail: { url: g.imageUrl } }),
    footer: { text: footer },
  };
}

export function progressLine(totals: RunTotals): string {
  return progressText(totals);
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

  async group(g: CorrectionGroup, totals: RunTotals): Promise<void> {
    for (const c of g.items) this.log(describeCorrection(c));
    if (g.items.length === 0) return;
    if (g.items.length === 1) {
      await this.discord.send(this.single(g.items[0]!, totals));
      return;
    }
    if (g.shared === undefined) {
      await this.corrections(g.items, totals);
      return;
    }
    await this.discord.send(groupEmbed(g, progressText(totals)));
  }

  /** One correction gets real fields rather than a one-line code fence. */
  private single(c: Correction, totals: RunTotals) {
    const fields: DiscordEmbedField[] = c.changes.map((ch) => ({
      name: ch.field.replace(/_/g, ' '),
      value: `~~${escapeMd(ch.from)}~~\n**${escapeMd(ch.to)}**`,
    }));
    if (c.error !== undefined) fields.push({ name: 'error', value: escapeMd(c.error) });
    // Named for track corrections: an album-only change otherwise renders identically per track.
    if (c.kind === 'track') {
      fields.push({ name: 'track', value: escapeMd(c.track), inline: true });
      fields.push({ name: 'on album', value: escapeMd(c.album) || '—', inline: true });
    }
    fields.push({ name: 'rule', value: c.groups.join(', ') || '—' });
    return {
      title: embedTitle(c.outcome, c.kind, 1),
      color: OUTCOME_COLOR[c.outcome],
      description: `**${escapeMd(c.artist)}**`,
      fields,
      ...(c.imageUrl === undefined ? {} : { thumbnail: { url: c.imageUrl } }),
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

/**
 * Never infers "nothing written" from zero counts — an all-zero summary used to print that under a
 * card titled "Corrected", because album renames bypassed the counter entirely.
 */
function progressText(t: RunTotals): string {
  if (t.dryRun === true) return `${t.planned} planned this run · dry run, nothing written`;
  const parts = [`${t.applied} applied`, `${t.verified} verified`];
  if (t.unverified > 0) parts.push(`${t.unverified} unverified`);
  if (t.failed > 0) parts.push(`${t.failed} failed`);
  return `this run: ${parts.join(' · ')}`;
}
