import { describe, expect, it } from 'vitest';
import { extractRuleTuples, rulePageCount } from '../../src/lastfm/rules.js';
import { tupleKey } from '../../src/scrub/types.js';

describe('extractRuleTuples', () => {
  it('reads a track rule row, which carries all four originals', () => {
    const html = `<form>
      <input name="track_name_original" value="Song - Remastered" />
      <input name="track_name" value="Song" />
      <input name="artist_name_original" value="A" />
      <input name="album_name_original" value="Album" />
      <input name="album_artist_name_original" value="A" />
    </form>`;
    expect(extractRuleTuples(html)).toEqual([
      { track_name: 'Song - Remastered', artist_name: 'A', album_name: 'Album', album_artist_name: 'A' },
    ]);
  });

  it('reads an album rule row, which carries only the two album originals', () => {
    const html = `<form>
      <input name="album_name_original" value="Album (Deluxe Edition)" />
      <input name="album_artist_name_original" value="A" />
    </form>`;
    const tuples = extractRuleTuples(html);
    expect(tuples[0]).toEqual({
      track_name: '',
      artist_name: '',
      album_name: 'Album (Deluxe Edition)',
      album_artist_name: 'A',
    });
  });

  it('produces keys that match the tuple key used by the ledger', () => {
    const html = `<form>
      <input name="track_name_original" value="T" />
      <input name="artist_name_original" value="A" />
      <input name="album_name_original" value="L" />
      <input name="album_artist_name_original" value="A" />
    </form>`;
    expect(tupleKey(extractRuleTuples(html)[0]!)).toBe(
      tupleKey({ track_name: 'T', artist_name: 'A', album_name: 'L', album_artist_name: 'A' }),
    );
  });

  it('ignores forms with no original fields, such as the search form', () => {
    expect(extractRuleTuples('<form><input name="q" value="x" /></form>')).toEqual([]);
  });
});

describe('rulePageCount', () => {
  it('reads the highest pagination page', () => {
    const html = `<li class="pagination-page"><a>1</a></li>
      <li class="pagination-page"><a>2</a></li>
      <li class="pagination-page"><a>7</a></li>`;
    expect(rulePageCount(html)).toBe(7);
  });

  it('returns 1 for an unpaginated page', () => {
    expect(rulePageCount('<div/>')).toBe(1);
  });
});
