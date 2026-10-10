import { describe, expect, it } from 'vitest';
import { MusicAppError, OsascriptLibrary } from '../../src/sync/appleMusic.js';

describe('OsascriptLibrary', () => {
  it('parses the JSON the script prints', async () => {
    const lib = new OsascriptLibrary({
      exec: async () => ({ stdout: JSON.stringify([['ID1', 'Artist', 'Song', true], ['ID2', 'B', 'S2', false]]) }),
    });
    expect(await lib.tracks()).toEqual([
      { persistentId: 'ID1', artist: 'Artist', name: 'Song', favorited: true },
      { persistentId: 'ID2', artist: 'B', name: 'S2', favorited: false },
    ]);
  });

  it('passes ids as argv, never inside the script source', async () => {
    let call: string[] = [];
    const lib = new OsascriptLibrary({
      exec: async (_file, args) => {
        call = args;
        return { stdout: '2\n' };
      },
    });
    expect(await lib.favorite(['AAA', 'BBB'])).toBe(2);
    expect(call.slice(-2)).toEqual(['AAA', 'BBB']);
    expect(call[3]).not.toContain('AAA');
  });

  it('skips osascript entirely when there is nothing to write', async () => {
    const lib = new OsascriptLibrary({ exec: async () => { throw new Error('called'); } });
    expect(await lib.favorite([])).toBe(0);
  });

  it('wraps a script failure and a malformed reply', async () => {
    await expect(new OsascriptLibrary({ exec: async () => { throw new Error('boom'); } }).tracks()).rejects.toBeInstanceOf(MusicAppError);
    await expect(new OsascriptLibrary({ exec: async () => ({ stdout: 'nope' }) }).tracks()).rejects.toBeInstanceOf(MusicAppError);
  });
});
