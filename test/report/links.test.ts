import { describe, expect, it } from 'vitest';
import { LINK_GLYPH, albumUrl, artistUrl, linkSuffix, trackUrl } from '../../src/report/links.js';

const USER = 'dankjankem';

describe('library URLs', () => {
  it('matches the schema the user browses', () => {
    expect(artistUrl(USER, 'Bladee')).toBe('https://www.last.fm/user/dankjankem/library/music/Bladee');
    expect(albumUrl(USER, 'Bladee', 'Icedancer')).toBe(
      'https://www.last.fm/user/dankjankem/library/music/Bladee/Icedancer',
    );
  });

  it('puts a track under the /_/ segment, as the library does', () => {
    expect(trackUrl(USER, 'Bladee', 'Be Nice 2 Me')).toBe(
      'https://www.last.fm/user/dankjankem/library/music/Bladee/_/Be+Nice+2+Me',
    );
  });

  it('encodes parentheses, which would otherwise end the markdown link early', () => {
    const url = albumUrl(USER, 'Nirvana', 'In Utero (Deluxe Edition)');
    expect(url).not.toContain('(');
    expect(url).not.toContain(')');
    expect(url).toBe(
      'https://www.last.fm/user/dankjankem/library/music/Nirvana/In+Utero+%28Deluxe+Edition%29',
    );
  });

  it('escapes the characters real titles actually contain', () => {
    expect(albumUrl(USER, 'AC/DC', 'Back in Black')).toContain('AC%2FDC');
    expect(trackUrl(USER, 'Wire', '12XU')).toContain('/_/12XU');
    expect(albumUrl(USER, 'Fishmans', '98.12.28 男達の別れ')).toContain('%E7%94%B7');
    expect(trackUrl(USER, 'Slint', 'Good Morning, Captain')).toContain('Good+Morning%2C+Captain');
  });

  it('links the library page, not the global artist page', () => {
    expect(artistUrl(USER, 'Bladee')).toContain(`/user/${USER}/library/`);
  });

  it('omits +noredirect, which exists for editing and not for reading', () => {
    expect(albumUrl(USER, 'Bladee', 'Icedancer')).not.toContain('noredirect');
  });
});

describe('linkSuffix', () => {
  it('is a small trailing glyph, not a linked name', () => {
    expect(linkSuffix('https://example.com')).toBe(` [${LINK_GLYPH}](https://example.com)`);
  });

  it('renders nothing at all when there is no url', () => {
    expect(linkSuffix(undefined)).toBe('');
  });
});
