import { describe, expect, it } from 'vitest';
import { detectShared, toGroup, type PlannedEdit } from '../../src/scrub/types.js';

function edit(track: [string, string], album: [string, string]): PlannedEdit {
  return {
    original: {
      track_name: track[0],
      artist_name: 'The Replacements',
      album_name: album[0],
      album_artist_name: 'The Replacements',
    },
    next: {
      track_name: track[1],
      artist_name: 'The Replacements',
      album_name: album[1],
      album_artist_name: 'The Replacements',
    },
    timestamp: '1',
    csrfToken: 't',
    action: '/user/u/library/edit-track',
    refererPath: '/user/u/library/music/+noredirect/A/_/B',
    groups: ['edition'],
  };
}

const ALBUM_ONLY = (t: string) => edit([t, t], ['Let It Be (Expanded)', 'Let It Be']);

describe('detectShared', () => {
  it('groups an album rename across many tracks into one shared change', () => {
    const shared = detectShared(['Bastards of Young', 'Left of the Dial', 'Kiss Me on the Bus'].map(ALBUM_ONLY));
    expect(shared).toEqual({
      field: 'album_name',
      from: 'Let It Be (Expanded)',
      to: 'Let It Be',
    });
  });

  it('groups a shared track suffix across tracks on one album', () => {
    const edits = [
      edit(['Answering Machine - Remastered', 'Answering Machine'], ['Let It Be', 'Let It Be']),
      edit(['Unsatisfied - Remastered', 'Unsatisfied'], ['Let It Be', 'Let It Be']),
    ];
    expect(detectShared(edits)).toBeUndefined();
  });

  it('refuses to share when an edit changes two fields, so a track rename cannot hide', () => {
    const edits = [
      ALBUM_ONLY('Bastards of Young'),
      edit(['Unsatisfied - Remastered', 'Unsatisfied'], ['Let It Be (Expanded)', 'Let It Be']),
    ];
    expect(detectShared(edits)).toBeUndefined();
  });

  it('refuses to share when the same field changes to different values', () => {
    const edits = [
      ALBUM_ONLY('a'),
      edit(['b', 'b'], ['Hootenanny (Expanded)', 'Hootenanny']),
    ];
    expect(detectShared(edits)).toBeUndefined();
  });

  it('treats a single edit as its own shared change', () => {
    expect(detectShared([ALBUM_ONLY('only')])?.field).toBe('album_name');
  });

  it('returns nothing for an empty group', () => {
    expect(detectShared([])).toBeUndefined();
  });
});

describe('toGroup', () => {
  it('carries the artist, the edits and the shared change', () => {
    const g = toGroup('The Replacements', ['x', 'y'].map(ALBUM_ONLY));
    expect(g.artist).toBe('The Replacements');
    expect(g.edits).toHaveLength(2);
    expect(g.shared?.to).toBe('Let It Be');
  });
});
