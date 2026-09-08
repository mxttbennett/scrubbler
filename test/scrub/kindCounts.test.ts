import { describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../../src/db/index.js';
import { Executor } from '../../src/scrub/executor.js';
import type { PlannedAlbumEdit } from '../../src/lastfm/albumEditor.js';
import type { Correction, Reporter, RunTotals } from '../../src/report/reporter.js';
import type { PlannedEdit } from '../../src/scrub/types.js';

function spy() {
  const items: Correction[] = [];
  const totals: RunTotals[] = [];
  const reporter: Reporter = {
    corrections: async (c: Correction[], t: RunTotals) => {
      items.push(...c);
      totals.push(t);
    },
    group: async () => {},
    summary: async () => {},
    report: async () => {},
    shadow: async () => {},
  };
  return { items, totals, reporter };
}

function db() {
  const d = createDb(':memory:');
  runMigrations(d);
  return d;
}

function trackEdit(track: string): PlannedEdit {
  const original = {
    track_name: `${track} - Remastered`,
    artist_name: 'Joy Division',
    album_name: 'Unknown Pleasures',
    album_artist_name: 'Joy Division',
  };
  return {
    original,
    next: { ...original, track_name: track },
    csrfToken: 'tok',
    timestamp: '1772659220',
    action: '/user/u/library/edit-track',
    refererPath: `/user/u/library/music/+noredirect/Joy+Division/_/${track}`,
    groups: ['remaster'],
  };
}

function albumEdit(trackNames?: string[]): PlannedAlbumEdit {
  return {
    artist: 'Nirvana',
    from: 'In Utero (Deluxe Edition)',
    to: 'In Utero',
    csrfToken: 'tok',
    action: '/library/edit-album',
    refererPath: '/x',
    groups: ['edition'],
    ...(trackNames === undefined ? {} : { trackNames }),
  };
}

/** The album page renders its track list client-side, so this comes from album.getinfo. */
function detailsOf(trackNames: string[], scrobbles?: number) {
  return async () => ({
    imageUrl: undefined,
    trackNames,
    ...(scrobbles === undefined ? { scrobbles: undefined } : { scrobbles }),
  });
}

const OPTS = { dryRun: false, maxEditsPerRun: 100, writeDelayMs: 0, digestEvery: 1 };

function executor(
  reporter: Reporter,
  opts: {
    failAlbum?: boolean;
    failTrack?: boolean;
    albumDetails?: (artist: string, album: string) => Promise<{
      imageUrl: string | undefined;
      trackNames: string[];
      scrobbles: number | undefined;
    }>;
    trackScrobbles?: (artist: string, track: string) => Promise<number | undefined>;
    onApply?: () => void;
  } = {},
) {
  return new Executor(
    db(),
    {
      apply: async () => {
        opts.onApply?.();
        if (opts.failTrack === true) throw new Error('track rejected');
        return 'verified';
      },
    } as never,
    {
      apply: async () => {
        if (opts.failAlbum === true) throw new Error('album rejected');
        return 'verified';
      },
    } as never,
    reporter,
    {
      ...OPTS,
      ...(opts.albumDetails === undefined ? {} : { albumDetails: opts.albumDetails }),
      ...(opts.trackScrobbles === undefined ? {} : { trackScrobbles: opts.trackScrobbles }),
    },
  );
}

describe('per-run counts by kind', () => {
  it('counts an album rename as one album, never as a track edit', async () => {
    const s = spy();
    const e = executor(s.reporter);

    await e.applyOneAlbum(albumEdit());

    expect(e.streamedSummary.byKind.album.applied).toBe(1);
    expect(e.streamedSummary.byKind.track.applied).toBe(0);
    expect(e.streamedSummary.applied).toBe(1);
  });

  it('records how many tracks the album rename covered', async () => {
    const s = spy();
    const e = executor(s.reporter, { albumDetails: detailsOf([], 52) });

    await e.applyOneAlbum(albumEdit(['a', 'b', 'c', 'd']));

    expect(e.streamedSummary.byKind.album.tracksCovered).toBe(4);
    expect(e.streamedSummary.byKind.album.scrobblesCovered).toBe(52);
  });

  it('counts track edits and album renames in the same run separately', async () => {
    const s = spy();
    const e = executor(s.reporter);

    await e.applyOneAlbum(albumEdit());
    await e.applyOne(trackEdit('Disorder'), new Set());
    await e.applyOne(trackEdit('Day of the Lords'), new Set());

    expect(e.streamedSummary.byKind.album.applied).toBe(1);
    expect(e.streamedSummary.byKind.track.applied).toBe(2);
    expect(e.streamedSummary.applied).toBe(3);
  });

  it('attributes a failure to the kind that failed', async () => {
    const s = spy();
    const albumFails = executor(s.reporter, { failAlbum: true });
    await albumFails.applyOneAlbum(albumEdit());

    expect(albumFails.streamedSummary.byKind.album.failed).toBe(1);
    expect(albumFails.streamedSummary.byKind.track.failed).toBe(0);

    const trackFails = executor(s.reporter, { failTrack: true });
    await trackFails.applyOne(trackEdit('Disorder'), new Set());

    expect(trackFails.streamedSummary.byKind.track.failed).toBe(1);
    expect(trackFails.streamedSummary.byKind.album.failed).toBe(0);
  });

  it('carries the split into the totals the footer and summary read', async () => {
    const s = spy();
    const e = executor(s.reporter);

    await e.applyOneAlbum(albumEdit());
    await e.applyOne(trackEdit('Disorder'), new Set());

    const last = s.totals.at(-1)!;
    expect(last.albums).toBe(1);
    expect(last.tracks).toBe(1);
  });
});

describe('album corrections name their tracks again', () => {
  it('reports the track list the one-request rename covered', async () => {
    const s = spy();
    const e = executor(s.reporter, { albumDetails: detailsOf([], 61) });

    await e.applyOneAlbum(
      albumEdit(['Serve the Servants', 'Heart-Shaped Box', 'Rape Me']),
    );

    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.scrobbles).toBe(61);
    expect(s.items[0]!.scrobbledTracks).toEqual([
      'Serve the Servants',
      'Heart-Shaped Box',
      'Rape Me',
    ]);
  });

  it('renders fine for an album whose page listed no tracks', async () => {
    const s = spy();
    const e = executor(s.reporter);

    await e.applyOneAlbum(albumEdit());

    expect(s.items[0]!.scrobbledTracks).toBeUndefined();
    expect(s.items[0]!.scrobbles).toBeUndefined();
  });
});

