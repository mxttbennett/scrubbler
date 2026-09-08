import { COLOR, Discord, type DiscordEmbed, type DiscordEmbedField, fenceLines } from './discord.js';
import { albumUrl, artistUrl, linkSuffix, trackUrl } from './links.js';

export interface RunTotals {
  applied: number;
  verified: number;
  unverified: number;
  failed: number;
  planned: number;
  /** Set so the footer can say "nothing written" honestly, instead of inferring it from zeroes. */
  dryRun?: boolean;
  /** One album rename is one write covering many tracks, so the two cannot share a counter. */
  albums?: number;
  tracks?: number;
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
  /**
   * Set on album corrections only: the tracks of this album the user has actually played, with
   * counts. Deliberately not the release track list — a rename does not touch a song never scrobbled.
   */
  scrobbledTracks?: string[];
  /** The user's scrobbles under the ORIGINAL album title, read before the write. */
  scrobbles?: number;
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
export function trackList(
  items: Correction[],
  links?: Links,
  artist?: string,
  _album?: string,
): string {
  const lines: string[] = [];
  let size = 0;
  for (const [i, item] of items.entries()) {
    const who = artist ?? item.artist;
    const line = `• ${escapeMd(item.track)}${linkSuffix(links?.track(who, item.track))}`;
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
 * Links point at the user's own library pages rather than the global artist pages: those are the
 * pages that show what the rename did. Undefined when no username is configured, in which case
 * every label renders as plain text.
 */
export interface Links {
  artist: (artist: string) => string;
  album: (artist: string, album: string) => string;
  track: (artist: string, track: string) => string;
}

export function libraryLinks(username: string): Links {
  return {
    artist: (artist) => artistUrl(username, artist),
    album: (artist, album) => albumUrl(username, artist, album),
    track: (artist, track) => trackUrl(username, artist, track),
  };
}

/** The post-edit value is what gets linked: the old title's page is empty once the rename lands. */
function newValue(shared: CorrectionGroup['shared'], fallback: string): string {
  return shared?.to ?? fallback;
}

/**
 * Shared with proposals so an approval card and the report it becomes look the same — the only
 * difference is the buttons and the footer.
 */
export function groupEmbed(g: CorrectionGroup, footer: string, links?: Links): DiscordEmbed {
  const n = g.items.length;
  const shared = g.shared;
  const album = newValue(shared?.field === 'album_name' ? shared : undefined, g.items[0]?.album ?? '');
  return {
    title: embedTitle(g.outcome, g.kind, n),
    color: OUTCOME_COLOR[g.outcome],
    description: `**${escapeMd(g.artist)}**${linkSuffix(links?.artist(g.artist))}`,
    fields: [
      ...(shared === undefined
        ? []
        : [
            {
              name: shared.field.replace(/_/g, ' '),
              value:
                `~~${escapeMd(shared.from)}~~\n**${escapeMd(shared.to)}**` +
                linkSuffix(
                  shared.field === 'album_name'
                    ? links?.album(g.artist, shared.to)
                    : links?.track(g.artist, shared.to),
                ),
            },
          ]),
      ...(n > 1
        ? [{ name: `tracks (${n})`, value: trackList(g.items, links, g.artist, album) }]
        : []),
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
    /** Absent when no username is configured, in which case every card renders without links. */
    private readonly links?: Links,
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
    await this.discord.send(groupEmbed(g, progressText(totals), this.links));
  }

  /** One correction gets real fields rather than a one-line code fence. */
  private single(c: Correction, totals: RunTotals) {
    const links = this.links;
    // The post-edit value is what gets linked: the old title's page is empty once the rename lands.
    const urlFor = (field: string, to: string): string | undefined =>
      field === 'album_name'
        ? links?.album(c.artist, to)
        : field === 'track_name'
          ? links?.track(c.artist, to)
          : undefined;

    const fields: DiscordEmbedField[] = c.changes.map((ch) => ({
      name: ch.field.replace(/_/g, ' '),
      value: `~~${escapeMd(ch.from)}~~\n**${escapeMd(ch.to)}**${linkSuffix(urlFor(ch.field, ch.to))}`,
    }));
    if (c.error !== undefined) fields.push({ name: 'error', value: escapeMd(c.error) });
    // Named for track corrections: an album-only change otherwise renders identically per track.
    if (c.kind === 'track') {
      const nextTrack = c.changes.find((ch) => ch.field === 'track_name')?.to ?? c.track;
      const nextAlbum = c.changes.find((ch) => ch.field === 'album_name')?.to ?? c.album;
      fields.push({
        name: 'track',
        value: `${escapeMd(c.track)}${linkSuffix(links?.track(c.artist, nextTrack))}`,
        inline: true,
      });
      fields.push({
        name: 'on album',
        value:
          c.album === ''
            ? '—'
            : `${escapeMd(c.album)}${linkSuffix(links?.album(c.artist, nextAlbum))}`,
        inline: true,
      });
    }
    const covered = c.scrobbledTracks ?? [];
    if (covered.length > 0) {
      const albumNow = c.changes.find((ch) => ch.field === 'album_name')?.to ?? c.album;
      fields.push({
        name: `scrobbled tracks (${covered.length})`,
        value: trackList(
          covered.map((track) => ({ ...c, track })),
          links,
          c.artist,
          albumNow,
        ),
      });
    }
    if (c.scrobbles !== undefined) {
      fields.push({
        name: 'scrobbles affected',
        value: String(c.scrobbles),
        inline: true,
      });
    }
    fields.push({ name: 'rule', value: c.groups.join(', ') || '—' });
    return {
      title: embedTitle(c.outcome, c.kind, Math.max(covered.length, 1)),
      color: OUTCOME_COLOR[c.outcome],
      description: `**${escapeMd(c.artist)}**${linkSuffix(links?.artist(c.artist))}`,
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
        ...(totals.albums === undefined
          ? []
          : [{ name: 'Albums', value: String(totals.albums), inline: true }]),
        ...(totals.tracks === undefined
          ? []
          : [{ name: 'Tracks', value: String(totals.tracks), inline: true }]),
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
