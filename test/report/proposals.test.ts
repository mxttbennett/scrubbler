import { describe, expect, it } from 'vitest';
import {
  ProposalPostFailed,
  Proposals,
  stripId,
  parseCustomId,
  reproposeId,
} from '../../src/report/proposals.js';

const EMBED = { title: 'Approve album', color: 1 };
const BUTTONS = [
  { customId: 'approve:1', label: 'Apply', style: 3 as const },
  { customId: 'ignore:1', label: 'Never', style: 4 as const },
];

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function transport(responses: Response[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let i = 0;
  const proposals = new Proposals({
    botToken: 'token',
    channelId: 'chan',
    sleep: async () => {},
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: JSON.parse(init.body as string) as unknown,
      });
      return responses[Math.min(i++, responses.length - 1)]!;
    }) as unknown as typeof fetch,
  });
  return { proposals, calls };
}

describe('Proposals.postProposal', () => {
  it('returns the created message id', async () => {
    const { proposals } = transport([response(200, { id: '999' })]);
    expect(await proposals.postProposal(EMBED, BUTTONS)).toEqual({ messageId: '999' });
  });

  it('sends the buttons as one action row carrying the custom ids', async () => {
    const { proposals, calls } = transport([response(200, { id: '1' })]);
    await proposals.postProposal(EMBED, BUTTONS);

    const body = calls[0]!.body as {
      components: { type: number; components: { custom_id: string; style: number }[] }[];
    };
    expect(body.components).toHaveLength(1);
    expect(body.components[0]!.type).toBe(1);
    expect(body.components[0]!.components.map((c) => c.custom_id)).toEqual([
      'approve:1',
      'ignore:1',
    ]);
  });

  it('throws rather than swallowing a failure, unlike the report sender', async () => {
    const { proposals } = transport([response(403, { message: 'Missing Access' })]);
    await expect(proposals.postProposal(EMBED, BUTTONS)).rejects.toThrow(ProposalPostFailed);
  });

  it('does not retry a 4xx, which will not improve', async () => {
    const { proposals, calls } = transport([response(403)]);
    await expect(proposals.postProposal(EMBED, BUTTONS)).rejects.toThrow(ProposalPostFailed);
    expect(calls).toHaveLength(1);
  });

  it('retries a 5xx and gives up loudly', async () => {
    const { proposals, calls } = transport([response(502)]);
    await expect(proposals.postProposal(EMBED, BUTTONS)).rejects.toThrow(/3 attempts/);
    expect(calls).toHaveLength(3);
  });

  it('waits out a 429 and then succeeds', async () => {
    const { proposals, calls } = transport([
      response(429, { retry_after: 0.1 }),
      response(200, { id: '5' }),
    ]);
    expect(await proposals.postProposal(EMBED, BUTTONS)).toEqual({ messageId: '5' });
    expect(calls).toHaveLength(2);
  });

  it('treats a missing message id as a failure, not a success', async () => {
    const { proposals } = transport([response(200, {})]);
    await expect(proposals.postProposal(EMBED, BUTTONS)).rejects.toThrow(/no message id/);
  });

  it('refuses to post when discord is not configured', async () => {
    const proposals = new Proposals({ botToken: undefined, channelId: undefined });
    expect(proposals.enabled).toBe(false);
    await expect(proposals.postProposal(EMBED, BUTTONS)).rejects.toThrow(ProposalPostFailed);
  });
});

describe('Proposals.editMessage', () => {
  it('PATCHes the message and clears the buttons when given none', async () => {
    const { proposals, calls } = transport([response(200, {})]);
    await proposals.editMessage('999', EMBED, []);

    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toContain('/channels/chan/messages/999');
    expect((calls[0]!.body as { components: unknown[] }).components).toEqual([]);
  });
});

describe('stripId', () => {
  it('round-trips through parseCustomId', () => {
    expect(parseCustomId(stripId(42))).toEqual({ action: 'strip', id: 42 });
  });

  it('still rejects an action it does not know', () => {
    expect(parseCustomId('demolish:42')).toBeUndefined();
  });
});

describe('reproposeId', () => {
  it('round-trips a rule name rather than a row id', () => {
    expect(parseCustomId(reproposeId('live-track'))).toEqual({
      action: 'repropose',
      rule: 'live-track',
    });
  });

  it('rejects a rule that is not in the catalogue', () => {
    expect(parseCustomId('repropose:not-a-rule')).toBeUndefined();
    expect(parseCustomId('repropose:')).toBeUndefined();
  });

  it('does not read the rule as a numeric id', () => {
    expect(parseCustomId('repropose:3')).toBeUndefined();
  });
});
