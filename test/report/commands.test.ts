import { describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { Commands } from '../../src/report/commands.js';
import { CustomRules } from '../../src/rules/customRules.js';
import { ShadowStore } from '../../src/scrub/shadowStore.js';
import { Approvals } from '../../src/scrub/approvals.js';
import { Executor } from '../../src/scrub/executor.js';
import { Planner } from '../../src/scrub/planner.js';
import type { Reporter } from '../../src/report/reporter.js';
import type { ProposalTransport } from '../../src/report/proposals.js';

const silent: Reporter = {
  corrections: async () => {},
  group: async () => {},
  summary: async () => {},
  report: async () => {},
  shadow: async () => {},
};

const transport: ProposalTransport = {
  enabled: true,
  channelId: 'chan',
  postProposal: async () => ({ messageId: 'm1' }),
  editMessage: async () => {},
};

function harness(
  opts: {
    approvalMode?: boolean;
    dryRun?: boolean;
    applyNow?: () => Promise<string>;
    shadowMode?: boolean;
    enabledRules?: ReadonlySet<string>;
  } = {},
) {
  const d = createDb(':memory:');
  runMigrations(d);
  const executor = new Executor(
    d,
    { apply: async () => 'verified' } as never,
    { apply: async () => 'verified' } as never,
    silent,
    { dryRun: false, maxEditsPerRun: 100, writeDelayMs: 0, digestEvery: 1 },
  );
  const approvals = new Approvals({
    db: d,
    executor,
    proposals: transport,
    freshToken: async () => 'fresh',
    ttlHours: 168,
    log: () => {},
  });
  const customRules = new CustomRules(d);
  const shadowStore = new ShadowStore(d);
  const applied: { kind: string; artist: string; fromTitle: string }[] = [];
  const commands = new Commands({
    db: d,
    approvals,
    customRules,
    applyNow: async (rule) => {
      applied.push(rule);
      return opts.applyNow === undefined ? 'Applied now: 1 write(s), 1 verified.' : await opts.applyNow();
    },
    approvalMode: opts.approvalMode ?? true,
    dryRun: opts.dryRun ?? false,
    shadowStore,
    shadowMode: opts.shadowMode ?? true,
    enabledRules: opts.enabledRules ?? new Set<string>(),
    channelId: 'chan',
    guildId: 'guild',
  });
  return { d, commands, approvals, executor, customRules, shadowStore, applied };
}

function seedLedger(d: ReturnType<typeof createDb>) {
  const base = {
    trackName: 'x',
    artistName: 'a',
    albumName: 'b',
    albumArtistName: 'c',
    groups: 'remaster',
    attempts: 0,
  };
  const rows = [
    { kind: 'track' as const, status: 'verified' as const, n: 3 },
    { kind: 'track' as const, status: 'unverified' as const, n: 1 },
    { kind: 'track' as const, status: 'failed' as const, n: 2 },
    { kind: 'album' as const, status: 'verified' as const, n: 5 },
    { kind: 'album' as const, status: 'applied' as const, n: 1 },
  ];
  let i = 0;
  for (const row of rows) {
    for (let k = 0; k < row.n; k++) {
      i++;
      d.insert(schema.appliedEdits)
        .values({
          ...base,
          trackNameOriginal: `t${i}`,
          artistNameOriginal: `ar${i}`,
          albumNameOriginal: `al${i}`,
          albumArtistNameOriginal: `aa${i}`,
          kind: row.kind,
          status: row.status,
        })
        .run();
    }
  }
}

describe('/scrub status', () => {
  it('names the mode and reads the live phase and pause flag', async () => {
    const h = harness({ approvalMode: true });
    h.d.insert(schema.sweepState)
      .values({ id: 1, phase: 'resolving', candidatesDone: 12, candidatesTotal: 40, paused: true })
      .run();

    const text = (await h.commands.handle('status')).text;

    expect(text).toContain('mode        approval');
    expect(text).toContain('resolving — PAUSED');
    expect(text).toContain('12/40 candidates');
  });

  it('says unattended when approval mode is off', async () => {
    expect((await harness({ approvalMode: false }).commands.handle('status')).text).toContain('unattended');
  });

  it('marks a dry run so the numbers are not mistaken for writes', async () => {
    expect((await harness({ dryRun: true }).commands.handle('status')).text).toContain('(dry run)');
  });
});

describe('/scrub stats', () => {
  it('counts albums and tracks separately, all-time', async () => {
    const h = harness();
    seedLedger(h.d);

    const text = (await h.commands.handle('stats')).text;

    // 5 verified + 1 applied albums; 3 verified tracks.
    expect(text).toMatch(/corrected\s+6\s+3/);
    expect(text).toMatch(/unverified\s+0\s+1/);
    expect(text).toMatch(/failed\s+0\s+2/);
    expect(text).toContain('total corrected 9');
  });

  it('reads zero cleanly on an empty ledger', async () => {
    expect((await harness().commands.handle('stats')).text).toContain('total corrected 0');
  });
});

describe('/scrub pending', () => {
  it('says so when nothing is waiting', async () => {
    expect((await harness().commands.handle('pending')).text).toBe('Nothing awaiting approval.');
  });

  it('lists a pending proposal with a jump link', async () => {
    const h = harness();
    await h.approvals.propose({
      kind: 'album',
      artist: 'Nirvana',
      album: {
        artist: 'Nirvana',
        from: 'In Utero (Deluxe Edition)',
        to: 'In Utero',
        csrfToken: 't',
        action: '/library/edit-album',
        refererPath: '/x',
        groups: ['edition'],
      },
      shared: { field: 'album_name', from: 'In Utero (Deluxe Edition)', to: 'In Utero' },
    });

    const text = (await h.commands.handle('pending')).text;

    expect(text).toContain('Nirvana');
    expect(text).toContain('In Utero (Deluxe Edition) -> In Utero');
    expect(text).toContain('https://discord.com/channels/guild/chan/m1');
  });
});

describe('/scrub approve-all', () => {
  it('asks for a confirmation rather than applying straight away', async () => {
    const h = harness();
    await h.approvals.propose({
      kind: 'album',
      artist: 'Nirvana',
      album: {
        artist: 'Nirvana',
        from: 'In Utero (Deluxe Edition)',
        to: 'In Utero',
        csrfToken: 't',
        action: '/library/edit-album',
        refererPath: '/x',
        groups: ['edition'],
      },
      shared: { field: 'album_name', from: 'In Utero (Deluxe Edition)', to: 'In Utero' },
    });

    const reply = await h.commands.handle('approve-all');

    expect(reply.confirm?.customId).toBe('approve-all:0');
    expect(reply.text).toContain('cannot be undone');
  });

  it('offers no button when nothing is pending', async () => {
    expect((await harness().commands.handle('approve-all')).confirm).toBeUndefined();
  });
});

describe('/scrub ignored and unignore', () => {
  it('round-trips an entry back into the planner', async () => {
    const h = harness();
    h.d.insert(schema.ignored)
      .values({ kind: 'track', artist: 'Slint', title: 'Good Morning, Captain', reason: 'x' })
      .run();

    expect((await h.commands.handle('ignored')).text).toContain('Slint');

    const planner = new Planner({} as never, 'u', new Set(['remaster']), h.d, 3);
    const candidate = { kind: 'track' as const, artist: 'Slint', title: 'Good Morning, Captain' };
    expect(planner.filterLive([candidate])).toEqual([]);

    const removed = (
      await h.commands.handle('unignore', {
        artist: 'Slint',
        title: 'Good Morning, Captain',
      })
    ).text;

    expect(removed).toContain('can be proposed again');
    expect(planner.filterLive([candidate])).toEqual([candidate]);
  });

  it('says so for an entry that was never ignored', async () => {
    expect((await harness().commands.handle('unignore', { artist: 'a', title: 'b' })).text).toContain(
      'Not on the ignore list',
    );
  });

  it('requires both fields', async () => {
    expect((await harness().commands.handle('unignore', { artist: '', title: 'b' })).text).toContain(
      'required',
    );
  });

  it('reports an empty list rather than an empty fence', async () => {
    expect((await harness().commands.handle('ignored')).text).toBe('The ignore list is empty.');
  });
});

describe('/scrub pause and resume', () => {
  it('sets the flag the worker reads at the candidate boundary', async () => {
    const h = harness();

    await h.commands.handle('pause');
    expect(h.d.select().from(schema.sweepState).all()[0]!.paused).toBe(true);

    await h.commands.handle('resume');
    expect(h.d.select().from(schema.sweepState).all()[0]!.paused).toBe(false);
  });
});

describe('/scrub resweep and retry-dead', () => {
  it('clears the cursor so the next sweep is full', async () => {
    const h = harness();
    h.d.insert(schema.sweepState).values({ id: 1, lastScrobbleUts: 1772659220 }).run();

    await h.commands.handle('resweep');

    expect(h.d.select().from(schema.sweepState).all()[0]!.lastScrobbleUts).toBeNull();
  });

  it('forgets the learned-empty candidates and says how many', async () => {
    const h = harness();
    h.d.insert(schema.deadCandidates)
      .values({ kind: 'track', artist: 'a', title: 'b', reason: 'x', lastTriedAt: new Date() })
      .run();

    expect((await h.commands.handle('retry-dead')).text).toContain('Forgot 1');
    expect(h.d.select().from(schema.deadCandidates).all()).toHaveLength(0);
  });
});

describe('unknown subcommand', () => {
  it('replies rather than throwing', async () => {
    expect((await harness().commands.handle('nonsense')).text).toContain('Unknown subcommand');
  });
});

describe('/scrub replace', () => {
  it('saves the rule and applies the named entity at once', async () => {
    const h = harness();

    const text = (
      await h.commands.handle('replace', {
        kind: 'album',
        artist: 'Pavement',
        from: 'Wowee Zowee: Sordid Sentinels Edition',
        to: 'Wowee Zowee',
      })
    ).text;

    expect(text).toContain('Rule saved');
    expect(text).toContain('Applied now');
    expect(h.customRules.list()).toHaveLength(1);
    expect(h.applied).toEqual([
      {
        kind: 'album',
        artist: 'Pavement',
        fromTitle: 'Wowee Zowee: Sordid Sentinels Edition',
      },
    ]);
  });

  it('makes the rule live for the engine immediately', async () => {
    const h = harness();
    await h.commands.handle('replace', {
      kind: 'track',
      artist: 'Slint',
      from: 'Good Morning, Captain',
      to: 'Good Morning Captain',
    });

    expect(h.customRules.lookup('track', 'Slint', 'Good Morning, Captain')).toBe(
      'Good Morning Captain',
    );
  });

  it('rejects a replacement that could never land, and writes nothing', async () => {
    const h = harness();

    const empty = (
      await h.commands.handle('replace', { kind: 'album', artist: 'A', from: 'X', to: '' })
    ).text;
    const casing = (
      await h.commands.handle('replace', { kind: 'album', artist: 'A', from: 'Xy', to: 'XY' })
    ).text;

    expect(empty).toContain('cannot be empty');
    expect(casing).toContain('only in casing');
    expect(h.customRules.list()).toHaveLength(0);
    expect(h.applied).toEqual([]);
  });

  it('rejects a kind that is neither track nor album', async () => {
    const h = harness();
    const text = (
      await h.commands.handle('replace', { kind: 'artist', artist: 'A', from: 'X', to: 'Y' })
    ).text;

    expect(text).toContain('track or album');
    expect(h.customRules.list()).toHaveLength(0);
  });

  it('refuses while paused rather than writing against a paused service', async () => {
    const h = harness();
    await h.commands.handle('pause');

    const text = (
      await h.commands.handle('replace', {
        kind: 'album',
        artist: 'Pavement',
        from: 'Wowee Zowee: Sordid Sentinels Edition',
        to: 'Wowee Zowee',
      })
    ).text;

    expect(text).toContain('paused');
    expect(h.applied).toEqual([]);
    expect(h.customRules.list()).toHaveLength(0);
  });

  it('reports the reason when the entity cannot be found yet', async () => {
    const h = harness({ applyNow: async () => 'Not applied yet: album no longer in library' });

    const text = (
      await h.commands.handle('replace', { kind: 'album', artist: 'A', from: 'Gone', to: 'Here' })
    ).text;

    expect(text).toContain('Not applied yet');
    // The rule is still saved: the entity may reappear, and the next sweep will catch it.
    expect(h.customRules.list()).toHaveLength(1);
  });
});

describe('/scrub rules and unrule', () => {
  it('lists a rule with its apply count', async () => {
    const h = harness();
    h.customRules.add({
      kind: 'album',
      artist: 'Pavement',
      fromTitle: 'Wowee Zowee: Sordid Sentinels Edition',
      toTitle: 'Wowee Zowee',
    });

    const text = (await h.commands.handle('rules')).text;

    expect(text).toContain('Pavement');
    expect(text).toContain('never applied');
  });

  it('says so when there are none', async () => {
    expect((await harness().commands.handle('rules')).text).toBe('No custom replacements set.');
  });

  it('removes one and reports a miss honestly', async () => {
    const h = harness();
    h.customRules.add({
      kind: 'album',
      artist: 'Pavement',
      fromTitle: 'Wowee Zowee: Sordid Sentinels Edition',
      toTitle: 'Wowee Zowee',
    });

    const removed = (
      await h.commands.handle('unrule', {
        kind: 'album',
        artist: 'Pavement',
        from: 'Wowee Zowee: Sordid Sentinels Edition',
      })
    ).text;
    const missing = (
      await h.commands.handle('unrule', { kind: 'album', artist: 'Nobody', from: 'Nothing' })
    ).text;

    expect(removed).toContain('Removed');
    expect(missing).toContain('No album rule');
    expect(h.customRules.list()).toHaveLength(0);
  });
});

describe('approval-only commands with the mode off', () => {
  it('explains rather than disappearing, so a missing command never reads as a broken bot', async () => {
    const h = harness({ approvalMode: false });

    const pending = (await h.commands.handle('pending')).text;
    const approveAll = (await h.commands.handle('approve-all')).text;

    expect(pending).toContain('Approval mode is off');
    expect(approveAll).toContain('Approval mode is off');
    expect(pending).toContain('APPROVAL_MODE=true');
  });

  it('still answers status and stats with the mode off', async () => {
    const h = harness({ approvalMode: false });

    expect((await h.commands.handle('status')).text).toContain('unattended');
    expect((await h.commands.handle('stats')).text).toContain('total corrected');
  });
});

describe('/scrub shadow', () => {
  it('explains that shadow mode is off rather than showing an empty list', async () => {
    const h = harness({ shadowMode: false });

    expect((await h.commands.handle('shadow')).text).toContain('Shadow mode is off');
  });

  it('says nothing is recorded yet when it is on but the sweep has not run', async () => {
    const h = harness({ shadowMode: true });

    expect((await h.commands.handle('shadow')).text).toContain('Nothing recorded yet');
  });

  it('lists what a disabled rule would have caught, with per-rule counts', async () => {
    const h = harness();
    h.shadowStore.record({
      rule: 'live-track',
      kind: 'track',
      artist: 'Nirvana',
      title: 'all apologies - live',
      wouldBe: 'all apologies',
    });

    const text = (await h.commands.handle('shadow')).text;

    expect(text).toContain('[live-track]');
    expect(text).toContain('all apologies');
    expect(text).toContain('live-track 1');
  });

  it('refuses a rule that is not experimental', async () => {
    const h = harness();

    expect((await h.commands.handle('shadow', { rule: 'remaster' })).text).toContain(
      'not an experimental rule',
    );
  });

  it('says so when the named rule is already enabled, not that it is clean', async () => {
    const h = harness({ enabledRules: new Set(['live-track']) });

    const text = (await h.commands.handle('shadow', { rule: 'live-track' })).text;

    expect(text).toContain('already enabled');
    expect(text).not.toContain('Nothing recorded');
  });

  it('forgets hits so they are announced again', async () => {
    const h = harness();
    h.shadowStore.record({
      rule: 'live-track',
      kind: 'track',
      artist: 'Nirvana',
      title: 'all apologies - live',
      wouldBe: 'all apologies',
    });

    const text = (await h.commands.handle('shadow-clear')).text;

    expect(text).toContain('Forgot 1');
    expect(h.shadowStore.list()).toEqual([]);
  });

  it('clears only the named rule', async () => {
    const h = harness();
    h.shadowStore.record({ rule: 'live-track', kind: 'track', artist: 'A', title: 'a - live', wouldBe: 'a' });
    h.shadowStore.record({ rule: 'version', kind: 'track', artist: 'A', title: 'b (radio edit)', wouldBe: 'b' });

    await h.commands.handle('shadow-clear', { rule: 'version' });

    expect(h.shadowStore.list().map((r) => r.rule)).toEqual(['live-track']);
  });
});
