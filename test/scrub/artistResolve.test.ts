import { describe, expect, it } from 'vitest';
import { Resolver } from '../../src/scrub/resolver.js';
import type { GroupName } from '../../src/rules/markers.js';
import type { ClusterLookup } from '../../src/scrub/clusters.js';
import { trackLibraryPath } from '../../src/lastfm/pages.js';

const ENABLED = new Set<GroupName>(['remaster', 'edition', 'bonus']);

const CURLY = 'Jim O’Rourke';
const STRAIGHT = "Jim O'Rourke";

const ARTIST_PATH = '/user/u/library/music/+noredirect/Jim+O%E2%80%99Rourke';
const TRACK_PATH = '/user/u/library/music/+noredirect/Jim+O%E2%80%99Rourke/_/Eureka';

/** No edit form, only an aggregate link — the shape a real artist library page has. */
const ARTIST_PAGE = `<table class="chartlist">
  <a class="chartlist-count-bar-link" href="/user/u/library/music/Jim+O%E2%80%99Rourke/_/Eureka"></a>
</table>`;

const TRACK_PAGE = `<table class="chartlist">
<form action="/user/u/library/edit-track?edited-variation=library-track-scrobble" data-edit-scrobble>
  <input type='hidden' name='csrfmiddlewaretoken' value='tok' />
  <input type="hidden" name="artist_name" value="${CURLY}" />
  <input type="hidden" name="track_name" value="Eureka" />
  <input type="hidden" name="album_name" value="Eureka" />
  <input type="hidden" name="album_artist_name" value="${CURLY}" />
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

const lookup: ClusterLookup = (kind, _artist, title) =>
  kind === 'artist' && title === CURLY ? STRAIGHT : undefined;

describe('an artist candidate resolves through the ordinary scrobble rows', () => {
  it('recurses from the artist page into the track page and renames the artist', async () => {
    const { pages: p, fetched } = pages({ [ARTIST_PATH]: ARTIST_PAGE, [TRACK_PATH]: TRACK_PAGE });

    const { edits } = await new Resolver(p, 'u', () => ENABLED).resolve(
      [{ kind: 'artist', artist: CURLY, title: CURLY }],
      {},
      lookup,
    );

    expect(fetched).toEqual([ARTIST_PATH, TRACK_PATH]);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.original.artist_name).toBe(CURLY);
    expect(edits[0]!.next.artist_name).toBe(STRAIGHT);
    // Ordinary edit-track, not a new endpoint: the form already carries the artist pair.
    expect(edits[0]!.action).toContain('edit-track');
  });

  /** The album artist is the same entity, so it moves with the artist rather than being left behind. */
  it('renames the album artist alongside the artist', async () => {
    const { pages: p } = pages({ [ARTIST_PATH]: ARTIST_PAGE, [TRACK_PATH]: TRACK_PAGE });
    const { edits } = await new Resolver(p, 'u', () => ENABLED).resolve(
      [{ kind: 'artist', artist: CURLY, title: CURLY }],
      {},
      lookup,
    );
    expect(edits[0]!.next.album_artist_name).toBe(STRAIGHT);
  });

  /** Without the tag the tier system cannot hold it: isGated only gates a real GroupName. */
  it('tags the edit punctuation so it can be gated', async () => {
    const { pages: p } = pages({ [ARTIST_PATH]: ARTIST_PAGE, [TRACK_PATH]: TRACK_PAGE });
    const { edits } = await new Resolver(p, 'u', () => ENABLED).resolve(
      [{ kind: 'artist', artist: CURLY, title: CURLY }],
      {},
      lookup,
    );
    expect(edits[0]!.groups).toEqual(['punctuation']);
  });

  /**
   * The invariant CLAUDE.md states for custom rules holds here too: a target the resolver cannot see
   * makes the row read as already clean, and the edit disappears without a trace.
   */
  it('finds nothing when the lookup is withheld', async () => {
    const { pages: p } = pages({ [ARTIST_PATH]: ARTIST_PAGE, [TRACK_PATH]: TRACK_PAGE });
    const { edits } = await new Resolver(p, 'u', () => ENABLED).resolve([
      { kind: 'artist', artist: CURLY, title: CURLY },
    ]);
    expect(edits).toEqual([]);
  });

  it('records a skip when the artist is no longer in the library', async () => {
    const { pages: p } = pages({});
    const { skips } = await new Resolver(p, 'u', () => ENABLED).resolve(
      [{ kind: 'artist', artist: CURLY, title: CURLY }],
      {},
      lookup,
    );
    expect(skips[0]!.reason).toMatch(/no scrobble rows/);
    expect(skips[0]!.candidate.kind).toBe('artist');
  });
});

describe('a cluster target beats the catalogue for the same field', () => {
  const DIRTY_TITLE = 'Don’t Lie to Me (Remastered)';
  const DIRTY_PATH = trackLibraryPath('u', 'Big Star', DIRTY_TITLE);
  const DIRTY_PAGE = `<table class="chartlist">
<form action="/user/u/library/edit-track" data-edit-scrobble>
  <input type='hidden' name='csrfmiddlewaretoken' value='tok' />
  <input type="hidden" name="artist_name" value="Big Star" />
  <input type="hidden" name="track_name" value="${DIRTY_TITLE}" />
  <input type="hidden" name="album_name" value="Radio City" />
  <input type="hidden" name="album_artist_name" value="Big Star" />
  <input type="hidden" name="timestamp" value="1" />
</form></table>`;

  /**
   * One rule, one answer — the merge target lands verbatim rather than being fed back through the
   * catalogue, exactly as a custom replacement is.
   */
  it('applies the merge target verbatim instead of also stripping the marker', async () => {
    const { pages: p } = pages({ [DIRTY_PATH]: DIRTY_PAGE });
    const clusters: ClusterLookup = (kind, _artist, title) =>
      kind === 'track' && title === DIRTY_TITLE ? "Don't Lie to Me (Remastered)" : undefined;

    const { edits } = await new Resolver(p, 'u', () => ENABLED).resolve(
      [{ kind: 'track', artist: 'Big Star', title: DIRTY_TITLE }],
      {},
      clusters,
    );

    expect(edits[0]!.next.track_name).toBe("Don't Lie to Me (Remastered)");
    expect(edits[0]!.groups).toEqual(['punctuation']);
  });
});
