import { describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { Commands } from '../../src/report/commands.js';
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
};

const transport: ProposalTransport = {
  enabled: true,
  channelId: 'chan',
  postProposal: async () => ({ messageId: 'm1' }),
  editMessage: async () => {},
};

function harness(opts: { approvalMode?: boolean; dryRun?: boolean } = {}) {
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
  const commands = new Commands({
    db: d,
    approvals,
    approvalMode: opts.approvalMode ?? true,
    dryRun: opts.dryRun ?? false,
    channelId: 'chan',
    guildId: 'guild',
  });
  return { d, commands, approvals, executor };
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
  it('names the mode and reads the live phase and pause flag', () => {
    const h = harness({ approvalMode: true });
    h.d.insert(schema.sweepState)
      .values({ id: 1, phase: 'resolving', candidatesDone: 12, candidatesTotal: 40, paused: true })
      .run();

    const text = h.commands.handle('status').text;

    expect(text).toContain('mode        approval');
    expect(text).toContain('resolving — PAUSED');
    expect(text).toContain('12/40 candidates');
  });

  it('says unattended when approval mode is off', () => {
    expect(harness({ approvalMode: false }).commands.handle('status').text).toContain('unattended');
  });

  it('marks a dry run so the numbers are not mistaken for writes', () => {
    expect(harness({ dryRun: true }).commands.handle('status').text).toContain('(dry run)');
  });
});

describe('/scrub stats', () => {
  it('counts albums and tracks separately, all-time', () => {
    const h = harness();
    seedLedger(h.d);

    const text = h.commands.handle('stats').text;

    // 5 verified + 1 applied albums; 3 verified tracks.
    expect(text).toMatch(/corrected\s+6\s+3/);
    expect(text).toMatch(/unverified\s+0\s+1/);
    expect(text).toMatch(/failed\s+0\s+2/);
    expect(text).toContain('total corrected 9');
  });

  it('reads zero cleanly on an empty ledger', () => {
    expect(harness().commands.handle('stats').text).toContain('total corrected 0');
  });
});

describe('/scrub pending', () => {
  it('says so when nothing is waiting', () => {
    expect(harness().commands.handle('pending').text).toBe('Nothing awaiting approval.');
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

    const text = h.commands.handle('pending').text;

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

    const reply = h.commands.handle('approve-all');

    expect(reply.confirm?.customId).toBe('approve-all:0');
    expect(reply.text).toContain('cannot be undone');
  });

  it('offers no button when nothing is pending', () => {
    expect(harness().commands.handle('approve-all').confirm).toBeUndefined();
  });
});

describe('/scrub ignored and unignore', () => {
  it('round-trips an entry back into the planner', () => {
    const h = harness();
    h.d.insert(schema.ignored)
      .values({ kind: 'track', artist: 'Slint', title: 'Good Morning, Captain', reason: 'x' })
      .run();

    expect(h.commands.handle('ignored').text).toContain('Slint');

    const planner = new Planner({} as never, 'u', new Set(['remaster']), h.d, 3);
    const candidate = { kind: 'track' as const, artist: 'Slint', title: 'Good Morning, Captain' };
    expect(planner.filterLive([candidate])).toEqual([]);

    const removed = h.commands.handle('unignore', {
      artist: 'Slint',
      title: 'Good Morning, Captain',
    }).text;

    expect(removed).toContain('can be proposed again');
    expect(planner.filterLive([candidate])).toEqual([candidate]);
  });

  it('says so for an entry that was never ignored', () => {
    expect(harness().commands.handle('unignore', { artist: 'a', title: 'b' }).text).toContain(
      'Not on the ignore list',
    );
  });

  it('requires both fields', () => {
    expect(harness().commands.handle('unignore', { artist: '', title: 'b' }).text).toContain(
      'required',
    );
  });

  it('reports an empty list rather than an empty fence', () => {
    expect(harness().commands.handle('ignored').text).toBe('The ignore list is empty.');
  });
});

describe('/scrub pause and resume', () => {
  it('sets the flag the worker reads at the candidate boundary', () => {
    const h = harness();

    h.commands.handle('pause');
    expect(h.d.select().from(schema.sweepState).all()[0]!.paused).toBe(true);

    h.commands.handle('resume');
    expect(h.d.select().from(schema.sweepState).all()[0]!.paused).toBe(false);
  });
});

describe('/scrub resweep and retry-dead', () => {
  it('clears the cursor so the next sweep is full', () => {
    const h = harness();
    h.d.insert(schema.sweepState).values({ id: 1, lastScrobbleUts: 1772659220 }).run();

    h.commands.handle('resweep');

    expect(h.d.select().from(schema.sweepState).all()[0]!.lastScrobbleUts).toBeNull();
  });

  it('forgets the learned-empty candidates and says how many', () => {
    const h = harness();
    h.d.insert(schema.deadCandidates)
      .values({ kind: 'track', artist: 'a', title: 'b', reason: 'x', lastTriedAt: new Date() })
      .run();

    expect(h.commands.handle('retry-dead').text).toContain('Forgot 1');
    expect(h.d.select().from(schema.deadCandidates).all()).toHaveLength(0);
  });
});

describe('unknown subcommand', () => {
  it('replies rather than throwing', () => {
    expect(harness().commands.handle('nonsense').text).toContain('Unknown subcommand');
  });
});
