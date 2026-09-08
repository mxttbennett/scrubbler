import { describe, expect, it, vi } from 'vitest';
import { Discord, clampEmbed, fenceLines } from '../../src/report/discord.js';

function capture(responses: Response[] = [new Response(null, { status: 204 })]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return responses[Math.min(i++, responses.length - 1)]!;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const EMBED = { title: 'Corrected 2', color: 0x1f6a7a, description: '```\nx\n```' };

describe('Discord', () => {
  it('is disabled, and silent, without both a token and a channel', async () => {
    const { calls, fetchImpl } = capture();
    const onlyToken = new Discord({ botToken: 't', channelId: undefined, fetchImpl });
    expect(onlyToken.enabled).toBe(false);
    await onlyToken.send(EMBED);

    const onlyChannel = new Discord({ botToken: undefined, channelId: 'c', fetchImpl });
    expect(onlyChannel.enabled).toBe(false);
    await onlyChannel.send(EMBED);

    expect(calls).toEqual([]);
  });

  it('posts to the channel with a bot authorization header', async () => {
    const { calls, fetchImpl } = capture();
    await new Discord({ botToken: 'tok', channelId: '123', fetchImpl }).send(EMBED);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/channels/123/messages');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bot tok');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ embeds: [EMBED] });
  });

  it('waits out a 429 using retry_after, then succeeds', async () => {
    const { calls, fetchImpl } = capture([
      new Response(JSON.stringify({ retry_after: 0.5 }), { status: 429 }),
      new Response(null, { status: 204 }),
    ]);
    const sleep = vi.fn(async () => {});
    await new Discord({ botToken: 't', channelId: 'c', fetchImpl, sleep }).send(EMBED);

    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(750);
  });

  it('gives up quietly on a non-retryable error rather than throwing', async () => {
    const { calls, fetchImpl } = capture([new Response('bad channel', { status: 403 })]);
    const log = vi.fn();
    await expect(
      new Discord({ botToken: 't', channelId: 'c', fetchImpl, log }).send(EMBED),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('403'));
  });

  it('never throws when the network fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(
      new Discord({ botToken: 't', channelId: 'c', fetchImpl, sleep: async () => {}, log: () => {} }).send(
        EMBED,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('clampEmbed', () => {
  it('keeps an embed inside Discord field limits', () => {
    const out = clampEmbed({
      title: 'x'.repeat(400),
      color: 1,
      description: 'y'.repeat(5000),
      fields: Array.from({ length: 40 }, () => ({ name: 'n', value: 'v'.repeat(2000) })),
      footer: { text: 'f' },
    });
    expect(out.title).toHaveLength(256);
    expect(out.description).toHaveLength(4000);
    expect(out.fields).toHaveLength(25);
    expect(out.fields![0]!.value).toHaveLength(1024);
  });

  it('omits the optional parts it was not given', () => {
    const out = clampEmbed({ title: 't', color: 2 });
    expect(out).toEqual({ title: 't', color: 2 });
  });
});

describe('fenceLines', () => {
  it('fences whole lines', () => {
    expect(fenceLines(['a', 'b'])).toBe('```\na\nb\n```');
  });

  it('truncates on a line boundary and says how many were dropped', () => {
    const out = fenceLines(['aaaa', 'bbbb', 'cccc'], 10);
    expect(out).toContain('aaaa');
    expect(out).toContain('more');
    expect(out).not.toContain('cccc');
  });
});
