import { describe, expect, it, vi } from 'vitest';
import { runMusic } from '../../src/music/cli.js';
import { READER_SCRIPT, WRITER_SCRIPT } from '../../src/music/osascript.js';
import type { MusicChange } from '../../src/music/planner.js';
import { encodeUndo } from '../../src/music/undo.js';
import { runInNewContext } from 'node:vm';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Music CLI arguments', () => {
  it.each([
    ['--unknown'], ['--undo'], ['--undo', ''], ['--undo', '--apply'],
    ['--apply', '--undo', 'backup.csv'], ['--apply', '--apply'], ['backup.csv'],
  ])('rejects %j before any side effects', async (...args) => {
    // Arrange
    const runScript = vi.fn();
    const backup = vi.fn();
    const readFile = vi.fn();
    const output = vi.fn();
    // Act
    const status = await runMusic(args, { runScript, backup, readFile, output });
    // Assert
    expect(status).toBe(1);
    expect(runScript).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalled();
  });

  it('prints help without Music or filesystem access', async () => {
    // Arrange
    const runScript = vi.fn();
    const backup = vi.fn();
    const readFile = vi.fn();
    const output = vi.fn();
    // Act
    const status = await runMusic(['--help'], { runScript, backup, readFile, output });
    // Assert
    expect(status).toBe(0);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('--undo <csv>'));
    expect(runScript).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('Music undo CLI', () => {
  it('restores a partially applied CSV, skips unchanged fields, preserves manual edits, and continues past missing tracks', async () => {
    // Arrange
    const changes: MusicChange[] = [
      { persistentId: '01', field: 'name', original: 'Song (Remastered)', new: 'Song' },
      { persistentId: '01', field: 'album', original: 'Album (Deluxe Edition)', new: 'Album' },
      { persistentId: '02', field: 'name', original: 'Unchanged', new: 'Changed' },
      { persistentId: '03', field: 'name', original: 'Before', new: 'After' },
      { persistentId: '04', field: 'album', original: 'Deleted', new: 'Gone' },
      { persistentId: '05', field: 'name', original: 'Earlier', new: 'Later' },
    ];
    const values: Record<string, Record<string, string>> = {
      '01': { name: 'Song', album: 'Album (Deluxe Edition)' },
      '02': { name: 'Unchanged' }, '03': { name: 'Manual edit' }, '05': { name: 'Later' },
    };
    const sets: string[] = [];
    const Application = () => ({ libraryPlaylists: [{ tracks: {
      whose: ({ persistentID }: { persistentID: string }) => () => {
        const fields = values[persistentID];
        if (!fields) return [];
        const track = {};
        for (const field of ['name', 'album']) {
          Object.defineProperty(track, field, {
            get: () => () => fields[field],
            set: (value: string) => { fields[field] = value; sets.push(`${persistentID}:${field}`); },
          });
        }
        return [track];
      },
    } }] });
    const runScript = vi.fn(async (script: string, args: string[]) => {
      expect(script).toBe(WRITER_SCRIPT);
      return runInNewContext(`${script}\nrun(argv)`, { Application, argv: args }) as string;
    });
    const backup = vi.fn();
    const readFile = vi.fn(async () => encodeUndo(changes));
    const output = vi.fn();
    // Act
    const status = await runMusic(['--undo', '/absolute/undo.csv'], { runScript, backup, readFile, output });
    const again = await runMusic(['--undo', '/absolute/undo.csv'], { runScript, backup, readFile, output });
    // Assert
    expect(status).toBe(1);
    expect(again).toBe(1);
    expect(values['01']).toEqual({ name: 'Song (Remastered)', album: 'Album (Deluxe Edition)' });
    expect(values['02']?.name).toBe('Unchanged');
    expect(values['03']?.name).toBe('Manual edit');
    expect(values['05']?.name).toBe('Earlier');
    expect(sets).toEqual(['01:name', '05:name']);
    expect(backup).not.toHaveBeenCalled();
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledWith('/absolute/undo.csv');
    expect(output).toHaveBeenCalledWith('Fields: applied 2; already-target 2; conflict 1; failed 1; unknown 0; not submitted 0');
    expect(output).toHaveBeenCalledWith('Fields: applied 0; already-target 4; conflict 1; failed 1; unknown 0; not submitted 0');
    expect(output).toHaveBeenCalledWith(expect.stringContaining('name: Song -> Song (Remastered)'));
  });

  it.each(['invalid', 'persistent ID,field,original,new\n01,name,before,after\n01,name,duplicate,duplicate'])('rejects corrupted undo files before Music access', async (csv) => {
    // Arrange
    const runScript = vi.fn();
    const backup = vi.fn();
    const readFile = vi.fn(async () => csv);
    // Act
    const status = await runMusic(['--undo', 'undo.csv'], { runScript, backup, readFile, output: () => {} });
    // Assert
    expect(status).toBe(1);
    expect(runScript).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
  });

  it('retains the existing recovery record after an unknown undo batch without discovery or another backup', async () => {
    // Arrange
    const csv = encodeUndo([{ persistentId: '01', field: 'album', original: 'Old', new: 'New' }]);
    const runScript = vi.fn(async (script: string) => { expect(script).toBe(WRITER_SCRIPT); throw new Error('timeout'); });
    const readFile = vi.fn(async () => csv);
    const backup = vi.fn();
    const output = vi.fn();
    // Act
    const status = await runMusic(['--undo', 'undo.csv'], { runScript, backup, readFile, output });
    // Assert
    expect(status).toBe(1);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(backup).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('unknown 1; not submitted 0'));
  });

  it('accepts a header-only undo file with no Music or backup calls', async () => {
    // Arrange
    const runScript = vi.fn();
    const backup = vi.fn();
    const readFile = vi.fn(async () => 'persistent ID,field,original,new\n');
    // Act
    const status = await runMusic(['--undo', 'undo.csv'], { runScript, backup, readFile, output: () => {} });
    // Assert
    expect(status).toBe(0);
    expect(runScript).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
  });
});

