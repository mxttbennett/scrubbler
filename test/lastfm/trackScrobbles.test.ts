import { describe, expect, it } from 'vitest';
import { LastfmApi } from '../../src/lastfm/api.js';

function api(handler: (url: URL) => unknown, username: string | null = 'u') {
  const calls: URL[] = [];
  const fetchImpl = (async (url: URL) => {
    calls.push(url);
    return new Response(JSON.stringify(handler(url)), { status: 200 });
  }) as unknown as typeof fetch;
  return {
    calls,
    client: new LastfmApi('key', {
      fetchImpl,
      minIntervalMs: 0,
      sleep: async () => {},
      ...(username === null ? {} : { username }),
    }),
  };
}

describe('trackScrobbles', () => {
  it('reads userplaycount for the named user', async () => {
    const { client, calls } = api(() => ({ track: { name: 'x', userplaycount: '606' } }));

    expect(await client.trackScrobbles('The Guess Who', 'American Woman - 2024 Remaster')).toBe(606);
    expect(calls[0]!.searchParams.get('method')).toBe('track.getinfo');
    expect(calls[0]!.searchParams.get('username')).toBe('u');
    expect(calls[0]!.searchParams.get('track')).toBe('American Woman - 2024 Remaster');
  });

  it('accepts the numeric form the API sometimes returns', async () => {
    const { client } = api(() => ({ track: { name: 'x', userplaycount: 12 } }));
    expect(await client.trackScrobbles('a', 'b')).toBe(12);
  });

  /** Without a username the API omits userplaycount entirely, so the request is pointless. */
  it('never asks when no username is configured', async () => {
    const { client, calls } = api(() => ({}), null);
    expect(await client.trackScrobbles('a', 'b')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('returns undefined rather than throwing when the field is absent or the call fails', async () => {
    const missing = api(() => ({ track: { name: 'x' } }));
    expect(await missing.client.trackScrobbles('a', 'b')).toBeUndefined();

    const errored = api(() => ({ error: 6, message: 'Track not found' }));
    expect(await errored.client.trackScrobbles('a', 'b')).toBeUndefined();
  });

  it('has nothing to ask about when either name is empty', async () => {
    const { client, calls } = api(() => ({ track: { userplaycount: '5' } }));
    expect(await client.trackScrobbles('', 'b')).toBeUndefined();
    expect(await client.trackScrobbles('a', '')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
