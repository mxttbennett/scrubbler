import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBackup, encodeUndo, parseUndo, reverseChanges } from '../../src/music/undo.js';
import type { MusicChange } from '../../src/music/planner.js';

const changes: MusicChange[] = [
  { persistentId: '00000000000000AF', field: 'name', original: '  =É\r\n,"世界"\n\r\u2028', new: '  É\r\n,"世界"\n\r\u2028' },
  { persistentId: '00000000000000AF', field: 'album', original: '', new: '' },
  { persistentId: '02', field: 'name', original: 'Same', new: 'Same' },
];
const header = 'persistent ID,field,original,new';

describe('Music undo CSV', () => {
  it('round trips exact Unicode, whitespace, quotes, line breaks, empty and equal values', () => {
    // Arrange
    const source = changes;
    // Act
    const csv = encodeUndo(source);
    const restored = parseUndo(csv);
    // Assert
    expect(csv.startsWith(`${header}\r\n"00000000000000AF","name","  =É`)).toBe(true);
    expect(restored).toEqual(changes);
    expect(parseUndo(`\uFEFF${csv}`)).toEqual(changes);
  });

  it.each(['\n', '\r\n', ''])('accepts a header-only document with %j ending', (ending) => {
    // Arrange
    const csv = header + ending;
    // Act
    const result = parseUndo(csv);
    // Assert
    expect(result).toEqual([]);
  });

  it('accepts unquoted cells and LF endings without trimming values', () => {
    // Arrange
    const csv = `${header}\n0001,album, old , new \n`;
    // Act
    const result = parseUndo(csv);
    // Assert
    expect(result).toEqual([{ persistentId: '0001', field: 'album', original: ' old ', new: ' new ' }]);
  });

  it.each([
    '', 'wrong,field,original,new', `${header}\n01,name,old`, `${header}\n01,name,old,new,extra`,
    `${header}\n01,name,"unfinished,new`, `${header}\n01,name,"old"x,new`, `${header}\n01,name,o"ld,new`,
    `${header}\n,name,old,new`, `${header}\nXYZ,name,old,new`, `${header}\n 01,name,old,new`,
    `${header}\n01,artist,old,new`, `${header}\n01,name,old,new\n01,name,old,new`,
    `${header}\nAF,name,old,new\naf,name,old,new`, `${header}\n01,name,old,new\n\n`,
  ])('rejects malformed or duplicate rows %j', (csv) => {
    // Arrange
    const source = csv;
    // Act
    const parse = () => parseUndo(source);
    // Assert
    expect(parse).toThrow();
  });

  it('reverses exactly without changing identity, ordering, or empty values', () => {
    // Arrange
    const source = changes;
    // Act
    const reversed = reverseChanges(source);
    // Assert
    expect(reversed[0]).toEqual({ persistentId: '00000000000000AF', field: 'name', original: '  É\r\n,"世界"\n\r\u2028', new: '  =É\r\n,"世界"\n\r\u2028' });
    expect(reverseChanges(reversed)).toEqual(source);
    expect(source[0]?.original).toContain('=É');
  });

  it('creates an exclusive flushed CSV and refuses a same-second collision', async () => {
    // Arrange
    const directory = await mkdtemp(join(tmpdir(), 'scrubbler-music-'));
    const now = () => new Date('2026-10-09T19:39:00.999Z');
    try {
      // Act
      const path = await createBackup(changes, { directory, now });
      // Assert
      expect(isAbsolute(path)).toBe(true);
      expect(path).toBe(join(directory, 'undo-2026-10-09T19-39-00.csv'));
      expect(parseUndo(await readFile(path, 'utf8'))).toEqual(changes);
      await expect(createBackup(changes, { directory, now })).rejects.toThrow(/EEXIST/);
      expect(parseUndo(await readFile(path, 'utf8'))).toEqual(changes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('awaits write, flush, and close before returning the backup path', async () => {
    // Arrange
    const events: string[] = [];
    const fs = {
      mkdir: async () => { events.push('mkdir'); },
      open: async (_path: string, flag: string) => {
        events.push(flag);
        return {
          writeFile: async (csv: string) => { expect(parseUndo(csv)).toEqual(changes); events.push('write'); },
          sync: async () => { events.push('sync'); }, close: async () => { events.push('close'); },
        };
      },
    };
    // Act
    await createBackup(changes, { fs });
    // Assert
    expect(events).toEqual(['mkdir', 'wx', 'write', 'sync', 'close']);
  });

  it.each(['mkdir', 'open', 'writeFile', 'sync', 'close'] as const)('rejects a backup %s failure', async (failure) => {
    // Arrange
    const fail = async () => { throw new Error(failure); };
    const file = { writeFile: vi.fn(async () => {}), sync: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const fs = { mkdir: vi.fn(async () => {}), open: vi.fn(async () => file) };
    if (failure === 'mkdir' || failure === 'open') fs[failure].mockImplementation(fail);
    else file[failure].mockImplementation(fail);
    // Act
    const backup = createBackup(changes, { fs });
    // Assert
    await expect(backup).rejects.toThrow(failure);
    if (failure === 'writeFile' || failure === 'sync') expect(file.close).toHaveBeenCalledTimes(1);
  });
});
