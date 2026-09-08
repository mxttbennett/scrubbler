import { describe, expect, it } from 'vitest';
import { ConsoleAndDiscordReporter, describeCorrection, escapeMd } from '../../src/report/reporter.js';
import { Discord, type DiscordEmbed } from '../../src/report/discord.js';

function spy() {
  const sent: DiscordEmbed[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { embeds: DiscordEmbed[] };
    sent.push(...body.embeds);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const discord = new Discord({
    botToken: 't',
    channelId: 'c',
    fetchImpl,
    sleep: async () => {},
    minIntervalMs: 0,
  });
  return { sent, reporter: new ConsoleAndDiscordReporter(discord, () => {}, () => {}) };
}

const TOTALS = { planned: 3, applied: 1, verified: 1, unverified: 0, failed: 0 };

const ONE = {
  artist: 'Fleetwood Mac',
  kind: 'track' as const,
  track: 'Silver Springs - 2004 Remaster',
  album: 'Rumours (Deluxe Edition)',
  changes: [
    { field: 'track_name', from: 'Silver Springs - 2004 Remaster', to: 'Silver Springs' },
    { field: 'album_name', from: 'Rumours (Deluxe Edition)', to: 'Rumours' },
  ],
  groups: ['edition', 'remaster'],
  outcome: 'verified' as const,
};

describe('one message per correction', () => {
  it('sends a structured embed rather than a one-line code fence', async () => {
    const { sent, reporter } = spy();
    await reporter.corrections([ONE], TOTALS);

    expect(sent).toHaveLength(1);
    const e = sent[0]!;
    expect(e.title).toBe('Corrected 1 track');
    // the artist leads the description, not the title
    expect(e.description).toBe('**Fleetwood Mac**');
    // track + on album are always present: an album-only correction otherwise renders identically
    // for every track on the album, which is the bug this fixes.
    expect(e.fields?.map((f) => f.name)).toEqual([
      'track name',
      'album name',
      'track',
      'on album',
      'rule',
    ]);
    expect(e.fields?.[0]!.value).toContain('Silver Springs');
    expect(e.footer?.text).toContain('1 applied');
  });

  it('names the outcome in the title and colours by it', async () => {
    const { sent, reporter } = spy();
    await reporter.corrections([{ ...ONE, outcome: 'planned' }], TOTALS);
    await reporter.corrections([{ ...ONE, outcome: 'unverified' }], TOTALS);
    await reporter.corrections([{ ...ONE, outcome: 'failed', error: 'rejected' }], TOTALS);

    expect(sent.map((e) => e.title)).toEqual([
      'Would correct 1 track',
      'Corrected, unconfirmed 1 track',
      'Failed to correct 1 track',
    ]);
    expect(new Set(sent.map((e) => e.description))).toEqual(new Set(['**Fleetwood Mac**']));
    expect(new Set(sent.map((e) => e.color)).size).toBe(3);
    expect(sent[2]!.fields?.some((f) => f.name === 'error')).toBe(true);
  });

  it('still batches into a fence when handed several at once', async () => {
    const { sent, reporter } = spy();
    await reporter.corrections([ONE, { ...ONE, artist: 'Battles' }], TOTALS);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('2 corrections');
    expect(sent[0]!.description).toContain('```');
    expect(sent[0]!.fields).toBeUndefined();
  });

  it('sends nothing for an empty batch', async () => {
    const { sent, reporter } = spy();
    await reporter.corrections([], TOTALS);
    expect(sent).toEqual([]);
  });
});

describe('escapeMd', () => {
  it('neutralises markdown that titles legitimately contain', () => {
    expect(escapeMd('*NSYNC')).toBe('\\*NSYNC');
    expect(escapeMd('Blue Monday - 2015 Remaster')).toContain('\\-');
    expect(escapeMd('~~struck~~')).toBe('\\~\\~struck\\~\\~');
    expect(escapeMd('_Wonderful_')).toBe('\\_Wonderful\\_');
  });
});

describe('describeCorrection', () => {
  it('marks the outcome so a log line reads at a glance', () => {
    expect(describeCorrection({ ...ONE, outcome: 'failed', error: 'nope' })).toMatch(/^! /);
    expect(describeCorrection({ ...ONE, outcome: 'unverified' })).toMatch(/^\? /);
    expect(describeCorrection({ ...ONE, outcome: 'planned' })).toMatch(/^· /);
    expect(describeCorrection(ONE)).toContain('"Silver Springs - 2004 Remaster" -> "Silver Springs"');
  });
});

describe('grouped corrections', () => {
  const albumOnly = (track: string) => ({
    artist: 'The Replacements',
    kind: 'album' as const,
    track,
    album: 'Let It Be (Expanded)',
    changes: [{ field: 'album_name', from: 'Let It Be (Expanded)', to: 'Let It Be' }],
    groups: ['edition'],
    outcome: 'verified' as const,
  });

  it('collapses an album rename across tracks into one embed naming them', async () => {
    const { sent, reporter } = spy();
    const items = ['Bastards of Young', 'Left of the Dial', 'Answering Machine'].map(albumOnly);
    await reporter.group(
      { artist: 'The Replacements', kind: 'album' as const, shared: { field: 'album_name', from: 'Let It Be (Expanded)', to: 'Let It Be' }, items, outcome: 'verified' },
      TOTALS,
    );

    expect(sent).toHaveLength(1);
    const e = sent[0]!;
    expect(e.title).toBe('Corrected album (3 tracks)');
    expect(e.description).toBe('**The Replacements**');
    expect(e.fields?.map((f) => f.name)).toEqual(['album name', 'tracks (3)', 'rule']);
    expect(e.fields?.[1]!.value).toContain('Bastards of Young');
    expect(e.fields?.[1]!.value).toContain('Answering Machine');
  });

  it('truncates a long track list inside the embed field limit', async () => {
    const { sent, reporter } = spy();
    const items = Array.from({ length: 200 }, (_, i) => albumOnly(`A very long track title number ${i}`));
    await reporter.group(
      { artist: 'X', kind: 'album' as const, shared: { field: 'album_name', from: 'a', to: 'b' }, items, outcome: 'verified' },
      TOTALS,
    );
    const list = sent[0]!.fields![1]!.value;
    expect(list.length).toBeLessThanOrEqual(1024);
    expect(list).toContain('more');
  });

  it('falls back to per-item reporting when the group shares no single change', async () => {
    const { sent, reporter } = spy();
    const items = [albumOnly('a'), { ...albumOnly('b'), changes: [{ field: 'track_name', from: 'b - Remastered', to: 'b' }] }];
    await reporter.group({ artist: 'X', kind: 'album' as const, shared: undefined, items, outcome: 'verified' }, TOTALS);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('2 corrections');
    expect(sent[0]!.description).toContain('```');
  });

  it('renders a one-track group as the single-correction embed', async () => {
    const { sent, reporter } = spy();
    await reporter.group(
      { artist: 'X', kind: 'album' as const, shared: { field: 'album_name', from: 'a', to: 'b' }, items: [albumOnly('solo')], outcome: 'verified' },
      TOTALS,
    );
    expect(sent[0]!.title).toBe('Corrected album');
    expect(sent[0]!.description).toBe('**The Replacements**');
  });
});

describe('the footer never claims "nothing written" from zero counts', () => {
  const c = {
    artist: 'The Beatles',
    kind: 'album' as const,
    track: '(whole album)',
    album: 'Please Please Me (Remastered)',
    changes: [{ field: 'album_name', from: 'Please Please Me (Remastered)', to: 'Please Please Me' }],
    groups: ['remaster'],
    outcome: 'verified' as const,
  };

  it('says dry run only when it really was one', async () => {
    const { sent, reporter } = spy();
    await reporter.corrections([c], { planned: 4, applied: 0, verified: 0, unverified: 0, failed: 0, dryRun: true });
    expect(sent[0]!.footer?.text).toContain('dry run');
  });

  it('does not say "nothing written" under a Corrected card just because counts are zero', async () => {
    const { sent, reporter } = spy();
    // this is the shape album renames produced before they went through the executor
    await reporter.corrections([c], { planned: 0, applied: 0, verified: 0, unverified: 0, failed: 0 });
    expect(sent[0]!.title).toContain('Corrected');
    expect(sent[0]!.footer?.text).not.toContain('nothing written');
  });

  it('omits unverified and failed from the footer when they are zero', async () => {
    const { sent, reporter } = spy();
    await reporter.corrections([c], { planned: 3, applied: 3, verified: 3, unverified: 0, failed: 0 });
    expect(sent[0]!.footer?.text).toBe('this run: 3 applied · 3 verified');
  });

  it('shows them when they are not', async () => {
    const { sent, reporter } = spy();
    await reporter.corrections([c], { planned: 5, applied: 5, verified: 3, unverified: 1, failed: 1 });
    expect(sent[0]!.footer?.text).toContain('1 unverified');
    expect(sent[0]!.footer?.text).toContain('1 failed');
  });
});

describe('embed titles name the subject and count, not the artist', () => {
  const track = {
    artist: 'The Smiths',
    kind: 'track' as const,
    track: 'Heaven Knows - 2011 Remaster',
    album: 'Hatful of Hollow',
    changes: [{ field: 'track_name', from: 'Heaven Knows - 2011 Remaster', to: 'Heaven Knows' }],
    groups: ['remaster'],
    outcome: 'verified' as const,
  };

  it('pluralises tracks', async () => {
    const { sent, reporter } = spy();
    await reporter.group(
      { artist: 'The Smiths', kind: 'track', shared: undefined, items: [track], outcome: 'verified' },
      TOTALS,
    );
    expect(sent[0]!.title).toBe('Corrected 1 track');
  });

  it('says "album" for an album rename and counts its tracks', async () => {
    const { sent, reporter } = spy();
    const items = ['a', 'b'].map((t) => ({ ...track, kind: 'album' as const, track: t }));
    await reporter.group(
      {
        artist: 'The Smiths',
        kind: 'album',
        shared: { field: 'album_name', from: 'Hatful (Remastered)', to: 'Hatful' },
        items,
        outcome: 'verified',
      },
      TOTALS,
    );
    expect(sent[0]!.title).toBe('Corrected album (2 tracks)');
  });

  it('leads the description with the artist in every shape', async () => {
    const { sent, reporter } = spy();
    await reporter.corrections([track], TOTALS);
    expect(sent[0]!.description!.startsWith('**The Smiths**')).toBe(true);
  });
});

describe('album cards name the tracks a single request covered', () => {
  it('titles the card with the track count, not the one-item group size', async () => {
    const sent: DiscordEmbed[] = [];
    const reporter = new ConsoleAndDiscordReporter(
      { send: async (e: DiscordEmbed) => void sent.push(e) } as never,
      () => {},
      () => {},
    );

    await reporter.corrections(
      [
        {
          artist: 'Nirvana',
          kind: 'album',
          track: '(whole album)',
          album: 'In Utero (Deluxe Edition)',
          changes: [
            { field: 'album_name', from: 'In Utero (Deluxe Edition)', to: 'In Utero' },
          ],
          groups: ['edition'],
          outcome: 'verified',
          trackNames: ['Serve the Servants', 'Heart-Shaped Box', 'Rape Me', 'Dumb'],
          scrobbles: 37,
        },
      ],
      { planned: 1, applied: 1, verified: 1, unverified: 0, failed: 0 },
    );

    expect(sent[0]!.title).toBe('Corrected album (4 tracks)');
    expect(sent[0]!.fields?.find((f) => f.name === 'scrobbles affected')?.value).toBe('37');
    const list = sent[0]!.fields?.find((f) => f.name === 'tracks on this album (4)');
    expect(list?.value).toContain('Serve the Servants');
    expect(list?.value.split('\n')).toHaveLength(4);
  });

  it('says just "Corrected album" when the page listed one track or none', async () => {
    const sent: DiscordEmbed[] = [];
    const reporter = new ConsoleAndDiscordReporter(
      { send: async (e: DiscordEmbed) => void sent.push(e) } as never,
      () => {},
      () => {},
    );

    await reporter.corrections(
      [
        {
          artist: 'Nirvana',
          kind: 'album',
          track: '(whole album)',
          album: 'In Utero (Deluxe Edition)',
          changes: [
            { field: 'album_name', from: 'In Utero (Deluxe Edition)', to: 'In Utero' },
          ],
          groups: ['edition'],
          outcome: 'verified',
        },
      ],
      { planned: 1, applied: 1, verified: 1, unverified: 0, failed: 0 },
    );

    expect(sent[0]!.title).toBe('Corrected album');
    expect(sent[0]!.fields?.some((f) => f.name.startsWith('tracks ('))).toBe(false);
  });
});

describe('the run summary counts albums and tracks apart', () => {
  it('shows both when they are known', async () => {
    const sent: DiscordEmbed[] = [];
    const reporter = new ConsoleAndDiscordReporter(
      { send: async (e: DiscordEmbed) => void sent.push(e) } as never,
      () => {},
      () => {},
    );

    await reporter.summary('Sweep complete', [], {
      planned: 9,
      applied: 9,
      verified: 9,
      unverified: 0,
      failed: 0,
      albums: 6,
      tracks: 3,
    });

    const byName = new Map(sent[0]!.fields?.map((f) => [f.name, f.value]));
    expect(byName.get('Albums')).toBe('6');
    expect(byName.get('Tracks')).toBe('3');
  });

  it('omits them rather than printing a misleading zero when unknown', async () => {
    const sent: DiscordEmbed[] = [];
    const reporter = new ConsoleAndDiscordReporter(
      { send: async (e: DiscordEmbed) => void sent.push(e) } as never,
      () => {},
      () => {},
    );

    await reporter.summary('Sweep complete', [], {
      planned: 1,
      applied: 1,
      verified: 1,
      unverified: 0,
      failed: 0,
    });

    expect(sent[0]!.fields?.some((f) => f.name === 'Albums')).toBe(false);
  });
});
