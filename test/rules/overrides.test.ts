import { describe, expect, it } from 'vitest';
import { cleanTitle } from '../../src/rules/engine.js';
import { DEFAULT_ENABLED, type GroupName } from '../../src/rules/markers.js';

const ENABLED = new Set<GroupName>(DEFAULT_ENABLED);

function lookupOf(rules: [string, string, string, string][]) {
  const map = new Map(
    rules.map(([field, artist, from, to]) => [
      `${field} ${artist.toLowerCase()} ${from.toLowerCase()}`,
      to,
    ]),
  );
  return (field: string, artist: string, title: string) =>
    map.get(`${field} ${artist.trim().toLowerCase()} ${title.trim().toLowerCase()}`);
}

describe('custom overrides', () => {
  it('renames a title the catalogue cannot express', () => {
    const result = cleanTitle('Wowee Zowee: Sordid Sentinels Edition', 'album', ENABLED, {
      artist: 'Pavement',
      lookup: lookupOf([
        ['album', 'Pavement', 'Wowee Zowee: Sordid Sentinels Edition', 'Wowee Zowee'],
      ]),
    });

    expect(result?.clean).toBe('Wowee Zowee');
    expect(result?.groups).toEqual(['custom']);
  });

  it('beats the catalogue when both could match', () => {
    const result = cleanTitle('Rumours (Deluxe Edition)', 'album', ENABLED, {
      artist: 'Fleetwood Mac',
      lookup: lookupOf([['album', 'Fleetwood Mac', 'Rumours (Deluxe Edition)', 'Rumours [1977]']]),
    });

    // The catalogue alone would have produced "Rumours"; the user's own answer wins.
    expect(result?.clean).toBe('Rumours [1977]');
    expect(result?.groups).toEqual(['custom']);
  });

  it('does not strip the replacement further — one rule, one answer', () => {
    const result = cleanTitle('Odd Title', 'album', ENABLED, {
      artist: 'A',
      lookup: lookupOf([['album', 'A', 'Odd Title', 'Real Name - Remastered']]),
    });

    expect(result?.clean).toBe('Real Name - Remastered');
  });

  it('matches regardless of casing and padding, which Last.fm varies', () => {
    const lookup = lookupOf([['track', 'Slint', 'Good Morning, Captain', 'Good Morning Captain']]);

    expect(cleanTitle('  GOOD MORNING, CAPTAIN ', 'track', ENABLED, { artist: 'slint', lookup })
      ?.clean).toBe('Good Morning Captain');
  });

  it('still refuses a casing-only replacement, which Last.fm silently rejects', () => {
    const result = cleanTitle('Nevermind', 'album', ENABLED, {
      artist: 'Nirvana',
      lookup: lookupOf([['album', 'Nirvana', 'Nevermind', 'NEVERMIND']]),
    });

    expect(result).toBeNull();
  });

  it('does not fire for a different artist with the same title', () => {
    const lookup = lookupOf([['album', 'Nirvana', 'Bleach', 'Bleach [1989]']]);

    expect(cleanTitle('Bleach', 'album', ENABLED, { artist: 'Nirvana', lookup })?.clean).toBe(
      'Bleach [1989]',
    );
    expect(cleanTitle('Bleach', 'album', ENABLED, { artist: 'Soundgarden', lookup })).toBeNull();
  });

  it('does not fire across fields — a track rule leaves an album title alone', () => {
    const lookup = lookupOf([['track', 'A', 'Same Name', 'Renamed']]);

    expect(cleanTitle('Same Name', 'album', ENABLED, { artist: 'A', lookup })).toBeNull();
  });

  it('falls through to the catalogue when no rule matches', () => {
    const lookup = lookupOf([['album', 'Other', 'Other Title', 'x']]);
    const withOverride = cleanTitle('Rumours (Deluxe Edition)', 'album', ENABLED, {
      artist: 'Fleetwood Mac',
      lookup,
    });

    expect(withOverride?.clean).toBe('Rumours');
    expect(withOverride?.groups).toEqual(['edition']);
  });

  it('is byte-identical to the no-override call when no lookup is passed', () => {
    for (const title of [
      'Rumours (Deluxe Edition)',
      'She Said She Said - 2022 Mix',
      'Big Day Coming - Second Version',
      'Sister Ray - Live in Rotterdam 1984',
    ]) {
      const bare = cleanTitle(title, 'album', ENABLED);
      const empty = cleanTitle(title, 'album', ENABLED, { artist: 'x', lookup: () => undefined });
      expect(empty).toEqual(bare);
    }
  });
});
