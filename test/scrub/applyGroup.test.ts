import { describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../../src/db/index.js';
import { Executor } from '../../src/scrub/executor.js';
import type { Correction, CorrectionGroup, Reporter, RunTotals } from '../../src/report/reporter.js';
import { toAlbumGroup, toGroup, type PlannedEdit } from '../../src/scrub/types.js';

function spyReporter() {
  const groups: CorrectionGroup[] = [];
  const loose: Correction[][] = [];
  const reporter: Reporter = {
    corrections: async (items: Correction[], _t: RunTotals) => void loose.push(items),
    group: async (g: CorrectionGroup) => void groups.push(g),
    summary: async () => {},
    report: async () => {},
    shadow: async () => {},
  };
  return { groups, loose, reporter };
}

function db() {
  const d = createDb(':memory:');
  runMigrations(d);
  return d;
}

function trackEdit(track: string): PlannedEdit {
  const original = {
    track_name: track,
    artist_name: 'The Replacements',
    album_name: 'Let It Be (Deluxe Edition)',
    album_artist_name: 'The Replacements',
  };
  return {
    original,
    next: { ...original, album_name: 'Let It Be' },
    csrfToken: 'tok',
    timestamp: '1772659220',
    action: '/user/u/library/edit-track?edited-variation=library-track-scrobble',
    refererPath: '/user/u/library/music/+noredirect/The+Replacements/_/' + track,
    groups: ['edition'],
  };
}

const OPTS = { dryRun: false, maxEditsPerRun: 100, writeDelayMs: 0, digestEvery: 1 };

describe('Executor.applyGroup', () => {
  it('reports a multi-track candidate as one group, not one card per track', async () => {
    const { groups, loose, reporter } = spyReporter();
    const executor = new Executor(
      db(),
      { apply: async () => 'verified' } as never,
      {} as never,
      reporter,
      OPTS,
    );

    const edits = ['Bastards of Young', 'Left of the Dial', 'Kiss Me on the Bus'].map(trackEdit);
    await executor.applyGroup(toGroup('The Replacements', edits), new Set());

    expect(loose).toHaveLength(0);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('track');
    expect(groups[0]!.items).toHaveLength(3);
    expect(groups[0]!.shared?.to).toBe('Let It Be');
    expect(groups[0]!.outcome).toBe('verified');
  });

  it('colours the card by its worst member', async () => {
    const { groups, reporter } = spyReporter();
    let call = 0;
    const executor = new Executor(
      db(),
      {
        apply: async () => {
          call++;
          if (call === 2) throw new Error('rejected');
          return 'verified';
        },
      } as never,
      {} as never,
      reporter,
      OPTS,
    );

    await executor.applyGroup(
      toGroup('The Replacements', ['a', 'b'].map(trackEdit)),
      new Set(),
    );

    expect(groups[0]!.outcome).toBe('failed');
  });

  it('reports an album rename as a one-member album group', async () => {
    const { groups, loose, reporter } = spyReporter();
    const executor = new Executor(
      db(),
      {} as never,
      { apply: async () => 'verified' } as never,
      reporter,
      OPTS,
    );

    await executor.applyGroup(
      toAlbumGroup({
        artist: 'Nirvana',
        from: 'In Utero (Deluxe Edition)',
        to: 'In Utero',
        csrfToken: 'tok',
        action: '/library/edit-album',
        refererPath: '/x',
        groups: ['edition'],
      }),
      new Set(),
    );

    expect(loose).toHaveLength(0);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('album');
    expect(groups[0]!.items).toHaveLength(1);
    expect(groups[0]!.shared?.to).toBe('In Utero');
  });

  it('says nothing when the ledger already covered every member', async () => {
    const { groups, loose, reporter } = spyReporter();
    const d = db();
    const executor = new Executor(
      d,
      { apply: async () => 'verified' } as never,
      {} as never,
      reporter,
      OPTS,
    );

    const group = toGroup('The Replacements', [trackEdit('Bastards of Young')]);
    await executor.applyGroup(group, new Set());
    groups.length = 0;
    loose.length = 0;

    await executor.applyGroup(group, new Set());

    expect(groups).toHaveLength(0);
    expect(loose).toHaveLength(0);
  });
});
