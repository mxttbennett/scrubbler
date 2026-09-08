import { describe, expect, it } from 'vitest';
import { Resolver } from '../../src/scrub/resolver.js';
import { albumLibraryPath } from '../../src/lastfm/pages.js';
import type { GroupName } from '../../src/rules/markers.js';
import type { EditGroup } from '../../src/scrub/types.js';

const ENABLED = new Set<GroupName>(['remaster', 'edition', 'bonus']);

function rows(track: string[], album: string): string {
  const forms = track
    .map((name, i) =>
      `<form action="/user/u/library/edit-track?edited-variation=library-track-scrobble" data-edit-scrobble>` +
      Object.entries({
        csrfmiddlewaretoken: 'tok',
        artist_name: 'The Replacements',
        track_name: name,
        album_name: album,
        album_artist_name: 'The Replacements',
        timestamp: String(1772659220 + i),
      })
        .map(([k, v]) => `<input type="hidden" name="${k}" value="${v}" />`)
        .join('') +
      `</form>`,
    )
    .join('');
  return `<table class="chartlist">${forms}</table>`;
}

const albumHtml = (name: string) =>
  `<form action="/library/edit-album?edited-variation=library-album-scrobble" data-edit-album>` +
  `<input type="hidden" name="csrfmiddlewaretoken" value="tok" />` +
  `<input type="hidden" name="album_name" value="${name}" />` +
  `<input type="hidden" name="album_artist_name" value="Nirvana" />` +
  `</form>`;

function fakePages(byPath: Record<string, string>) {
  return { fetch: async (path: string) => byPath[path] ?? '' } as never;
}

describe('Resolver — onGroup', () => {
  it('hands over one candidate-local group, never the run-wide map', async () => {
    const a = '/user/u/library/music/+noredirect/The+Replacements/_/Bastards+of+Young';
    const b = '/user/u/library/music/+noredirect/The+Replacements/_/Left+of+the+Dial';
    const resolver = new Resolver(
      fakePages({
        [a]: rows(['Bastards of Young'], 'Let It Be (Deluxe Edition)'),
        [b]: rows(['Left of the Dial'], 'Let It Be (Deluxe Edition)'),
      }),
      'u',
      ENABLED,
    );

    const seen: EditGroup[] = [];
    await resolver.resolve(
      [
        { kind: 'track', artist: 'The Replacements', title: 'Bastards of Young' },
        { kind: 'track', artist: 'The Replacements', title: 'Left of the Dial' },
      ],
      { onGroup: async (g) => void seen.push(g) },
    );

    expect(seen).toHaveLength(2);
    for (const g of seen) expect(g.kind === 'track' ? g.edits : []).toHaveLength(1);
    expect(seen[1]?.shared?.to).toBe('Let It Be');
  });

  it('suppresses onEdit so nothing is written before its proposal exists', async () => {
    const path = '/user/u/library/music/+noredirect/The+Replacements/_/Bastards+of+Young';
    const resolver = new Resolver(
      fakePages({ [path]: rows(['Bastards of Young'], 'Let It Be (Deluxe Edition)') }),
      'u',
      ENABLED,
    );

    let applied = 0;
    let grouped = 0;
    await resolver.resolve(
      [{ kind: 'track', artist: 'The Replacements', title: 'Bastards of Young' }],
      { onEdit: async () => void applied++, onGroup: async () => void grouped++ },
    );

    expect(grouped).toBe(1);
    expect(applied).toBe(0);
  });

  it('suppresses onAlbumEdit and yields a one-member album group', async () => {
    const path = albumLibraryPath('u', 'Nirvana', 'In Utero (Deluxe Edition)');
    const resolver = new Resolver(
      fakePages({ [path]: albumHtml('In Utero (Deluxe Edition)') }),
      'u',
      ENABLED,
    );

    let applied = 0;
    const seen: EditGroup[] = [];
    await resolver.resolve([{ kind: 'album', artist: 'Nirvana', title: 'In Utero (Deluxe Edition)' }], {
      onAlbumEdit: async () => void applied++,
      onGroup: async (g) => void seen.push(g),
    });

    expect(applied).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('album');
    expect(seen[0]?.shared?.to).toBe('In Utero');
  });

  it('still applies through onEdit when no group hook is registered', async () => {
    const path = '/user/u/library/music/+noredirect/The+Replacements/_/Bastards+of+Young';
    const resolver = new Resolver(
      fakePages({ [path]: rows(['Bastards of Young'], 'Let It Be (Deluxe Edition)') }),
      'u',
      ENABLED,
    );

    let applied = 0;
    await resolver.resolve(
      [{ kind: 'track', artist: 'The Replacements', title: 'Bastards of Young' }],
      { onEdit: async () => void applied++ },
    );

    expect(applied).toBe(1);
  });
});