describe('the two album lookups', () => {
  it('asks the ORIGINAL title first, then the canonical one', async () => {
    const s = spy();
    const asked: string[] = [];
    const e = executor(s.reporter, {
      albumDetails: async (_artist, album) => {
        asked.push(album);
        return { imageUrl: undefined, trackNames: ['a', 'b'], scrobbles: 12 };
      },
    });

    await e.applyOneAlbum(albumEdit());

    // The original for the scrobble count (it has none once renamed), then the canonical name for
    // the track list, which Last.fm only catalogues under the clean title.
    expect(asked).toEqual(['In Utero (Deluxe Edition)', 'In Utero']);
  });

  it('reads the scrobble count before the POST and the track list after', async () => {
    const order: string[] = [];
    const s = spy();
    const e = new Executor(
      db(),
      {} as never,
      {
        apply: async () => {
          order.push('post');
          return 'verified';
        },
      } as never,
      s.reporter,
      {
        ...OPTS,
        albumDetails: async () => {
          order.push('lookup');
          return { imageUrl: undefined, trackNames: ['a'], scrobbles: 3 };
        },
      },
    );

    await e.applyOneAlbum(albumEdit());

    expect(order).toEqual(['lookup', 'post', 'lookup']);
  });

  it('still corrects when the lookup fails, since the count is only reporting', async () => {
    const s = spy();
    const e = executor(s.reporter, {
      albumDetails: async () => {
        throw new Error('api down');
      },
    });

    await e.applyOneAlbum(albumEdit());

    expect(e.streamedSummary.byKind.album.applied).toBe(1);
    expect(s.items[0]!.scrobbles).toBeUndefined();
    expect(s.items[0]!.scrobbledTracks).toBeUndefined();
  });
});

  it('prefers the canonical track list, which the cruft-laden title does not carry', async () => {
    const s = spy();
    const e = executor(s.reporter, {
      albumDetails: async (_artist, album) =>
        // Art still comes from the canonical name; the scrobble count from the original.
        album === 'In Utero'
          ? { imageUrl: 'art.jpg', trackNames: [], scrobbles: 61 }
          : { imageUrl: undefined, trackNames: [], scrobbles: 37 },
    });

    await e.applyOneAlbum(albumEdit(['Serve the Servants', 'Scentless Apprentice']));

    expect(s.items[0]!.scrobbledTracks).toEqual([
      'Serve the Servants',
      'Scentless Apprentice',
    ]);
    // …but the count still comes from the original, where the scrobbles actually were.
    expect(s.items[0]!.scrobbles).toBe(37);
    expect(e.streamedSummary.byKind.album.tracksCovered).toBe(2);
    expect(e.streamedSummary.byKind.album.scrobblesCovered).toBe(37);
  });

  it('takes the list from the page, never from the API release list', async () => {
    const s = spy();
    const e = executor(s.reporter, {
      // The API would offer these; they must not win over what the page actually listed.
      albumDetails: async () => ({
        imageUrl: undefined,
        trackNames: ['not', 'these'],
        scrobbles: 9,
      }),
    });

    await e.applyOneAlbum(albumEdit(['a', 'b', 'c']));

    expect(s.items[0]!.scrobbledTracks).toEqual(['a', 'b', 'c']);
  });

