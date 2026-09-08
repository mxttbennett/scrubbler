import { describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { Executor } from '../../src/scrub/executor.js';
import type { PlannedEdit } from '../../src/scrub/types.js';
import type { Correction, Reporter, RunTotals } from '../../src/report/reporter.js';

function db() {
  const d = createDb(':memory:');
  runMigrations(d);
  return d;
}

const silentReporter: Reporter = {
  corrections: async (_i: Correction[], _t: RunTotals) => {},
  group: async () => {},
  summary: async () => {},
  report: async () => {},
};

function edit(): PlannedEdit {
  return {
    original: {
      track_name: 'Disorder - 2019 Digital Master',
      artist_name: 'Joy Division',
      album_name: 'Unknown Pleasures',
      album_artist_name: 'Joy Division',
    },
    next: {
      track_name: 'Disorder',
      artist_name: 'Joy Division',
      album_name: 'Unknown Pleasures',
      album_artist_name: 'Joy Division',
    },
    timestamp: '1772659220',
    csrfToken: 'stale-token',
    action: '/user/u/library/edit-track?edited-variation=library-track-scrobble',
    refererPath: '/user/u/library/music/+noredirect/Joy+Division/_/Disorder',
    groups: ['remaster'],
  };
}

function executor(d: ReturnType<typeof db>) {
  return new Executor(d, {} as never, silentReporter, {
    dryRun: false,
    maxEditsPerRun: 100,
    writeDelayMs: 0,
    digestEvery: 1,
  });
}

describe('resolution checkpointing', () => {
  it('records a resolved tuple as planned before anything is written', () => {
    const d = db();
    executor(d).checkpoint(edit());

    const rows = d.select().from(schema.appliedEdits).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('planned');
    expect(rows[0]!.timestamp).toBe('1772659220');
    expect(rows[0]!.action).toContain('edit-track');
  });

  it('resumes a planned tuple with a fresh token rather than the stale one', () => {
    const d = db();
    const e = executor(d);
    e.checkpoint(edit());

    const carried = e.resumable('fresh-token');
    expect(carried).toHaveLength(1);
    expect(carried[0]!.csrfToken).toBe('fresh-token');
    expect(carried[0]!.original.track_name).toBe('Disorder - 2019 Digital Master');
    expect(carried[0]!.next.track_name).toBe('Disorder');
    expect(carried[0]!.groups).toEqual(['remaster']);
    // verification re-reads this path; the write endpoint has no chartlist and can never confirm
    expect(carried[0]!.refererPath).toBe('/user/u/library/music/+noredirect/Joy+Division/_/Disorder');
    expect(carried[0]!.refererPath).not.toContain('edit-track');
  });

  it('does not resume a tuple that already succeeded', () => {
    const d = db();
    const e = executor(d);
    e.checkpoint(edit());
    d.update(schema.appliedEdits).set({ status: 'verified' }).run();

    expect(e.resumable('fresh-token')).toEqual([]);
  });

  it('leaves an already-verified tuple alone when checkpointed again', () => {
    const d = db();
    const e = executor(d);
    e.checkpoint(edit());
    d.update(schema.appliedEdits).set({ status: 'verified' }).run();
    e.checkpoint(edit());

    const rows = d.select().from(schema.appliedEdits).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('verified');
  });

  it('skips a planned row too old to carry the fields a write needs', () => {
    const d = db();
    const e = executor(d);
    e.checkpoint(edit());
    d.update(schema.appliedEdits).set({ timestamp: null, action: null }).run();

    expect(e.resumable('fresh-token')).toEqual([]);
  });

  it('skips a planned row with no referer path, which could never be verified', () => {
    const d = db();
    const e = executor(d);
    e.checkpoint(edit());
    d.update(schema.appliedEdits).set({ refererPath: null }).run();

    expect(e.resumable('fresh-token')).toEqual([]);
  });
});

describe('streaming writes during resolution', () => {
  it('accumulates one summary across many single-edit calls', async () => {
    const d = db();
    const applied: string[] = [];
    const e = new Executor(
      d,
      {
        apply: async (edit: PlannedEdit) => {
          applied.push(edit.original.track_name);
          return 'verified' as const;
        },
      } as never,
      silentReporter,
      { dryRun: false, maxEditsPerRun: 100, writeDelayMs: 0, digestEvery: 1 },
    );

    await e.applyOne(edit(), new Set());
    const second = edit();
    second.original.track_name = 'Isolation - 2020 Digital Master';
    second.next.track_name = 'Isolation';
    await e.applyOne(second, new Set());

    expect(applied).toHaveLength(2);
    expect(e.streamedSummary.applied).toBe(2);
    expect(e.streamedSummary.verified).toBe(2);
    expect(e.streamedSummary.planned).toBe(2);
  });

  it('stops writing once the run cap is reached, even one edit at a time', async () => {
    const d = db();
    let calls = 0;
    const e = new Executor(
      d,
      { apply: async () => { calls++; return 'verified' as const; } } as never,
      silentReporter,
      { dryRun: false, maxEditsPerRun: 2, writeDelayMs: 0, digestEvery: 1 },
    );

    for (const track of ['a - Remastered', 'b - Remastered', 'c - Remastered']) {
      const p = edit();
      p.original.track_name = track;
      p.next.track_name = track.replace(' - Remastered', '');
      await e.applyOne(p, new Set());
    }

    expect(calls).toBe(2);
    expect(e.streamedSummary.capped).toBe(true);
  });

  it('does not rewrite a tuple already verified in the ledger', async () => {
    const d = db();
    let calls = 0;
    const e = new Executor(
      d,
      { apply: async () => { calls++; return 'verified' as const; } } as never,
      silentReporter,
      { dryRun: false, maxEditsPerRun: 100, writeDelayMs: 0, digestEvery: 1 },
    );

    await e.applyOne(edit(), new Set());
    await e.applyOne(edit(), new Set());

    expect(calls).toBe(1);
    expect(e.streamedSummary.skippedByLedger).toBe(1);
  });
});
