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
});
