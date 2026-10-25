import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GroupName } from '../../src/rules/markers.js';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { Commands } from '../../src/report/commands.js';
import { CustomRules } from '../../src/rules/customRules.js';
import { ShadowStore } from '../../src/scrub/shadowStore.js';
import { Approvals } from '../../src/scrub/approvals.js';
import { Executor } from '../../src/scrub/executor.js';
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
    gatedRules?: ReadonlySet<string>;
    dryRun?: boolean;
    applyNow?: () => Promise<string>;
    shadowMode?: boolean;
    enabledRules?: ReadonlySet<string>;
    configPanel?: { handle(customId: string): { content: string; components: unknown[] } };
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
  const customRules = new CustomRules(d);
  const approvals = new Approvals({
    db: d,
    executor,
    proposals: transport,
    freshToken: async () => 'fresh',
    ttlHours: 168,
    enabledGroups: () => new Set<GroupName>(['live-track', 'remaster', 'edition']),
    tiers: () => ({ remaster: 'auto', edition: 'auto', bonus: 'auto' }) as never,
    customRules,
    log: () => {},
  });
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
    gatedRules: opts.gatedRules ?? new Set<string>(opts.approvalMode ?? true ? ['remaster'] : []),
    dryRun: opts.dryRun ?? false,
    shadowStore,
    shadowMode: opts.shadowMode ?? true,
    enabledRules: opts.enabledRules ?? new Set<string>(),
    ...(opts.configPanel === undefined ? {} : { configPanel: opts.configPanel }),
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

  /** The one place in Discord that answers "which build is this?" — see VERSIONING.md. */
  it('names the running version, which is what makes a release traceable', async () => {
    const version = (
      JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;

    const text = (await harness().commands.handle('status')).text;

    expect(text).toContain(`version     ${version}`);
    expect(text).not.toContain('version     unknown');
  });

  it('says unattended when approval mode is off', async () => {
    expect((await harness({ approvalMode: false }).commands.handle('status')).text).toContain('unattended');
  });

  it('marks a dry run so the numbers are not mistaken for writes', async () => {
    expect((await harness({ dryRun: true }).commands.handle('status')).text).toContain('(dry run)');
  });
});

describe('/scrub status — the ledger table', () => {
  it('counts albums and tracks separately, all-time', async () => {
    const h = harness();
    seedLedger(h.d);

    const text = (await h.commands.handle('status')).text;

    // 5 verified + 1 applied albums; 3 verified tracks.
    expect(text).toMatch(/corrected\s+6\s+3/);
    expect(text).toMatch(/unverified\s+0\s+1/);
    expect(text).toMatch(/failed\s+0\s+2/);
    expect(text).toContain('total corrected 9');
  });

  it('reads zero cleanly on an empty ledger', async () => {
    expect((await harness().commands.handle('status')).text).toContain('total corrected 0');
  });
});

