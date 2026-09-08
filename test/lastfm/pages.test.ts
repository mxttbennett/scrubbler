import { describe, expect, it } from 'vitest';
import {
  albumLibraryPath,
  encodePathSegment,
  extractAggregateLinks,
  extractFormAction,
  extractScrobbleRows,
  hasRealChartlist,
  isSettledEmpty,
  isThrottled,
  pageCount,
  trackLibraryPath,
} from '../../src/lastfm/pages.js';

const ROW_FORM = `
<form method="POST" action="/user/u/library/edit-track?edited-variation=library-track-scrobble" data-edit-scrobble >
  <input type='hidden' name='csrfmiddlewaretoken' value='abc123' />
  <input type="hidden" name="artist_name" value="Fleetwood Mac" />
  <input type="hidden" name="track_name" value="Silver Springs - 2004 Remaster" />
  <input type="hidden" name="album_name" value="Rumours (Deluxe Edition)" />
  <input type="hidden" name="album_artist_name" value="Fleetwood Mac" />
  <input type="hidden" name="timestamp" value="1772659220" />
</form>`;

describe('URL construction', () => {
  it('uses + for spaces, as Last.fm does', () => {
    expect(encodePathSegment('Fleetwood Mac')).toBe('Fleetwood+Mac');
  });

  it('percent-encodes apostrophes and non-ASCII', () => {
    expect(encodePathSegment("Sinéad O'Connor")).toBe("Sin%C3%A9ad%20O'Connor".replace('%20', '+'));
  });

  it('puts +noredirect on track URLs so Last.fm cannot canonicalise the target', () => {
    const p = trackLibraryPath('u', 'Fleetwood Mac', 'Silver Springs');
    expect(p).toBe('/user/u/library/music/+noredirect/Fleetwood+Mac/_/Silver+Springs');
  });

  it('puts +noredirect on album URLs too, because the plain form 301s to a lowercased name', () => {
    const p = albumLibraryPath('u', 'Fleetwood Mac', 'Rumours (Deluxe Edition)');
    expect(p).toBe('/user/u/library/music/+noredirect/Fleetwood+Mac/Rumours+(Deluxe+Edition)');
  });
});

describe('hasRealChartlist', () => {
  it('accepts a real chartlist', () => {
    expect(hasRealChartlist('<table class="chartlist chartlist--with-album">')).toBe(true);
  });

  it('rejects a placeholder-only page, which is a failure and not an empty library', () => {
    expect(hasRealChartlist('<table class="chartlist chartlist__placeholder">')).toBe(false);
    expect(hasRealChartlist('<div>nothing here</div>')).toBe(false);
  });
});

describe('pageCount', () => {
  it('reads the highest page number, ignoring the trailing Next control', () => {
    const html = `<ul class="pagination-list">
      <li><a>1</a></li><li><a>2</a></li><li><a>3</a></li><li><a>Next</a></li></ul>`;
    expect(pageCount(html)).toBe(3);
  });

  it('returns 1 when there is no pagination', () => {
    expect(pageCount('<div></div>')).toBe(1);
  });
});

describe('extractScrobbleRows', () => {
  it('harvests all six fields from a row form', () => {
    const rows = extractScrobbleRows(ROW_FORM);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      csrfmiddlewaretoken: 'abc123',
      artist_name: 'Fleetwood Mac',
      track_name: 'Silver Springs - 2004 Remaster',
      album_name: 'Rumours (Deluxe Edition)',
      album_artist_name: 'Fleetwood Mac',
      timestamp: '1772659220',
    });
  });

  it('decodes HTML entities in values', () => {
    const html = ROW_FORM.replace('Fleetwood Mac', 'Simon &amp; Garfunkel').replace(
      'Silver Springs - 2004 Remaster',
      'Don&#39;t Look Back',
    );
    const rows = extractScrobbleRows(html);
    expect(rows[0]?.artist_name).toBe('Simon & Garfunkel');
    expect(rows[0]?.track_name).toBe("Don't Look Back");
  });

  it('ignores forms missing the required fields', () => {
    expect(extractScrobbleRows('<form data-edit-scrobble></form>')).toEqual([]);
  });

  it('reads the live endpoint from the form action rather than assuming it', () => {
    expect(extractFormAction(ROW_FORM)).toBe(
      '/user/u/library/edit-track?edited-variation=library-track-scrobble',
    );
  });
});

describe('extractAggregateLinks', () => {
  it('finds nested library links regardless of attribute order', () => {
    const html = `
      <a class="chartlist-count-bar-link" href="/user/u/library/music/A/_/B">x</a>
      <a href="/user/u/library/music/C/_/D" class="chartlist-count-bar-link">y</a>`;
    expect(extractAggregateLinks(html).sort()).toEqual([
      '/user/u/library/music/A/_/B',
      '/user/u/library/music/C/_/D',
    ]);
  });

  it('finds none on a leaf scrobble page', () => {
    expect(extractAggregateLinks(ROW_FORM)).toEqual([]);
  });
});

describe('isThrottled', () => {
  it('detects the soft rate-limit page, which arrives as HTTP 200', () => {
    expect(isThrottled('<h1>You&#8217;re requesting too many pages</h1>')).toBe(true);
    expect(isThrottled('<h1>You’re requesting too many pages</h1>')).toBe(true);
    expect(isThrottled('<title>Page not available | Last.fm</title>')).toBe(true);
  });

  it('does not fire on a normal library page', () => {
    expect(isThrottled('<title>Fleetwood Mac | Last.fm</title><table class="chartlist">')).toBe(
      false,
    );
    expect(isThrottled('')).toBe(false);
  });
});

describe('isSettledEmpty', () => {
  it('treats a rendered page with no chartlist as genuinely empty, not still loading', () => {
    expect(isSettledEmpty('<table class="table"></table>')).toBe(true);
  });

  it('does not call a placeholder page empty, since that one is worth retrying', () => {
    expect(isSettledEmpty('<table class="chartlist chartlist__placeholder">')).toBe(false);
  });

  it('does not call a real chartlist empty', () => {
    expect(isSettledEmpty('<table class="chartlist chartlist--with-album">')).toBe(false);
  });
});
