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
    expect(e.title).toBe('Corrected · Fleetwood Mac');
    expect(e.description).toBeUndefined();
    expect(e.fields?.map((f) => f.name)).toEqual(['track name', 'album name', 'rule']);
    expect(e.fields?.[0]!.value).toContain('Silver Springs');
    expect(e.footer?.text).toContain('1 applied');
  });

  it('names the outcome in the title and colours by it', async () => {
    const { sent, reporter } = spy();
    await reporter.corrections([{ ...ONE, outcome: 'planned' }], TOTALS);
    await reporter.corrections([{ ...ONE, outcome: 'unverified' }], TOTALS);
    await reporter.corrections([{ ...ONE, outcome: 'failed', error: 'rejected' }], TOTALS);

    expect(sent.map((e) => e.title)).toEqual([
      'Would correct · Fleetwood Mac',
      'Corrected, unconfirmed · Fleetwood Mac',
      'Failed to correct · Fleetwood Mac',
    ]);
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
