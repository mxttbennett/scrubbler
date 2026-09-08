import { describe, expect, it } from 'vitest';
import { AlbumEditor, extractAlbumForm, type PlannedAlbumEdit } from '../../src/lastfm/albumEditor.js';

const PAGE = `
<form method="POST" action="/user/u/library/edit-album?edited-variation=library-album-scrobble&amp;redirect=true" data-edit-album >
  <input type='hidden' name='csrfmiddlewaretoken' value='tok123' />
  <input type="hidden" name="album_name" value="Let It Be (Expanded)" />
  <input type="hidden" name="album_artist_name" value="The Replacements" />
  <input type="hidden" name="album_image" value="None" />
  <input type="hidden" name="album_name_original" value="Let It Be (Expanded)" />
  <input type="hidden" name="album_artist_name_original" value="The Replacements" />
  <input type="hidden" name="count" value="0" />
  <input type="hidden" name="redirect" value="true" />
</form>`;

function edit(): PlannedAlbumEdit {
  return {
    artist: "Sinéad O'Connor",
    from: 'The Lion and the Cobra (Deluxe Edition)',
    to: 'The Lion and the Cobra',
    csrfToken: 'tok123',
    action: '/user/u/library/edit-album?edited-variation=library-album-scrobble&redirect=true',
    refererPath: '/user/u/library/music/+noredirect/A/B',
    groups: ['edition'],
  };
}

const stub = {} as never;

describe('extractAlbumForm', () => {
  it('harvests the album form and decodes its action', () => {
    const f = extractAlbumForm(PAGE);
    expect(f?.csrfmiddlewaretoken).toBe('tok123');
    expect(f?.album_name).toBe('Let It Be (Expanded)');
    expect(f?.album_artist_name).toBe('The Replacements');
    expect(f?.action).toBe(
      '/user/u/library/edit-album?edited-variation=library-album-scrobble&redirect=true',
    );
  });

  it('returns nothing when the page has no album form', () => {
    expect(extractAlbumForm('<div/>')).toBeUndefined();
    expect(extractAlbumForm('<form data-edit-album></form>')).toBeUndefined();
  });

  it('is not confused by a track form on the same page', () => {
    const both = '<form data-edit-scrobble action="/x"><input name="track_name" value="t" /></form>' + PAGE;
    expect(extractAlbumForm(both)?.album_name).toBe('Let It Be (Expanded)');
  });
});

describe('AlbumEditor.buildBody', () => {
  it('sends only the four album fields — no timestamp, track or edit_all', () => {
    const body = new AlbumEditor(stub, stub, 'u').buildBody(edit());
    expect([...body.keys()].sort()).toEqual([
      'ajax',
      'album_artist_name',
      'album_artist_name_original',
      'album_name',
      'album_name_original',
      'create_automatic_edit_rule',
      'csrfmiddlewaretoken',
      'submit',
    ]);
    expect(body.has('timestamp')).toBe(false);
    expect(body.has('track_name')).toBe(false);
    expect(body.has('edit_all')).toBe(false);
  });

  it('pairs original and new album names, and keeps the artist unchanged', () => {
    const body = new AlbumEditor(stub, stub, 'u').buildBody(edit());
    expect(body.get('album_name_original')).toBe('The Lion and the Cobra (Deluxe Edition)');
    expect(body.get('album_name')).toBe('The Lion and the Cobra');
    expect(body.get('album_artist_name_original')).toBe("Sinéad O'Connor");
    expect(body.get('album_artist_name')).toBe("Sinéad O'Connor");
  });

  it('identifies itself as an album submit, not a scrobble one', () => {
    expect(new AlbumEditor(stub, stub, 'u').buildBody(edit()).get('submit')).toBe('edit-album');
  });

  it('omits create_automatic_edit_rule entirely when disabled', () => {
    const off = new AlbumEditor(stub, stub, 'u', { createAutomaticRule: false }).buildBody(edit());
    expect(off.has('create_automatic_edit_rule')).toBe(false);
  });

  it('serialises apostrophes the form-urlencoded way', () => {
    const s = new AlbumEditor(stub, stub, 'u').buildBody(edit()).toString();
    expect(s).toContain('Sin%C3%A9ad+O%27Connor');
    expect(s).not.toContain("O'Connor");
  });
});