describe('/scrub config', () => {
  it('opens the config panel', async () => {
    const h = harness({
      configPanel: { handle: () => ({ content: 'Rule configuration', components: [] }) },
    });

    const reply = await h.commands.handle('config');

    expect(reply.text).toContain('Rule configuration');
    expect(reply.components).toEqual([]);
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

  it('pages past the first screen, so a long backlog stays reachable', async () => {
    const h = harness();
    for (let i = 0; i < 17; i++) {
      await h.approvals.propose({
        kind: 'album',
        artist: `Artist ${String(i).padStart(2, '0')}`,
        album: {
          artist: `Artist ${String(i).padStart(2, '0')}`,
          from: `Album ${i} - EP`,
          to: `Album ${i}`,
          csrfToken: 't',
          action: '/library/edit-album',
          refererPath: '/x',
          groups: ['ep-single'],
        },
        shared: { field: 'album_name', from: `Album ${i} - EP`, to: `Album ${i}` },
      });
    }

    const first = (await h.commands.handle('pending')).text;
    const second = (await h.commands.handle('pending', { page: 2 })).text;

    expect(first).toContain('Artist 00');
    expect(first).not.toContain('Artist 16');
    expect(second).toContain('Artist 16');
    expect(second).not.toContain('Artist 00');
    expect(second).toContain('page 2/2');
    expect(second).toContain('17 entries');
  });

  it('reports a page past the end rather than an empty list', async () => {
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

    const text = (await h.commands.handle('pending', { page: 9 })).text;

    expect(text).toContain('past the end');
    expect(text).toContain('1 entr');
  });
});

describe('/scrub reset proposals', () => {
  it('asks for a confirmation carrying the rule, rather than dropping straight away', async () => {
    const h = harness();
    await h.approvals.propose({
      kind: 'album',
      artist: 'HalfNoise',
      album: {
        artist: 'HalfNoise',
        from: 'Flowerss - EP',
        to: 'Flowerss',
        csrfToken: 't',
        action: '/library/edit-album',
        refererPath: '/x',
        groups: ['ep-single'],
      },
      shared: { field: 'album_name', from: 'Flowerss - EP', to: 'Flowerss' },
    });

    const reply = await h.commands.handle('reset', { target: 'proposals', rule: 'ep-single' });

    expect(reply.confirm?.customId).toBe('repropose:ep-single');
    expect(reply.text).toContain('1 pending proposal');
    expect(reply.text).toContain('Nothing is written to Last.fm');
    // Still pending: the reply is a question, not the action.
    expect(h.approvals.pending()).toHaveLength(1);
  });

  it('says so when no pending proposal carries the rule, and offers no button', async () => {
    const reply = await harness().commands.handle('reset', { target: 'proposals', rule: 'live-track' });
    expect(reply.text).toBe('No pending proposal carries live-track.');
    expect(reply.confirm).toBeUndefined();
  });

  it('rejects a rule outside the catalogue', async () => {
    const reply = await harness().commands.handle('reset', { target: 'proposals', rule: 'nonsense' });
    expect(reply.text).toContain('Unknown rule');
    expect(reply.confirm).toBeUndefined();
  });
});

describe('/scrub pending — the apply-all button', () => {
  it('carries the bulk action on the list, so the decision is taken while looking at it', async () => {
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

    const reply = await h.commands.handle('pending');

    expect(reply.confirm?.customId).toBe('approve-all:0');
    expect(reply.text).toContain('cannot be undone');
    // The list itself is still there; the button did not replace it.
    expect(reply.text).toContain('Nirvana');
  });

  it('offers no button when nothing is pending', async () => {
    expect((await harness().commands.handle('pending')).confirm).toBeUndefined();
  });
});

describe('/scrub reset — one verb, four targets', () => {
  it('rejects an unknown target', async () => {
    const reply = await harness().commands.handle('reset', { target: 'everything' });
    expect(reply.text).toContain('Unknown target');
  });

  it('refuses a rule on a target that has no rules', async () => {
    const reply = await harness().commands.handle('reset', { target: 'cursor', rule: 'remaster' });
    expect(reply.text).toContain('takes no rule');
  });

  it('needs a rule for proposals, which is the one target that discards decisions', async () => {
    const reply = await harness().commands.handle('reset', { target: 'proposals' });
    expect(reply.text).toContain('needs a rule');
  });

  /** Only proposals confirms; the rest clear derived state the next sweep rebuilds. */
  it('acts straight away on the derived-state targets', async () => {
    const h = harness();
    expect((await h.commands.handle('reset', { target: 'cursor' })).confirm).toBeUndefined();
    expect((await h.commands.handle('reset', { target: 'dead' })).confirm).toBeUndefined();
    expect((await h.commands.handle('reset', { target: 'shadow' })).confirm).toBeUndefined();
  });
});

describe('/scrub reset cursor and dead', () => {
  it('clears the cursor so the next sweep is full', async () => {
    const h = harness();
    h.d.insert(schema.sweepState).values({ id: 1, lastScrobbleUts: 1772659220 }).run();

    await h.commands.handle('reset', { target: 'cursor' });

    expect(h.d.select().from(schema.sweepState).all()[0]!.lastScrobbleUts).toBeNull();
  });

  it('forgets the learned-empty candidates and says how many', async () => {
    const h = harness();
    h.d.insert(schema.deadCandidates)
      .values({ kind: 'track', artist: 'a', title: 'b', reason: 'x', lastTriedAt: new Date() })
      .run();

    expect((await h.commands.handle('reset', { target: 'dead' })).text).toContain('Forgot 1');
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
    h.d.insert(schema.sweepState).values({ id: 1, paused: true }).run();

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

describe('approval-only commands with the mode off', () => {
  it('explains rather than disappearing, so a missing command never reads as a broken bot', async () => {
    const h = harness({ approvalMode: false });

    const pending = (await h.commands.handle('pending')).text;

    expect(pending).toContain('No rule is gated');
    expect(pending).toContain('gated');
  });

  it('still answers status with the mode off', async () => {
    const h = harness({ approvalMode: false });
    const text = (await h.commands.handle('status')).text;

    expect(text).toContain('unattended');
    expect(text).toContain('total corrected');
  });

  it('keeps a durable MCP proposal visible and bulk-decidable with no gated catalogue rule', async () => {
    const h = harness({ approvalMode: false });
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
        groups: ['custom', 'mcp'],
      },
      shared: { field: 'album_name', from: 'In Utero (Deluxe Edition)', to: 'In Utero' },
    });

    const reply = await h.commands.handle('pending');

    expect(reply.text).toContain('Nirvana');
    expect(reply.confirm).toEqual({ customId: 'approve-all:0', label: 'Apply all 1' });
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

  /** Every group is nameable now that tiers are the operator's choice, so only a typo is refused. */
  /** A gated tier creates proposals on its own, so the command surface must not deny them. */
  it('offers the approval commands for a gated rule with no APPROVAL_MODE', async () => {
    const h = harness({ gatedRules: new Set(['live-album']) });

    expect((await h.commands.handle('pending')).text).not.toContain('No rule is gated');
    expect((await h.commands.handle('approve-all')).text).not.toContain('No rule is gated');
  });

  it('names the groups by tier on the status card', async () => {
    const h = harness({
      gatedRules: new Set(['live-album']),
      enabledRules: new Set(['remaster', 'live-album']),
    });

    const text = (await h.commands.handle('status')).text;

    expect(text).toContain('1 auto (remaster)');
    expect(text).toContain('1 gated (live-album)');
  });

  it('refuses a name that is not a rule at all', async () => {
    const h = harness();

    expect((await h.commands.handle('shadow', { rule: 'remastr' })).text).toContain(
      'is not a rule',
    );
  });

  it('accepts a default-on rule, which is shadowable once it is off', async () => {
    const h = harness();

    expect((await h.commands.handle('shadow', { rule: 'remaster' })).text).not.toContain(
      'is not a rule',
    );
  });

  it('says so when the named rule is not off, not that it is clean', async () => {
    const h = harness({ enabledRules: new Set(['live-track']) });

    const text = (await h.commands.handle('shadow', { rule: 'live-track' })).text;

    expect(text).toContain('is not off');
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

    const text = (await h.commands.handle('reset', { target: 'shadow' })).text;

    expect(text).toContain('Forgot 1');
    expect(h.shadowStore.list()).toEqual([]);
  });

  it('clears only the named rule', async () => {
    const h = harness();
    h.shadowStore.record({ rule: 'live-track', kind: 'track', artist: 'A', title: 'a - live', wouldBe: 'a' });
    h.shadowStore.record({ rule: 'version', kind: 'track', artist: 'A', title: 'b (radio edit)', wouldBe: 'b' });

    await h.commands.handle('reset', { target: 'shadow', rule: 'version' });

    expect(h.shadowStore.list().map((r) => r.rule)).toEqual(['live-track']);
  });
});
