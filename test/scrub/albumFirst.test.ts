import { describe, expect, it } from 'vitest';
import { Resolver } from '../../src/scrub/resolver.js';
import type { GroupName } from '../../src/rules/markers.js';
import { Planner } from '../../src/scrub/planner.js';
import type { LastfmApi } from '../../src/lastfm/api.js';

const ENABLED = new Set<GroupName>(['remaster', 'edition', 'bonus']);

const ALBUM_FORM = `<table class="chartlist"></table>
<form action="/user/u/library/edit-album?edited-variation=library-album-scrobble" data-edit-album>
  <input type='hidden' name='csrfmiddlewaretoken' value='tok' />
  <input type="hidden" name="album_name" value="Let It Be (Expanded)" />
  <input type="hidden" name="album_artist_name" value="The Replacements" />
</form>`;

const TRACK_FORM = `<table class="chartlist">
<form action="/user/u/library/edit-track?edited-variation=library-track-scrobble" data-edit-scrobble>
  <input type='hidden' name='csrfmiddlewaretoken' value='tok' />
  <input type="hidden" name="artist_name" value="The Replacements" />
  <input type="hidden" name="track_name" value="Unsatisfied - Remastered" />
  <input type="hidden" name="album_name" value="Let It Be" />
  <input type="hidden" name="album_artist_name" value="The Replacements" />
  <input type="hidden" name="timestamp" value="1" />
</form></table>`;

function pages(byPath: Record<string, string>) {
  const fetched: string[] = [];
  return {
    fetched,
    pages: {
      fetch: async (p: string) => {
        fetched.push(p);
        return byPath[p] ?? '';
      },
    } as never,
  };
}

describe('album renames are one request and never recurse', () => {
  const albumPath = '/user/u/library/music/+noredirect/The+Replacements/Let+It+Be+(Expanded)';

  it('produces a single album edit from the album page alone', async () => {
    const { pages: p, fetched } = pages({ [albumPath]: ALBUM_FORM });
    const { albumEdits, edits } = await new Resolver(p, 'u', () => ENABLED).resolve([
      { kind: 'album', artist: 'The Replacements', title: 'Let It Be (Expanded)' },
    ]);

    expect(albumEdits).toHaveLength(1);
    expect(albumEdits[0]!.from).toBe('Let It Be (Expanded)');
    expect(albumEdits[0]!.to).toBe('Let It Be');
    expect(albumEdits[0]!.action).toContain('edit-album');
    expect(edits).toEqual([]);
    // the whole point: one fetch, no per-track recursion
    expect(fetched).toEqual([albumPath]);
  });

  it('re-derives from the page value and drops an album the page says is clean', async () => {
    const clean = ALBUM_FORM.replace(/Let It Be \(Expanded\)/g, 'Let It Be');
    const { pages: p } = pages({ [albumPath]: clean });
    const { albumEdits, skips } = await new Resolver(p, 'u', () => ENABLED).resolve([
      { kind: 'album', artist: 'The Replacements', title: 'Let It Be (Expanded)' },
    ]);
    expect(albumEdits).toEqual([]);
    expect(skips[0]!.reason).toMatch(/already clean/);
  });

  it('distinguishes a vanished album from changed markup', async () => {
    const { pages: p } = pages({});
    const gone = await new Resolver(p, 'u', () => ENABLED).resolve([
      { kind: 'album', artist: 'The Replacements', title: 'Let It Be (Expanded)' },
    ]);
    expect(gone.skips[0]!.reason).toMatch(/no longer in library/);

    const { pages: q } = pages({ [albumPath]: '<table class="chartlist"></table>' });
    const nomarkup = await new Resolver(q, 'u', () => ENABLED).resolve([
      { kind: 'album', artist: 'The Replacements', title: 'Let It Be (Expanded)' },
    ]);
    expect(nomarkup.skips[0]!.reason).toMatch(/no edit form/);
  });

  it('still uses edit-track for a track whose own title carries a marker', async () => {
    const trackPath = '/user/u/library/music/+noredirect/The+Replacements/_/Unsatisfied+-+Remastered';
    const { pages: p } = pages({ [trackPath]: TRACK_FORM });
    const { edits, albumEdits } = await new Resolver(p, 'u', () => ENABLED).resolve([
      { kind: 'track', artist: 'The Replacements', title: 'Unsatisfied - Remastered' },
    ]);

    expect(albumEdits).toEqual([]);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.action).toContain('edit-track');
    expect(edits[0]!.next.track_name).toBe('Unsatisfied');
    // the album was already clean on the page, so the track edit leaves it alone
    expect(edits[0]!.next.album_name).toBe('Let It Be');
  });
});

describe('sweep order', () => {
  it('emits every album candidate before any track candidate', async () => {
    const api = {
      iterateTopAlbums: async function* () {
        yield { name: 'Hootenanny (Deluxe Edition)', artist: 'The Replacements' };
        yield { name: 'Tim (Remastered)', artist: 'The Replacements' };
      },
      iterateTopTracks: async function* () {
        yield { name: 'Unsatisfied - Remastered', artist: 'The Replacements' };
      },
    } as unknown as LastfmApi;

    const candidates = await new Planner(api, 'u', () => ENABLED).sweep();
    expect(candidates).toHaveLength(3);
    // Album renames must land before track pages are read, or a track edit's album_name_original
    // goes stale and the write silently no-ops. This ordering is load-bearing.
    expect(candidates.map((c) => c.kind)).toEqual(['album', 'album', 'track']);
  });

  /**
   * An artist rename changes a field every album and track tuple carries, so it has to land before
   * both — the same staleness argument that puts albums before tracks, one level up.
   */
  it('orders clustered candidates in as artist, then album, then track', async () => {
    const api = {
      iterateTopAlbums: async function* () {
        yield { name: 'Tim (Remastered)', artist: 'The Replacements' };
      },
      iterateTopTracks: async function* () {
        yield { name: 'Unsatisfied - Remastered', artist: 'The Replacements' };
      },
    } as unknown as LastfmApi;

    // Deliberately handed over in the wrong order: the sweep must not trust the caller's ordering.
    const candidates = await new Planner(api, 'u', () => ENABLED).sweep(undefined, [
      { kind: 'track', artist: 'Drexciya', title: 'You Don’t Know' },
      { kind: 'artist', artist: 'Jim O’Rourke', title: 'Jim O’Rourke' },
      { kind: 'album', artist: 'Deerhoof', title: 'Apple O’' },
    ]);

    expect(candidates.map((c) => c.kind)).toEqual([
      'artist',
      'album',
      'album',
      'track',
      'track',
    ]);
    expect(candidates[0]!.artist).toBe('Jim O’Rourke');
  });
});
