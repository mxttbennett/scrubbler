import { describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../../src/db/index.js';
import { Approvals, CARRY_OVER_TOKEN } from '../../src/scrub/approvals.js';
import { Executor } from '../../src/scrub/executor.js';
import { isGated } from '../../src/scrub/tiers.js';
import type { PlannedEdit } from '../../src/scrub/types.js';
import type { PlannedAlbumEdit } from '../../src/lastfm/albumEditor.js';
import type { GroupName } from '../../src/rules/markers.js';
import type { Reporter } from '../../src/report/reporter.js';
import type { ProposalTransport } from '../../src/report/proposals.js';

const silent: Reporter = {
  corrections: async () => {},
  group: async () => {},
  summary: async () => {},
  report: async () => {},
  shadow: async () => {},
};

const GATED = new Set<GroupName>(['live-album']);

function edit(track: string, groups: string[]): PlannedEdit {
  const original = {
    track_name: track,
    artist_name: 'Yes',
    album_name: 'Yessongs (Live)',
    album_artist_name: 'Yes',
  };
  return {
    original,
    next: { ...original, album_name: 'Yessongs' },
    csrfToken: 'stale',
    timestamp: '1772659220',
    action: '/user/u/library/edit-track',
    refererPath: `/user/u/library/music/Yes/_/${track}`,
    groups: groups as PlannedEdit['groups'],
  };
}

function harness() {
  const d = createDb(':memory:');
  runMigrations(d);
  const applied: string[] = [];
  let posted = 0;
  const executor = new Executor(
    d,
    { apply: async (e: PlannedEdit) => {
        applied.push(e.original.track_name);
        return 'verified';
      } } as never,
    { apply: async (e: PlannedAlbumEdit) => {
        applied.push(e.from);
        return 'verified';
      } } as never,
    silent,
    { dryRun: false, maxEditsPerRun: 100, writeDelayMs: 0, digestEvery: 1 },
  );
  const transport: ProposalTransport = {
    enabled: true,
    channelId: 'chan',
    postProposal: async () => ({ messageId: `m${++posted}` }),
    editMessage: async () => {},
  };
  const approvals = new Approvals({
    db: d,
    executor,
    proposals: transport,
    freshToken: async () => 'fresh',
    ttlHours: 168,
    enabledGroups: new Set<GroupName>(['live-track', 'remaster', 'edition']),
    log: () => {},
  });
  return { executor, approvals, applied, posted: () => posted };
}

describe('the resume path partitions carried rows by tier', () => {
  /**
   * The ordering is what keeps the two sides disjoint: proposing moves a row to
   * `awaiting_approval`, and resumable() selects only `planned`. So the second read needs no tier
   * filter, and no row can be both proposed and written.
   */
  it('proposes the gated rows and leaves only the rest resumable', async () => {
    const h = harness();
    h.executor.checkpoint(edit('Roundabout', ['live-album']));
    h.executor.checkpoint(edit('Heart of the Sunrise', ['edition']));

    const gatedRows = h.executor
      .resumable(CARRY_OVER_TOKEN)
      .filter((row) => isGated(row.edit.groups, GATED));
    expect(gatedRows).toHaveLength(1);

    await h.approvals.carryOver(gatedRows);

    const stillWritable = h.executor.resumable('real-token');
    expect(stillWritable.map((r) => r.edit.groups)).toEqual([['edition']]);
    expect(h.posted()).toBe(1);
  });

  it('writes nothing while proposing', async () => {
    const h = harness();
    h.executor.checkpoint(edit('Roundabout', ['live-album']));

    await h.approvals.carryOver(
      h.executor.resumable(CARRY_OVER_TOKEN).filter((r) => isGated(r.edit.groups, GATED)),
    );

    expect(h.applied).toEqual([]);
  });

  it('proposes only the rows it is handed, not every planned row', async () => {
    const h = harness();
    h.executor.checkpoint(edit('Roundabout', ['live-album']));
    h.executor.checkpoint(edit('Perpetual Change', ['live-album']));

    const one = h.executor.resumable(CARRY_OVER_TOKEN).slice(0, 1);
    await h.approvals.carryOver(one);

    expect(h.posted()).toBe(1);
    expect(h.executor.resumable('real-token')).toHaveLength(1);
  });

  it('reads every planned row when handed nothing, which is the all-gated case', async () => {
    const h = harness();
    h.executor.checkpoint(edit('Roundabout', ['live-album']));
    h.executor.checkpoint(edit('Perpetual Change', ['live-album']));

    await h.approvals.carryOver();

    expect(h.executor.resumable('real-token')).toHaveLength(0);
  });

  /** A stale name from an older build must not silently become a gated row nobody proposed. */
  it('leaves a row whose stored group is no longer a group writable', async () => {
    const h = harness();
    h.executor.checkpoint(edit('Roundabout', ['live']));

    const gatedRows = h.executor
      .resumable(CARRY_OVER_TOKEN)
      .filter((row) => isGated(row.edit.groups, GATED));

    expect(gatedRows).toHaveLength(0);
    expect(h.executor.resumable('real-token')).toHaveLength(1);
  });
});
