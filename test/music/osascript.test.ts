import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { discoverMusic, READER_SCRIPT } from '../../src/music/osascript.js';

describe('Music bulk reader', () => {
  it.each([0, 5000])('zips %i tracks with exactly five collection reads', async (count) => {
    // Arrange
    const ids = Array.from({ length: count }, (_, i) => i.toString(16).padStart(16, '0'));
    const getters = {
      persistentID: vi.fn(() => ids), name: vi.fn(() => ids.map(() => 'Song')),
      album: vi.fn(() => ids.map(() => null)), artist: vi.fn(() => ids.map(() => undefined)),
      albumArtist: vi.fn(() => ids.map(() => 'Artist')),
    };
    const Application = vi.fn(() => ({ libraryPlaylists: [{ tracks: getters }] }));
    const runner = vi.fn((script: string, args: string[]) => {
      expect(args).toEqual([]);
      return Promise.resolve(runInNewContext(script, { Application }) as string);
    });
    // Act
    const tracks = await discoverMusic(runner);
    // Assert
    expect(tracks).toHaveLength(count);
    if (count) expect(tracks[0]).toEqual({ persistentId: '0000000000000000', name: 'Song', album: null, artist: null, albumArtist: 'Artist' });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(Application).toHaveBeenCalledWith('Music');
    for (const getter of Object.values(getters)) expect(getter).toHaveBeenCalledTimes(1);
  });

  it('rejects misaligned collection lengths', () => {
    // Arrange
    const Application = () => ({ libraryPlaylists: [{ tracks: {
      persistentID: () => ['AB'], name: () => [], album: () => [], artist: () => [], albumArtist: () => [],
    } }] });
    // Act
    const read = () => runInNewContext(READER_SCRIPT, { Application }) as unknown;
    // Assert
    expect(read).toThrow(/length/i);
  });

  it.each([
    'partial', '{}', 'null', '[null]',
    '[{"persistentId":"AB"}]',
    ...['', ' ', 'xyz'].map((persistentId) => JSON.stringify([{ persistentId, name: '', album: '', artist: '', albumArtist: '' }])),
    ...[1, false, {}, []].map((name) => JSON.stringify([{ persistentId: 'AB', name, album: null, artist: null, albumArtist: null }])),
    JSON.stringify(Array.from({ length: 2 }, () => ({ persistentId: 'AB', name: null, album: null, artist: null, albumArtist: null }))),
    JSON.stringify(['AB', 'ab'].map((persistentId) => ({ persistentId, name: null, album: null, artist: null, albumArtist: null }))),
  ])('rejects invalid discovery JSON %s', async (stdout) => {
    // Arrange
    const runner = vi.fn(async () => stdout);
    // Act
    const read = discoverMusic(runner);
    // Assert
    await expect(read).rejects.toThrow();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it.each(['timeout', 'maxBuffer', 'process error'])('rejects %s without retrying partial output', async (message) => {
    // Arrange
    const runner = vi.fn(async () => { throw Object.assign(new Error(message), { stdout: '[]' }); });
    // Act
    const read = discoverMusic(runner);
    // Assert
    await expect(read).rejects.toThrow(message);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
