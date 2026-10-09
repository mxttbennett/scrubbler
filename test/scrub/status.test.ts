import { describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { readDaemonStatus } from '../../src/scrub/status.js';

function ledgerRow(kind: 'track' | 'album', status: 'verified' | 'failed') {
  const album = kind === 'album';
  return {
    trackNameOriginal: album ? '' : `Track ${status}`,
    artistNameOriginal: album ? '' : 'Artist',
    albumNameOriginal: `Album ${kind} ${status}`,
    albumArtistNameOriginal: 'Artist',
    trackName: album ? '' : `Track ${status}`,
    artistName: album ? '' : 'Artist',
    albumName: `Album ${kind} ${status}`,
    albumArtistName: 'Artist',
    kind,
    groups: 'edition',
    status,
  } as const;
}

describe('readDaemonStatus', () => {
  it('returns sweep state, ledger counts by status and kind, and pending approvals', () => {
    const d = createDb(':memory:');
    runMigrations(d);
    d.insert(schema.sweepState)
      .values({
        id: 1,
        phase: 'resolving',
        paused: true,
        candidatesDone: 3,
        candidatesTotal: 7,
        lastScrobbleUts: 123,
      })
      .run();
    d.insert(schema.appliedEdits)
      .values([
        ledgerRow('track', 'verified'),
        ledgerRow('album', 'verified'),
        ledgerRow('track', 'failed'),
      ])
      .run();
    d.insert(schema.approvals)
      .values([
        { groupKey: 'pending', artist: 'A', kind: 'track', status: 'pending' },
        { groupKey: 'done', artist: 'B', kind: 'album', status: 'approved' },
      ])
      .run();

    const status = readDaemonStatus(d);

    expect(status.sweep).toMatchObject({
      phase: 'resolving',
      paused: true,
      candidatesDone: 3,
      candidatesTotal: 7,
      lastScrobbleUts: 123,
    });
    expect(status.ledger.byStatus).toMatchObject({ verified: 2, failed: 1 });
    expect(status.ledger.byKind.track).toMatchObject({ verified: 1, failed: 1 });
    expect(status.ledger.byKind.album).toMatchObject({ verified: 1, failed: 0 });
    expect(status.pendingApprovals).toBe(1);
  });

  it('returns zeroed counts and no sweep row for a fresh database', () => {
    const d = createDb(':memory:');
    runMigrations(d);

    const status = readDaemonStatus(d);

    expect(status.sweep).toBeUndefined();
    expect(status.ledger.byStatus.verified).toBe(0);
    expect(status.ledger.byKind.album.awaiting_approval).toBe(0);
    expect(status.pendingApprovals).toBe(0);
  });
});
