import { describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { Executor } from '../../src/scrub/executor.js';
import type { PlannedAlbumEdit } from '../../src/lastfm/albumEditor.js';
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

function albumEdit(): PlannedAlbumEdit {
  return {
    artist: 'The Replacements',
    from: 'Tim (Remastered)',
    to: 'Tim',
    csrfToken: 'tok',
    action: '/user/u/library/edit-album?edited-variation=library-album-scrobble',
    refererPath: '/user/u/library/music/+noredirect/The+Replacements/Tim+(Remastered)',
    groups: ['remaster'],
  };
}

function exec(d: ReturnType<typeof db>, apply: () => Promise<'verified' | 'unverified'>) {
  return new Executor(d, {} as never, { apply } as never, silent, {
    dryRun: false,
    maxEditsPerRun: 100,
    writeDelayMs: 0,
    digestEvery: 1,
  });
}

describe('album renames reach the ledger', () => {
  it('records a verified album rename as a kind=album row with empty track fields', async () => {
    const d = db();
    await exec(d, async () => 'verified').applyOneAlbum(albumEdit());

    const rows = d.select().from(schema.appliedEdits).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('album');
    expect(rows[0]!.trackNameOriginal).toBe('');
    expect(rows[0]!.albumNameOriginal).toBe('Tim (Remastered)');
    expect(rows[0]!.albumName).toBe('Tim');
    expect(rows[0]!.status).toBe('verified');
  });

  it('does not re-apply an album already verified', async () => {
    const d = db();
    let calls = 0;
    const e = exec(d, async () => {
      calls++;
      return 'verified';
    });
    await e.applyOneAlbum(albumEdit());
    await e.applyOneAlbum(albumEdit());

    expect(calls).toBe(1);
    expect(e.streamedSummary.skippedByLedger).toBe(1);
  });

  it('backs off a repeatedly failing album rename instead of retrying forever', async () => {
    const d = db();
    for (let i = 0; i < 5; i++) {
      const e = exec(d, async () => {
        throw new Error('rejected');
      });
      await e.applyOneAlbum(albumEdit());
    }
    const row = d.select().from(schema.appliedEdits).all()[0]!;
    expect(row.status).toBe('failed');
    // MAX_ATTEMPTS is 3, so the 4th and 5th passes must not have called through
    expect(row.attempts).toBeLessThanOrEqual(3);
  });

  it('checkpoints as planned before writing, so an interrupted album rename resumes', () => {
    const d = db();
    exec(d, async () => 'verified').checkpointAlbum(albumEdit());
    const row = d.select().from(schema.appliedEdits).all()[0]!;
    expect(row.status).toBe('planned');
    expect(row.kind).toBe('album');
    expect(row.refererPath).toContain('+noredirect');
  });

  it('leaves an already-verified album alone when checkpointed again', async () => {
    const d = db();
    const e = exec(d, async () => 'verified');
    await e.applyOneAlbum(albumEdit());
    e.checkpointAlbum(albumEdit());
    expect(d.select().from(schema.appliedEdits).all()[0]!.status).toBe('verified');
  });

  it('records an unverified album rename rather than losing it', async () => {
    const d = db();
    const e = exec(d, async () => 'unverified');
    await e.applyOneAlbum(albumEdit());
    expect(d.select().from(schema.appliedEdits).all()[0]!.status).toBe('unverified');
    expect(e.streamedSummary.unverified).toBe(1);
  });
});

describe('an album rename survives a restart with its track list', () => {
  const withTracks = (): PlannedAlbumEdit => ({
    ...albumEdit(),
    trackNames: ['Making Flippy Floppy', 'Found a Job', 'Genius Of Love (Tom Tom Club)'],
  });

  it('persists the track list, since the album page is gone once the rename lands', () => {
    const d = db();
    exec(d, async () => 'verified').checkpointAlbum(withTracks());

    const carried = exec(d, async () => 'verified').resumable('fresh-token');

    expect(carried).toHaveLength(1);
    const first = carried[0]!;
    if (first.kind !== 'album') throw new Error('expected an album edit');
    expect(first.edit.trackNames).toEqual([
      'Making Flippy Floppy',
      'Found a Job',
      'Genius Of Love (Tom Tom Club)',
    ]);
  });

  it('keeps a name containing a comma intact, which comma-joining would have split', () => {
    const d = db();
    exec(d, async () => 'verified').checkpointAlbum({
      ...albumEdit(),
      trackNames: ['Good Morning, Captain', 'Nosferatu Man'],
    });

    const carried = exec(d, async () => 'verified').resumable('fresh-token');
    const first = carried[0]!;
    if (first.kind !== 'album') throw new Error('expected an album edit');

    expect(first.edit.trackNames).toEqual(['Good Morning, Captain', 'Nosferatu Man']);
  });

  it('resumes an album row written before the column existed', () => {
    const d = db();
    exec(d, async () => 'verified').checkpointAlbum(withTracks());
    // Exactly what a pre-0007 row looks like.
    d.update(schema.appliedEdits).set({ trackNames: null }).run();

    const carried = exec(d, async () => 'verified').resumable('fresh-token');
    const first = carried[0]!;
    if (first.kind !== 'album') throw new Error('expected an album edit');

    expect(first.edit.trackNames).toBeUndefined();
    expect(first.edit.from).toBe('Tim (Remastered)');
  });

  it('does not throw on a malformed value', () => {
    const d = db();
    exec(d, async () => 'verified').checkpointAlbum(withTracks());
    d.update(schema.appliedEdits).set({ trackNames: 'not json' }).run();

    const carried = exec(d, async () => 'verified').resumable('fresh-token');
    const first = carried[0]!;
    if (first.kind !== 'album') throw new Error('expected an album edit');

    expect(first.edit.trackNames).toBeUndefined();
  });

  it('reports the track list after a resumed apply, which is the bug this fixes', async () => {
    const items: Correction[] = [];
    const d = db();
    const reporter: Reporter = {
      corrections: async (c: Correction[]) => void items.push(...c),
      group: async () => {},
      summary: async () => {},
      report: async () => {},
      shadow: async () => {},
    };
    const e = new Executor(d, {} as never, { apply: async () => 'verified' } as never, reporter, {
      dryRun: false,
      maxEditsPerRun: 100,
      writeDelayMs: 0,
      digestEvery: 1,
    });

    e.checkpointAlbum(withTracks());
    await e.applyCarried(e.resumable('fresh-token'), new Set());

    expect(items[0]!.scrobbledTracks).toEqual([
      'Making Flippy Floppy',
      'Found a Job',
      'Genius Of Love (Tom Tom Club)',
    ]);
  });
});
