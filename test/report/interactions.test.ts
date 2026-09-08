import { describe, expect, it } from 'vitest';
import { Gateway, NOT_OWNER, UNKNOWN_ID } from '../../src/report/gateway.js';
import { approveId, ignoreId, parseCustomId } from '../../src/report/proposals.js';

const OWNER = '1111';
const STRANGER = '2222';

interface Calls {
  approve: [number, string][];
  ignore: [number, string][];
  approveAll: string[];
  replies: string[];
  followUps: string[];
  deferred: number;
  order: string[];
}

function harness(opts: { outcome?: string; throws?: boolean } = {}) {
  const calls: Calls = {
    approve: [],
    ignore: [],
    approveAll: [],
    replies: [],
    followUps: [],
    deferred: 0,
    order: [],
  };

  const gateway = new Gateway({
    botToken: 'token',
    ownerId: OWNER,
    decisions: {
      approve: async (id, user) => {
        calls.order.push('approve');
        calls.approve.push([id, user]);
        if (opts.throws === true) throw new Error('boom');
        return { outcome: opts.outcome ?? 'approved', detail: '1 edit(s) applied' };
      },
      ignore: async (id, user) => {
        calls.order.push('ignore');
        calls.ignore.push([id, user]);
        return { outcome: 'ignored', detail: '1 edit(s) ignored' };
      },
      approveAll: async (user) => {
        calls.approveAll.push(user);
        return { approved: 3, failed: 0 };
      },
    },
    alert: async () => {},
    alertAfterMinutes: 15,
    log: () => {},
  });

  return { gateway, calls };
}

function buttonInteraction(customId: string, userId: string, calls: Calls) {
  return {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId,
    user: { id: userId },
    reply: async (payload: { content: string }) => void calls.replies.push(payload.content),
    followUp: async (payload: { content: string }) => void calls.followUps.push(payload.content),
    deferUpdate: async () => {
      calls.order.push('defer');
      calls.deferred++;
    },
  } as never;
}

describe('parseCustomId', () => {
  it('round-trips the button ids it issues', () => {
    expect(parseCustomId(approveId(42))).toEqual({ action: 'approve', id: 42 });
    expect(parseCustomId(ignoreId(7))).toEqual({ action: 'ignore', id: 7 });
    expect(parseCustomId('approve-all:0')).toEqual({ action: 'approve-all', id: 0 });
  });

  it('rejects anything it did not issue', () => {
    expect(parseCustomId('delete:1')).toBeUndefined();
    expect(parseCustomId('approve:abc')).toBeUndefined();
    expect(parseCustomId('approve')).toBeUndefined();
    expect(parseCustomId('approve:-1')).toBeUndefined();
  });
});

describe('Gateway interactions', () => {
  it('routes an approve button to the decision handler', async () => {
    const { gateway, calls } = harness();
    await gateway.onInteraction(buttonInteraction(approveId(5), OWNER, calls));

    expect(calls.approve).toEqual([[5, OWNER]]);
    expect(calls.ignore).toEqual([]);
  });

  it('defers before the slow work, because the ack budget is 3 seconds', async () => {
    const { gateway, calls } = harness();
    await gateway.onInteraction(buttonInteraction(approveId(5), OWNER, calls));

    expect(calls.order).toEqual(['defer', 'approve']);
  });

  it('refuses anyone but the owner, and does no work', async () => {
    const { gateway, calls } = harness();
    await gateway.onInteraction(buttonInteraction(approveId(5), STRANGER, calls));

    expect(calls.replies).toEqual([NOT_OWNER]);
    expect(calls.approve).toEqual([]);
    expect(calls.deferred).toBe(0);
  });

  it('says so when the proposal is gone rather than throwing', async () => {
    const { gateway, calls } = harness({ outcome: 'gone' });
    await gateway.onInteraction(buttonInteraction(approveId(9999), OWNER, calls));

    expect(calls.followUps).toEqual([UNKNOWN_ID]);
  });

  it('surfaces a handler failure to the owner instead of crashing the client', async () => {
    const { gateway, calls } = harness({ throws: true });
    await gateway.onInteraction(buttonInteraction(approveId(5), OWNER, calls));

    expect(calls.followUps).toHaveLength(1);
    expect(calls.followUps[0]).toContain('boom');
  });

  it('ignores a button it did not issue', async () => {
    const { gateway, calls } = harness();
    await gateway.onInteraction(buttonInteraction('paginate:2', OWNER, calls));

    expect(calls.deferred).toBe(0);
    expect(calls.approve).toEqual([]);
  });

  it('routes the approve-all confirmation to the bulk handler', async () => {
    const { gateway, calls } = harness();
    await gateway.onInteraction(buttonInteraction('approve-all:0', OWNER, calls));

    expect(calls.approveAll).toEqual([OWNER]);
    expect(calls.followUps[0]).toContain('Applied 3');
  });
});

describe('Gateway health', () => {
  it('alerts once after the window, through the reporter that reaches journald', async () => {
    let now = 0;
    const alerts: string[] = [];
    const gateway = new Gateway({
      botToken: 'token',
      ownerId: OWNER,
      decisions: {
        approve: async () => ({ outcome: 'approved', detail: '' }),
        ignore: async () => ({ outcome: 'ignored', detail: '' }),
        approveAll: async () => ({ approved: 0, failed: 0 }),
      },
      alert: async (_error, context) => void alerts.push(context),
      alertAfterMinutes: 15,
      log: () => {},
      now: () => now,
    });

    now = 10 * 60_000;
    await gateway.checkHealth();
    expect(alerts).toEqual([]);

    now = 16 * 60_000;
    await gateway.checkHealth();
    await gateway.checkHealth();
    expect(alerts).toEqual(['discord gateway']);
  });
});
