import { describe, expect, it } from 'vitest';
import { Resolver, withNoRedirect } from '../../src/scrub/resolver.js';
import type { GroupName } from '../../src/rules/markers.js';
import { changedFields } from '../../src/scrub/types.js';

const ENABLED = new Set<GroupName>(['remaster', 'edition', 'bonus']);

function rowForm(fields: Record<string, string>): string {
  const inputs = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${v}" />`)
    .join('\n');
  return `<table class="chartlist"><form action="/user/u/library/edit-track?edited-variation=library-track-scrobble" data-edit-scrobble>${inputs}</form></table>`;
}

/** Serves canned HTML per path, standing in for LibraryPages. */
function fakePages(byPath: Record<string, string>) {
  const requested: string[] = [];
  return {
    requested,
    pages: {
      fetch: async (path: string) => {
        requested.push(path);
        return byPath[path] ?? '';
      },
    } as never,
  };
}

describe('Resolver — tuple merging', () => {
  it('merges a track and an album cleanup for one tuple into a single edit', async () => {
    const path = '/user/u/library/music/+noredirect/Fleetwood+Mac/_/Silver+Springs+-+2004+Remaster';
    const albumPath = '/user/u/library/music/Fleetwood+Mac/Rumours+%28Deluxe+Edition%29';
    const html = rowForm({
      csrfmiddlewaretoken: 'tok',
      artist_name: 'Fleetwood Mac',
      track_name: 'Silver Springs - 2004 Remaster',
      album_name: 'Rumours (Deluxe Edition)',
      album_artist_name: 'Fleetwood Mac',
      timestamp: '1772659220',
    });
    const { pages } = fakePages({ [path]: html, [albumPath]: html });
    const resolver = new Resolver(pages, 'u', () => ENABLED);

    const { edits } = await resolver.resolve([
      { kind: 'track', artist: 'Fleetwood Mac', title: 'Silver Springs - 2004 Remaster' },
      { kind: 'album', artist: 'Fleetwood Mac', title: 'Rumours (Deluxe Edition)' },
    ]);

    expect(edits).toHaveLength(1);
    expect(changedFields(edits[0]!).sort()).toEqual(['album_name', 'track_name']);
    expect(edits[0]!.next.track_name).toBe('Silver Springs');
    expect(edits[0]!.next.album_name).toBe('Rumours');
    expect(edits[0]!.groups).toEqual(['edition', 'remaster']);
  });

  it('reads the endpoint off the page instead of hardcoding it', async () => {
    const path = '/user/u/library/music/+noredirect/A/_/Song+-+Remastered';
    const { pages } = fakePages({
      [path]: rowForm({
        csrfmiddlewaretoken: 'tok',
        artist_name: 'A',
        track_name: 'Song - Remastered',
        album_name: '',
        album_artist_name: '',
        timestamp: '1',
      }),
    });
    const { edits } = await new Resolver(pages, 'u', () => ENABLED).resolve([
      { kind: 'track', artist: 'A', title: 'Song - Remastered' },
    ]);
    expect(edits[0]!.action).toContain('/library/edit-track');
  });

  it('keeps distinct tuples separate even for the same track title', async () => {
    const path = '/user/u/library/music/+noredirect/A/_/Song+-+Remastered';
    const two =
      rowForm({
        csrfmiddlewaretoken: 't',
        artist_name: 'A',
        track_name: 'Song - Remastered',
        album_name: 'One (Deluxe Edition)',
        album_artist_name: 'A',
        timestamp: '1',
      }) +
      rowForm({
        csrfmiddlewaretoken: 't',
        artist_name: 'A',
        track_name: 'Song - Remastered',
        album_name: 'Two (Deluxe Edition)',
        album_artist_name: 'A',
        timestamp: '2',
      });
    const { pages } = fakePages({ [path]: two });
    const { edits } = await new Resolver(pages, 'u', () => ENABLED).resolve([
      { kind: 'track', artist: 'A', title: 'Song - Remastered' },
    ]);
    expect(edits).toHaveLength(2);
    expect(edits.map((e) => e.original.album_name).sort()).toEqual([
      'One (Deluxe Edition)',
      'Two (Deluxe Edition)',
    ]);
  });

  it('re-derives from the page value, dropping a candidate the page says is already clean', async () => {
    const path = '/user/u/library/music/+noredirect/A/_/Song+-+Remastered';
    const { pages } = fakePages({
      [path]: rowForm({
        csrfmiddlewaretoken: 't',
        artist_name: 'A',
        track_name: 'Song',
        album_name: 'Album',
        album_artist_name: 'A',
        timestamp: '1',
      }),
    });
    const { edits } = await new Resolver(pages, 'u', () => ENABLED).resolve([
      { kind: 'track', artist: 'A', title: 'Song - Remastered' },
    ]);
    expect(edits).toEqual([]);
  });

  it('records a skip when the library page yields no rows', async () => {
    const { pages } = fakePages({});
    const { edits, skips } = await new Resolver(pages, 'u', () => ENABLED).resolve([
      { kind: 'track', artist: 'A', title: 'Gone - Remastered' },
    ]);
    expect(edits).toEqual([]);
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toMatch(/no scrobble rows/);
  });

  it('fetches each library path only once across candidates', async () => {
    const path = '/user/u/library/music/+noredirect/A/_/Song+-+Remastered';
    const { pages, requested } = fakePages({
      [path]: rowForm({
        csrfmiddlewaretoken: 't',
        artist_name: 'A',
        track_name: 'Song - Remastered',
        album_name: '',
        album_artist_name: '',
        timestamp: '1',
      }),
    });
    await new Resolver(pages, 'u', () => ENABLED).resolve([
      { kind: 'track', artist: 'A', title: 'Song - Remastered' },
      { kind: 'track', artist: 'A', title: 'Song - Remastered' },
    ]);
    expect(requested.filter((p) => p === path)).toHaveLength(1);
  });
});

describe('withNoRedirect', () => {
  it('injects +noredirect into a nested library link', () => {
    expect(withNoRedirect('/user/u/library/music/A/_/B')).toBe(
      '/user/u/library/music/+noredirect/A/_/B',
    );
  });

  it('is idempotent', () => {
    const already = '/user/u/library/music/+noredirect/A/_/B';
    expect(withNoRedirect(already)).toBe(already);
  });
});
