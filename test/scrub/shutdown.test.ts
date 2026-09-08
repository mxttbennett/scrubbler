import { describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { Executor } from '../../src/scrub/executor.js';
import type { PlannedEdit } from '../../src/scrub/types.js';
import type { Correction, Reporter, RunTotals } from '../../src/report/reporter.js';

const silent: Reporter = {
  corrections: async (_i: Correction[], _t: RunTotals) => {},
  group: async () => {},
  summary: async () => {},
  report: async () => {},
  shadow: async () => {},
};

function db() {
  const d = createDb(':memory:');
  runMigrations(d);
  return d;
}

function edit(track: string): PlannedEdit {
  return {
    original: { track_name: track, artist_name: 'A', album_name: 'L', album_artist_name: 'A' },
    next: { track_name: track.replace(' - Remastered', ''), artist_name: 'A', album_name: 'L', album_artist_name: 'A' },
    timestamp: '1',
    csrfToken: 't',
    action: '/user/u/library/edit-track',
    refererPath: '/user/u/library/music/+noredirect/A/_/B',
    groups: ['remaster'],
  };
}

describe('graceful drain', () => {
  it('lets the in-flight write finish and record its ledger row', async () => {
    const d = db();
    let inFlight = 0;
    let completed = 0;
    const ex: Executor = new Executor(
      d,
      {
        apply: async () => {
          inFlight++;
          // a stop arriving mid-write must not abandon it
          ex.requestStop();
          await new Promise((r) => setTimeout(r, 5));
          completed++;
          return 'verified' as const;
        },
      } as never,
      {} as never,
      silent,
      { dryRun: false, maxEditsPerRun: 100, writeDelayMs: 0, digestEvery: 1 },
    );

    await ex.run([edit('a - Remastered'), edit('b - Remastered')], new Set());

    expect(inFlight).toBe(1);
    expect(completed).toBe(1);
    const rows = d.select().from(schema.appliedEdits).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('verified');
  });

  it('stops before the next write once a stop is requested', async () => {
    const d = db();
    let calls = 0;
    const ex = new Executor(
      d,
      { apply: async () => { calls++; return 'verified' as const; } } as never,
      {} as never,
      silent,
      { dryRun: false, maxEditsPerRun: 100, writeDelayMs: 0, digestEvery: 1 },
    );
    ex.requestStop();
    await ex.run([edit('a - Remastered'), edit('b - Remastered')], new Set());
    expect(calls).toBe(0);
    expect(ex.stopping).toBe(true);
  });
});