describe('the card names only tracks that were actually scrobbled', () => {
  it('drops release tracks with no plays, and counts the rest', async () => {
    const s = spy();
    const e = executor(s.reporter, {
      albumDetails: async () => ({ imageUrl: undefined, trackNames: [], scrobbles: 1 }),
    });

    // What the album's own library page lists — including a name the API's release list omits.
    await e.applyOneAlbum(
      albumEdit(["Franklin's Tower", "Franklin's Tower - 2013 Remaster"]),
    );

    expect(s.items[0]!.scrobbledTracks).toEqual([
      "Franklin's Tower",
      "Franklin's Tower - 2013 Remaster",
    ]);
    expect(e.streamedSummary.byKind.album.tracksCovered).toBe(2);
  });

  it('omits the field entirely when none of the release tracks were played', async () => {
    const s = spy();
    const e = executor(s.reporter, {
      albumDetails: async () => ({ imageUrl: undefined, trackNames: ['a', 'b'], scrobbles: 0 }),
    });

    // The page listed nothing, so the release list is not substituted in its place.
    await e.applyOneAlbum(albumEdit());

    expect(s.items[0]!.scrobbledTracks).toBeUndefined();
    expect(e.streamedSummary.byKind.album.tracksCovered).toBe(0);
  });
});

describe("a track edit reports the user's scrobbles of it", () => {
  it('puts the count on the correction card and in the run total', async () => {
    const s = spy();
    const e = executor(s.reporter, { trackScrobbles: async () => 606 });

    await e.applyOne(trackEdit('Disorder'), new Set());

    expect(s.items[0]!.scrobbles).toBe(606);
    expect(e.streamedSummary.byKind.track.scrobblesCovered).toBe(606);
  });

  /** The whole point of the ordering: after the write those scrobbles hang off the new name. */
  it('asks about the ORIGINAL title, before the write', async () => {
    const s = spy();
    const asked: [string, string][] = [];
    let written = false;
    const e = executor(s.reporter, {
      onApply: () => {
        written = true;
      },
      trackScrobbles: async (artist, track) => {
        expect(written).toBe(false);
        asked.push([artist, track]);
        return 7;
      },
    });

    await e.applyOne(trackEdit('Disorder'), new Set());

    expect(asked).toEqual([['Joy Division', 'Disorder - Remastered']]);
  });

  it('sums the counts across several edits in one run', async () => {
    const s = spy();
    const e = executor(s.reporter, { trackScrobbles: async () => 4 });

    for (const t of ['Disorder', 'Insight', 'Candidate'])
      await e.applyOne(trackEdit(t), new Set());

    expect(e.streamedSummary.byKind.track.scrobblesCovered).toBe(12);
  });

  it('omits the field rather than guessing when the lookup yields nothing', async () => {
    const s = spy();
    const e = executor(s.reporter, { trackScrobbles: async () => undefined });

    await e.applyOne(trackEdit('Disorder'), new Set());

    expect(s.items[0]!.scrobbles).toBeUndefined();
    expect(e.streamedSummary.byKind.track.scrobblesCovered).toBe(0);
  });

  it('still applies the edit when the lookup throws, since this is reporting only', async () => {
    const s = spy();
    const e = executor(s.reporter, {
      trackScrobbles: async () => {
        throw new Error('last.fm down');
      },
    });

    await e.applyOne(trackEdit('Disorder'), new Set());

    expect(e.streamedSummary.applied).toBe(1);
    expect(s.items[0]!.outcome).toBe('verified');
    expect(s.items[0]!.scrobbles).toBeUndefined();
  });

  /** "scrobbles affected" would be a lie on a failure: the edit never landed, so none moved. */
  it('reports no count on a failed edit', async () => {
    const s = spy();
    const e = executor(s.reporter, { failTrack: true, trackScrobbles: async () => 606 });

    await e.applyOne(trackEdit('Disorder'), new Set());

    expect(s.items[0]!.outcome).toBe('failed');
    expect(s.items[0]!.scrobbles).toBeUndefined();
    expect(e.streamedSummary.byKind.track.scrobblesCovered).toBe(0);
  });

  it('never asks in a dry run, which writes nothing to count against', async () => {
    const s = spy();
    let asked = 0;
    const e = new Executor(
      db(),
      { apply: async () => 'verified' } as never,
      { apply: async () => 'verified' } as never,
      s.reporter,
      {
        ...OPTS,
        dryRun: true,
        trackScrobbles: async () => {
          asked++;
          return 606;
        },
      },
    );

    await e.applyOne(trackEdit('Disorder'), new Set());

    expect(asked).toBe(0);
    expect(s.items[0]!.scrobbles).toBeUndefined();
  });
});
