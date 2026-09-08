import { describe, expect, it } from 'vitest';
import { Editor, extractAlerts } from '../../src/lastfm/editor.js';
import type { PlannedEdit } from '../../src/scrub/types.js';

function edit(overrides: Partial<PlannedEdit> = {}): PlannedEdit {
  return {
    original: {
      track_name: 'Silver Springs - 2004 Remaster',
      artist_name: "Sinéad O'Connor",
      album_name: 'Rumours (Deluxe Edition)',
      album_artist_name: 'Fleetwood Mac',
    },
    next: {
      track_name: 'Silver Springs',
      artist_name: "Sinéad O'Connor",
      album_name: 'Rumours',
      album_artist_name: 'Fleetwood Mac',
    },
    timestamp: '1772659220',
    csrfToken: 'tok',
    action: '/user/u/library/edit-track?edited-variation=library-track-scrobble',
    refererPath: '/user/u/library/music/+noredirect/Fleetwood+Mac/_/Silver+Springs',
    groups: ['remaster', 'edition'],
    ...overrides,
  };
}

const stubPages = {} as never;
const stubSession = {} as never;

describe('Editor.buildBody', () => {
  it('sends every _original alongside its new value', () => {
    const body = new Editor(stubSession, stubPages).buildBody(edit());
    expect(body.get('track_name_original')).toBe('Silver Springs - 2004 Remaster');
    expect(body.get('track_name')).toBe('Silver Springs');
    expect(body.get('album_name_original')).toBe('Rumours (Deluxe Edition)');
    expect(body.get('album_name')).toBe('Rumours');
  });

  it('echoes unchanged fields rather than omitting them', () => {
    const body = new Editor(stubSession, stubPages).buildBody(edit());
    expect(body.get('artist_name')).toBe("Sinéad O'Connor");
    expect(body.get('artist_name_original')).toBe("Sinéad O'Connor");
    expect(body.get('album_artist_name')).toBe('Fleetwood Mac');
  });

  it('carries the fields Last.fm requires that the userscript never names', () => {
    const body = new Editor(stubSession, stubPages).buildBody(edit());
    expect(body.get('submit')).toBe('edit-scrobble');
    expect(body.get('ajax')).toBe('1');
    expect(body.get('edit_all')).toBe('on');
    expect(body.get('csrfmiddlewaretoken')).toBe('tok');
    expect(body.get('timestamp')).toBe('1772659220');
  });

  it('omits create_automatic_edit_rule entirely when disabled, since there is no off value', () => {
    const on = new Editor(stubSession, stubPages, { createAutomaticRule: true }).buildBody(edit());
    expect(on.get('create_automatic_edit_rule')).toBe('on');

    const off = new Editor(stubSession, stubPages, { createAutomaticRule: false }).buildBody(edit());
    expect(off.has('create_automatic_edit_rule')).toBe(false);
    expect(off.toString()).not.toContain('create_automatic_edit_rule');
  });

  it('serialises with the form-urlencoded encoder, not encodeURIComponent', () => {
    const serialised = new Editor(stubSession, stubPages).buildBody(edit()).toString();
    expect(serialised).toContain('Sin%C3%A9ad+O%27Connor');
    expect(serialised).not.toContain("O'Connor");
  });

  it('handles a track-only change with an empty album', () => {
    const body = new Editor(stubSession, stubPages).buildBody(
      edit({
        original: {
          track_name: 'Song - Remastered',
          artist_name: 'A',
          album_name: '',
          album_artist_name: '',
        },
        next: { track_name: 'Song', artist_name: 'A', album_name: '', album_artist_name: '' },
      }),
    );
    expect(body.get('album_name')).toBe('');
    expect(body.get('album_name_original')).toBe('');
  });
});

describe('Editor.describe', () => {
  it('names only the fields that actually change', () => {
    const text = new Editor(stubSession, stubPages).describe(edit());
    expect(text).toContain('track_name');
    expect(text).toContain('album_name');
    expect(text).not.toContain('artist_name:');
  });
});

describe('extractAlerts', () => {
  it('pulls the text out of an alert-danger block', () => {
    const html = '<div class="alert alert-danger"><p>Something went wrong</p></div>';
    expect(extractAlerts(html)).toEqual(['Something went wrong']);
  });

  it('returns nothing for a clean response', () => {
    expect(extractAlerts('<div class="alert alert-success">Saved</div>')).toEqual([]);
    expect(extractAlerts('')).toEqual([]);
  });
});
