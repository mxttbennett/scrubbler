import { describe, expect, it } from 'vitest';
import type { GroupName } from '../../src/rules/markers.js';
import { isGated, splitByTier } from '../../src/scrub/tiers.js';
import { toAlbumGroup, toGroup } from '../../src/scrub/types.js';
import type { PlannedAlbumEdit } from '../../src/lastfm/albumEditor.js';
import type { PlannedEdit } from '../../src/scrub/types.js';

const GATED = new Set<GroupName>(['live-album', 'feat-track']);

function trackEdit(track: string, groups: string[], album = 'Unknown Pleasures'): PlannedEdit {
  const original = {
    track_name: `${track} - Remastered`,
    artist_name: 'Joy Division',
    album_name: album,
    album_artist_name: 'Joy Division',
  };
  return {
    original,
    next: { ...original, track_name: track },
    csrfToken: 'tok',
    timestamp: '1772659220',
    action: '/user/u/library/edit-track',
    refererPath: `/user/u/library/music/Joy+Division/_/${track}`,
    groups: groups as PlannedEdit['groups'],
  };
}

function albumEdit(groups: string[]): PlannedAlbumEdit {
  return {
    artist: 'Yes',
    from: 'Yessongs (Live)',
    to: 'Yessongs',
    csrfToken: 'tok',
    action: '/library/edit-album',
    refererPath: '/x',
    groups,
  };
}

describe('isGated', () => {
  it('gates on a single gated tag', () => {
    expect(isGated(['live-album'], GATED)).toBe(true);
  });

  it('does not gate an entirely auto tuple', () => {
    expect(isGated(['remaster', 'edition'], GATED)).toBe(false);
  });

  /**
   * The tuple is one POST, so it cannot be half-applied — a gated tag has to take the whole thing
   * or the gated rule's change lands automatically by sharing a tuple with an auto one.
   */
  it('gates a tuple that mixes an auto and a gated tag', () => {
    expect(isGated(['remaster', 'feat-track'], GATED)).toBe(true);
  });

  it('does not gate on `custom`, which is a tag but not a group', () => {
    expect(isGated(['custom'], GATED)).toBe(false);
  });

  /** The ledger casts its stored names back without validating them. */
  it('ignores a stale name that is no longer a group', () => {
    expect(isGated(['live'], GATED)).toBe(false);
    expect(isGated(['live', 'feat-track'], GATED)).toBe(true);
  });

  it('never gates when nothing is gated', () => {
    expect(isGated(['live-album', 'feat-track'], new Set())).toBe(false);
  });

  it('treats an untagged edit as not gated', () => {
    expect(isGated([], GATED)).toBe(false);
  });
});

describe('splitByTier — track groups', () => {
  it('sends an all-auto candidate to the auto side only', () => {
    const g = toGroup('Joy Division', [trackEdit('Disorder', ['remaster'])]);
    const split = splitByTier(g, GATED);

    expect(split.gated).toBeUndefined();
    expect(split.auto?.kind).toBe('track');
    expect(split.auto?.kind === 'track' && split.auto.edits).toHaveLength(1);
  });

  it('sends an all-gated candidate to the gated side only', () => {
    const g = toGroup('Joy Division', [trackEdit('Disorder', ['feat-track'])]);
    const split = splitByTier(g, GATED);

    expect(split.auto).toBeUndefined();
    expect(split.gated?.kind === 'track' && split.gated.edits).toHaveLength(1);
  });

  /** The case that does not exist today: one candidate spanning both tiers. */
  it('splits a mixed candidate, keeping every tuple exactly once', () => {
    const edits = [
      trackEdit('Disorder', ['remaster']),
      trackEdit('Insight', ['feat-track']),
      trackEdit('Candidate', ['edition']),
      trackEdit('Interzone', ['remaster', 'live-album']),
    ];
    const split = splitByTier(toGroup('Joy Division', edits), GATED);

    const gatedNames =
      split.gated?.kind === 'track' ? split.gated.edits.map((e) => e.next.track_name) : [];
    const autoNames =
      split.auto?.kind === 'track' ? split.auto.edits.map((e) => e.next.track_name) : [];

    expect(gatedNames).toEqual(['Insight', 'Interzone']);
    expect(autoNames).toEqual(['Disorder', 'Candidate']);
    expect([...gatedNames, ...autoNames]).toHaveLength(edits.length);
  });

  it('re-derives shared per side rather than inheriting the whole group’s', () => {
    // Both auto edits share one album rename; the gated one renames a track, so it shares nothing.
    const shared = (album: string, groups: string[]): PlannedEdit => {
      const original = {
        track_name: 'Song',
        artist_name: 'A',
        album_name: album,
        album_artist_name: 'A',
      };
      return {
        ...trackEdit('Song', groups),
        original,
        next: { ...original, album_name: 'Clean' },
        groups: groups as PlannedEdit['groups'],
      };
    };
    const split = splitByTier(
      toGroup('A', [shared('Dirty', ['edition']), shared('Dirty', ['edition']), trackEdit('X', ['feat-track'])]),
      GATED,
    );

    expect(split.auto?.shared).toEqual({ field: 'album_name', from: 'Dirty', to: 'Clean' });
    expect(split.gated?.shared).toEqual({
      field: 'track_name',
      from: 'X - Remastered',
      to: 'X',
    });
  });
});

describe('splitByTier — album groups go whole', () => {
  it('gates the whole album group', () => {
    const split = splitByTier(toAlbumGroup(albumEdit(['live-album'])), GATED);
    expect(split.gated?.kind).toBe('album');
    expect(split.auto).toBeUndefined();
  });

  it('auto-applies the whole album group', () => {
    const split = splitByTier(toAlbumGroup(albumEdit(['edition'])), GATED);
    expect(split.auto?.kind).toBe('album');
    expect(split.gated).toBeUndefined();
  });

  it('gates an album whose tags mix tiers, since it cannot be split', () => {
    const split = splitByTier(toAlbumGroup(albumEdit(['edition', 'live-album'])), GATED);
    expect(split.gated?.kind).toBe('album');
    expect(split.auto).toBeUndefined();
  });
});