describe('Music forward CLI', () => {
  it('discovers once, completes the backup, then submits both changed fields', async () => {
    // Arrange
    const events: string[] = [];
    const runScript = vi.fn(async (script: string, args: string[]) => {
      if (script === READER_SCRIPT) {
        events.push('discover');
        expect(args).toEqual([]);
        return JSON.stringify([{ persistentId: '01', name: 'Song (Remastered)', album: 'Album (Deluxe Edition)', artist: 'Artist', albumArtist: null }]);
      }
      expect(script).toBe(WRITER_SCRIPT);
      events.push('write');
      return JSON.stringify(['album', 'name'].map((field) => ({ persistentId: '01', field, status: 'applied', diagnostic: '' })));
    });
    const backup = vi.fn(async (changes: MusicChange[]) => { expect(changes).toHaveLength(2); events.push('backup'); return '/absolute/undo.csv'; });
    const output = vi.fn((line: string) => { if (line.startsWith('Undo CSV:')) events.push('backup path'); });
    // Act
    const status = await runMusic(['--apply'], { runScript, backup, output });
    // Assert
    expect(status).toBe(0);
    expect(events).toEqual(['discover', 'backup', 'backup path', 'write']);
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(output).toHaveBeenCalledWith('Fields: applied 2; already-target 0; conflict 0; failed 0; unknown 0; not submitted 0');
  });

  it.each(['[]', '[{"persistentId":"01"}]'])('does no backup or write for empty or invalid discovery %s', async (json) => {
    // Arrange
    const runScript = vi.fn(async () => json);
    const backup = vi.fn();
    const output = vi.fn();
    // Act
    const status = await runMusic(['--apply'], { runScript, backup, output });
    // Assert
    expect(status).toBe(json === '[]' ? 0 : 1);
    expect(backup).not.toHaveBeenCalled();
    expect(runScript).toHaveBeenCalledTimes(1);
  });
});

describe('Music isolation', () => {
  it('previews without Last.fm credentials or state despite Last.fm mutation and rule variables', async () => {
    // Arrange
    const directory = await mkdtemp(join(tmpdir(), 'scrubbler-isolation-'));
    for (const key of ['LASTFM_API_KEY', 'LASTFM_USERNAME', 'LASTFM_PASSWORD']) vi.stubEnv(key, undefined);
    vi.stubEnv('DRY_RUN', 'false');
    vi.stubEnv('RULES', 'live-track:auto');
    vi.stubEnv('RULES_ENABLED', 'feat-track');
    vi.stubEnv('APPROVAL_MODE', 'true');
    vi.stubEnv('DB_PATH', join(directory, 'lastfm.sqlite'));
    const backup = vi.fn();
    const readFile = vi.fn();
    const output = vi.fn();
    const runScript = vi.fn(async (script: string, args: string[]) => {
      expect(script).toBe(READER_SCRIPT);
      expect(args).toEqual([]);
      return JSON.stringify([{ persistentId: '01', name: 'Song (Live)', album: 'Album (Remastered)', artist: null, albumArtist: null }]);
    });
    try {
      // Act
      const status = await runMusic([], { runScript, backup, readFile, output });
      // Assert
      expect(status).toBe(0);
      expect(runScript).toHaveBeenCalledTimes(1);
      expect(backup).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
      expect(output).toHaveBeenCalledWith(expect.stringContaining('Music preview: active groups remaster, edition, bonus; no environment, database, custom, or ignore overrides.'));
      expect(output).toHaveBeenCalledWith(expect.stringContaining('album (unknown artist): Album (Remastered) -> Album (1 tracks)'));
      expect(output).not.toHaveBeenCalledWith(expect.stringContaining('name (unknown artist)'));
      expect(await readdir(directory)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
