import { describe, expect, it } from 'vitest';
import { bestImageUrl, type LastfmImage } from '../../src/lastfm/types.js';
import { LastfmApi } from '../../src/lastfm/api.js';
import { ConsoleAndDiscordReporter } from '../../src/report/reporter.js';
import { Discord, type DiscordEmbed } from '../../src/report/discord.js';

const img = (size: LastfmImage['size'], text: string): LastfmImage => ({ size, '#text': text });

describe('bestImageUrl', () => {
  it('prefers the largest available size', () => {
    expect(
      bestImageUrl([img('medium', 'm'), img('large', 'l'), img('extralarge', 'xl')]),
    ).toBe('xl');
  });

  it('falls back down the sizes when the largest is empty', () => {
    expect(bestImageUrl([img('extralarge', ''), img('large', 'l')])).toBe('l');
  });

  it('returns undefined for no art, which obscure releases legitimately have', () => {
    expect(bestImageUrl([])).toBeUndefined();
    expect(bestImageUrl(undefined)).toBeUndefined();
    expect(bestImageUrl([img('extralarge', '')])).toBeUndefined();
  });
});

function api(responses: unknown[]) {
  let i = 0;
  const calls: string[] = [];
  const fetchImpl = (async (url: URL) => {
    calls.push(url.searchParams.get('album') ?? '');
    return new Response(JSON.stringify(responses[Math.min(i++, responses.length - 1)]));
  }) as unknown as typeof fetch;
  return { calls, api: new LastfmApi('k', { fetchImpl, minIntervalMs: 0, sleep: async () => {} }) };
}

const WITH_ART = { album: { name: 'Tim', artist: 'The Replacements', image: [img('extralarge', 'xl-url')] } };

describe('LastfmApi.albumArt', () => {
  it('looks up the post-edit album name', async () => {
    const { api: a, calls } = api([WITH_ART]);
    expect(await a.albumArt('The Replacements', 'Tim')).toBe('xl-url');
    expect(calls).toEqual(['Tim']);
  });

  it('caches per album so one album’s many tracks cost one lookup', async () => {
    const { api: a, calls } = api([WITH_ART]);
    await a.albumArt('The Replacements', 'Tim');
    await a.albumArt('The Replacements', 'Tim');
    await a.albumArt('The Replacements', 'Tim');
    expect(calls).toHaveLength(1);
  });

  it('returns undefined rather than throwing when the lookup fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const a = new LastfmApi('k', { fetchImpl, minIntervalMs: 0, sleep: async () => {}, maxRetries: 0 });
    await expect(a.albumArt('X', 'Y')).resolves.toBeUndefined();
  });

  it('does not call out for an empty album or artist', async () => {
    const { api: a, calls } = api([WITH_ART]);
    expect(await a.albumArt('X', '')).toBeUndefined();
    expect(await a.albumArt('', 'Y')).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

function spy() {
  const sent: DiscordEmbed[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    sent.push(...(JSON.parse(init.body as string) as { embeds: DiscordEmbed[] }).embeds);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const d = new Discord({ botToken: 't', channelId: 'c', fetchImpl, sleep: async () => {}, minIntervalMs: 0 });
  return { sent, reporter: new ConsoleAndDiscordReporter(d, () => {}, () => {}) };
}

const TOTALS = { planned: 1, applied: 1, verified: 1, unverified: 0, failed: 0 };
const base = {
  artist: 'The Replacements',
  track: 'Left of the Dial',
  album: 'Tim (Remastered)',
  changes: [{ field: 'album_name', from: 'Tim (Remastered)', to: 'Tim' }],
  groups: ['remaster'],
  outcome: 'verified' as const,
};

describe('embeds show art for the new value', () => {
  it('sets a thumbnail when art is present', async () => {
    const { sent, reporter } = spy();
    await reporter.corrections([{ ...base, imageUrl: 'xl-url' }], TOTALS);
    expect(sent[0]!.thumbnail).toEqual({ url: 'xl-url' });
  });

  it('omits the thumbnail entirely when there is no art', async () => {
    const { sent, reporter } = spy();
    await reporter.corrections([base], TOTALS);
    expect(sent[0]!.thumbnail).toBeUndefined();
  });

  it('sets it on a grouped embed too', async () => {
    const { sent, reporter } = spy();
    await reporter.group(
      {
        artist: 'The Replacements',
        shared: { field: 'album_name', from: 'Tim (Remastered)', to: 'Tim' },
        items: [base, { ...base, track: 'Bastards of Young' }],
        outcome: 'verified',
        imageUrl: 'xl-url',
      },
      TOTALS,
    );
    expect(sent[0]!.thumbnail).toEqual({ url: 'xl-url' });
  });
});
