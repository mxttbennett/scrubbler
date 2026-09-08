import { describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../../src/db/index.js';
import { CustomRules } from '../../src/rules/customRules.js';
import { DEFAULT_ENABLED, type GroupName } from '../../src/rules/markers.js';
import { Planner } from '../../src/scrub/planner.js';
import { Resolver } from '../../src/scrub/resolver.js';
import { albumLibraryPath } from '../../src/lastfm/pages.js';

const ENABLED = new Set<GroupName>(DEFAULT_ENABLED);

// A title with no catalogue marker at all: nothing but a custom rule can nominate it.
const ODD = 'Wowee Zowee: Sordid Sentinels Edition';
const ARTIST = 'Pavement';

function harness() {
  const d = createDb(':memory:');
  runMigrations(d);
  const rules = new CustomRules(d);
  return { d, rules };
}

function fakeApi(albums: { name: string; artist: string }[]) {
  return {
    iterateTopAlbums: async function* () {
      yield* albums;
    },
    iterateTopTracks: async function* () {
      // no tracks in these cases
    },
  } as never;
}

const albumHtml = (name: string) =>
  `<table class="chartlist">` +
  `<form action="/user/u/library/edit-track?edited-variation=library-track-scrobble" data-edit-scrobble>` +
  `<input type="hidden" name="csrfmiddlewaretoken" value="tok" />` +
  `<input type="hidden" name="artist_name" value="${ARTIST}" />` +
  `<input type="hidden" name="track_name" value="Rattled by the Rush" />` +
  `<input type="hidden" name="album_name" value="${name}" />` +
  `<input type="hidden" name="album_artist_name" value="${ARTIST}" />` +
  `<input type="hidden" name="timestamp" value="1772659220" />` +
  `</form></table>` +
  `<form action="/library/edit-album?edited-variation=library-album-scrobble" data-edit-album>` +
  `<input type="hidden" name="csrfmiddlewaretoken" value="tok" />` +
  `<input type="hidden" name="album_name" value="${name}" />` +
  `<input type="hidden" name="album_artist_name" value="${ARTIST}" />` +
  `</form>`;

function fakePages(byPath: Record<string, string>) {
  return { fetch: async (path: string) => byPath[path] ?? '' } as never;
}

describe('a custom rule must reach discovery AND resolution', () => {
  it('is not nominated at all without a rule', async () => {
    const { rules } = harness();
    const planner = new Planner(
      fakeApi([{ name: ODD, artist: ARTIST }]),
      'u',
      ENABLED,
      undefined,
      3,
      rules.lookup,
    );

    expect(await planner.sweep()).toEqual([]);
  });

  it('the planner nominates it once a rule exists — half of the requirement', async () => {
    const { rules } = harness();
    rules.add({ kind: 'album', artist: ARTIST, fromTitle: ODD, toTitle: 'Wowee Zowee' });

    const planner = new Planner(
      fakeApi([{ name: ODD, artist: ARTIST }]),
      'u',
      ENABLED,
      undefined,
      3,
      rules.lookup,
    );

    expect(await planner.sweep()).toEqual([{ kind: 'album', artist: ARTIST, title: ODD }]);
  });

  it('the resolver then produces the edit — the other half', async () => {
    const { rules } = harness();
    rules.add({ kind: 'album', artist: ARTIST, fromTitle: ODD, toTitle: 'Wowee Zowee' });

    const path = albumLibraryPath('u', ARTIST, ODD);
    const resolver = new Resolver(fakePages({ [path]: albumHtml(ODD) }), 'u', ENABLED, rules.lookup);

    const { albumEdits } = await resolver.resolve([{ kind: 'album', artist: ARTIST, title: ODD }]);

    expect(albumEdits).toHaveLength(1);
    expect(albumEdits[0]!.from).toBe(ODD);
    expect(albumEdits[0]!.to).toBe('Wowee Zowee');
    expect(albumEdits[0]!.groups).toEqual(['custom']);
  });

  it('reports it as already clean if the resolver is left without the lookup', async () => {
    const { rules } = harness();
    rules.add({ kind: 'album', artist: ARTIST, fromTitle: ODD, toTitle: 'Wowee Zowee' });

    const path = albumLibraryPath('u', ARTIST, ODD);
    // No lookup passed — this is the one-sided implementation the pair above exists to catch.
    const resolver = new Resolver(fakePages({ [path]: albumHtml(ODD) }), 'u', ENABLED);

    const { albumEdits, skips } = await resolver.resolve([
      { kind: 'album', artist: ARTIST, title: ODD },
    ]);

    expect(albumEdits).toHaveLength(0);
    expect(skips[0]!.reason).toContain('already clean');
  });

  it('does not nominate the same title under a different artist', async () => {
    const { rules } = harness();
    rules.add({ kind: 'album', artist: ARTIST, fromTitle: ODD, toTitle: 'Wowee Zowee' });

    const planner = new Planner(
      fakeApi([{ name: ODD, artist: 'Someone Else' }]),
      'u',
      ENABLED,
      undefined,
      3,
      rules.lookup,
    );

    expect(await planner.sweep()).toEqual([]);
  });

  it('still respects the ignore list, so a rule cannot override a rejection', async () => {
    const { d, rules } = harness();
    rules.add({ kind: 'album', artist: ARTIST, fromTitle: ODD, toTitle: 'Wowee Zowee' });
    const planner = new Planner(
      fakeApi([{ name: ODD, artist: ARTIST }]),
      'u',
      ENABLED,
      d,
      3,
      rules.lookup,
    );

    expect(await planner.sweep()).toHaveLength(1);

    const { schema } = await import('../../src/db/index.js');
    d.insert(schema.ignored)
      .values({ kind: 'album', artist: ARTIST, title: ODD, reason: 'rejected in discord' })
      .run();

    expect(await planner.sweep()).toEqual([]);
  });
});
