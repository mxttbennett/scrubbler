import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { applyMusic, executeChanges } from '../../src/music/executor.js';
import { WRITER_SCRIPT, type ScriptRunner } from '../../src/music/osascript.js';
import type { MusicChange } from '../../src/music/planner.js';

interface Fixture {
  id: string;
  name: string | null;
  album: string | null;
  fail?: 'name' | 'album';
  noop?: 'name' | 'album';
}

function fakeMusic(fixtures: Fixture[]) {
  const sets: { id: string; field: string; value: unknown }[] = [];
  const predicates: unknown[] = [];
  const tracks = fixtures.map((fixture) => {
    const track = {};
    for (const field of ['name', 'album'] as const) {
      Object.defineProperty(track, field, {
        get: () => () => fixture[field],
        set: (value: string) => {
          if (fixture.fail === field) throw new Error(`Cannot set ${field}`);
          sets.push({ id: fixture.id, field, value });
          if (fixture.noop !== field) fixture[field] = value;
        },
      });
    }
    return { fixture, track };
  });
  const Application = (name: string) => {
    expect(name).toBe('Music');
    return { libraryPlaylists: [{ tracks: {
      whose: (predicate: { persistentID: string }) => {
        predicates.push(predicate);
        return () => tracks.filter(({ fixture }) => fixture.id === predicate.persistentID).map(({ track }) => track);
      },
    } }] };
  };
  const runner = vi.fn<ScriptRunner>(async (script, args) => {
    expect(script).toBe(WRITER_SCRIPT);
    expect(args).toHaveLength(1);
    return runInNewContext(`${script}\nrun(argv)`, { Application, argv: args }) as string;
  });
  return { runner, fixtures, sets, predicates };
}

const change = (persistentId = '01', field: MusicChange['field'] = 'name', original = 'Old', target = 'New'): MusicChange => ({
  persistentId, field, original, new: target,
});

describe('Music conditional writer', () => {
  it('writes both fields for one persistent ID with exact special-character payloads', async () => {
    // Arrange
    const original = 'Old\n"quoted", É\\ $(touch nope)\u2028\u2029';
    const target = 'New\r\n"quoted", 世界\\ `shell`\u2028\u2029';
    const music = fakeMusic([{ id: '01', name: original, album: original }]);
    // Act
    const result = await executeChanges([change('01', 'name', original, target), change('01', 'album', original, target)], { runScript: music.runner, output: () => {} });
    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.results.map((r) => r.status)).toEqual(['applied', 'applied']);
    expect(music.fixtures[0]).toMatchObject({ name: target, album: target });
    expect(music.predicates).toEqual([{ persistentID: '01' }]);
    expect(music.runner).toHaveBeenCalledTimes(1);
    expect(WRITER_SCRIPT).not.toContain(original);
  });

  it('reports already-target, conflicts, missing IDs, nonunique IDs, and read-back mismatches', async () => {
    // Arrange
    const music = fakeMusic([
      { id: '01', name: 'New', album: 'Old' }, { id: '02', name: 'Manual', album: 'Old' },
      { id: '04', name: 'Old', album: 'Old' }, { id: '04', name: 'Old', album: 'Old' },
      { id: '05', name: 'Old', album: 'Old', noop: 'name' },
    ]);
    // Act
    const result = await executeChanges(['01', '02', '03', '04', '05'].map((id) => change(id)), { runScript: music.runner, output: () => {} });
    // Assert
    expect(result.exitCode).toBe(1);
    expect(result.results.map((r) => r.status)).toEqual(['already-target', 'conflict', 'failed', 'failed', 'failed']);
    expect(result.results[2]?.diagnostic).toMatch(/missing/i);
    expect(result.results[3]?.diagnostic).toMatch(/nonunique/i);
    expect(result.results[4]?.diagnostic).toMatch(/read-back/i);
    expect(music.sets).toEqual([{ id: '05', field: 'name', value: 'New' }]);
  });

  it.each(['conflict', 'setter'] as const)('continues independent fields and later tracks after a %s error', async (failure) => {
    // Arrange
    const fixture: Fixture = { id: '01', name: failure === 'conflict' ? 'Manual' : 'Old', album: 'Old' };
    if (failure === 'setter') fixture.fail = 'name';
    const music = fakeMusic([fixture, { id: '02', name: 'Old', album: 'Old' }]);
    // Act
    const result = await executeChanges([change(), change('01', 'album'), change('02')], { runScript: music.runner, output: () => {} });
    // Assert
    expect(result.exitCode).toBe(1);
    expect(result.results.map((r) => r.status)).toEqual([failure === 'conflict' ? 'conflict' : 'failed', 'applied', 'applied']);
    expect(fixture.album).toBe('New');
    expect(music.fixtures[1]?.name).toBe('New');
  });

  it('handles empty and equal values with exact comparisons', async () => {
    // Arrange
    const music = fakeMusic([{ id: '01', name: '', album: ' ' }, { id: '02', name: 'Same', album: '' }]);
    // Act
    const result = await executeChanges([change('01', 'name', '', ''), change('01', 'album', '', 'Target'), change('02', 'name', 'Same', 'Same'), change('02', 'album', '', 'Target')], { runScript: music.runner, output: () => {} });
    // Assert
    expect(result.results.map((r) => r.status)).toEqual(['already-target', 'conflict', 'already-target', 'applied']);
    expect(music.sets).toEqual([{ id: '02', field: 'album', value: 'Target' }]);
  });

  it('batches 101 tracks serially with both fields together and continues after failures', async () => {
    // Arrange
    const fixtures = Array.from({ length: 101 }, (_, i): Fixture => ({ id: i.toString(16), name: i === 0 ? 'Manual' : 'Old', album: 'Old' }));
    fixtures[1]!.fail = 'name';
    const music = fakeMusic(fixtures);
    const changes = fixtures.flatMap((fixture) => [change(fixture.id), change(fixture.id, 'album')]);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const runner: ScriptRunner = async (script, args) => {
      calls++;
      if (calls === 1) await gate;
      return music.runner(script, args);
    };
    // Act
    const execution = executeChanges(changes, { runScript: runner, output: () => {} });
    await Promise.resolve();
    // Assert
    expect(calls).toBe(1);
    release!();
    const result = await execution;
    expect(calls).toBe(2);
    const sizes = music.runner.mock.calls.map(([, args]) => (JSON.parse(args[0]!) as unknown[]).length);
    expect(sizes).toEqual([100, 1]);
    expect(result.results).toHaveLength(202);
    expect(result.results.filter((r) => r.status === 'applied')).toHaveLength(200);
    expect(result.exitCode).toBe(1);
    expect(fixtures[100]).toMatchObject({ name: 'New', album: 'New' });
  });
});

describe('Music batch protocol', () => {
  it.each([
    'bad JSON', '{}', '[]', '[null]',
    '[{"persistentId":"01","field":"name","status":"unknown","diagnostic":""}]',
    '[{"persistentId":"01","field":"name","status":"applied"}]',
    '[{"persistentId":"02","field":"name","status":"applied","diagnostic":""}]',
    '[{"persistentId":"01","field":"artist","status":"applied","diagnostic":""}]',
    '[{"persistentId":"01","field":"name","status":"applied","diagnostic":3}]',
    '[{"persistentId":"01","field":"name","status":["applied"],"diagnostic":""}]',
    JSON.stringify(Array.from({ length: 2 }, () => ({ persistentId: '01', field: 'name', status: 'applied', diagnostic: '' }))),
  ])('treats malformed or incomplete results as unknown with no retries: %s', async (response) => {
    // Arrange
    const runner = vi.fn(async () => response);
    const changes = [change()];
    // Act
    const result = await executeChanges(changes, { runScript: runner, output: () => {} });
    // Assert
    expect(result.exitCode).toBe(1);
    expect(result.results).toEqual([]);
    expect(result.unknown).toBe(1);
    expect(result.notSubmitted).toBe(0);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('retains earlier confirmed results and stops after a process failure in a later batch', async () => {
    // Arrange
    const fixtures = Array.from({ length: 201 }, (_, i): Fixture => ({ id: i.toString(16), name: 'Old', album: 'Old' }));
    const music = fakeMusic(fixtures);
    const runner = vi.fn<ScriptRunner>().mockImplementationOnce(music.runner).mockRejectedValue(new Error('timeout'));
    // Act
    const result = await executeChanges(fixtures.map((f) => change(f.id)), { runScript: runner, output: () => {} });
    // Assert
    expect(result.results).toHaveLength(100);
    expect(result.unknown).toBe(100);
    expect(result.notSubmitted).toBe(1);
    expect(result.error).toBe('timeout');
    expect(result.exitCode).toBe(1);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate result keys even when the result count matches', async () => {
    // Arrange
    const runner = vi.fn(async () => JSON.stringify(Array.from({ length: 2 }, () => ({ persistentId: '01', field: 'name', status: 'applied', diagnostic: '' }))));
    // Act
    const result = await executeChanges([change(), change('01', 'album')], { runScript: runner, output: () => {} });
    // Assert
    expect(result.unknown).toBe(2);
    expect(result.results).toEqual([]);
    expect(result.exitCode).toBe(1);
  });

  it('submits nothing for an empty plan', async () => {
    // Arrange
    const runner = vi.fn();
    const backup = vi.fn();
    // Act
    const result = await applyMusic([], { runScript: runner, backup, output: () => {} });
    // Assert
    expect(result.exitCode).toBe(0);
    expect(runner).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
  });
});

describe('Music forward backup', () => {
  it('prints the complete backup path before any mutation and retains it after failure', async () => {
    // Arrange
    const events: string[] = [];
    const output = (line: string) => { events.push(line); };
    const backup = async () => { events.push('backup complete'); return '/absolute/undo.csv'; };
    const runner: ScriptRunner = async () => { events.push('write'); throw new Error('timeout'); };
    // Act
    const result = await applyMusic([change()], { runScript: runner, backup, output });
    // Assert
    expect(events.slice(0, 3)).toEqual(['backup complete', 'Undo CSV: /absolute/undo.csv', 'write']);
    expect(result.exitCode).toBe(1);
    expect(result.unknown).toBe(1);
  });

  it.each(['create', 'write', 'flush', 'close'])('makes zero write calls if backup %s fails', async (failure) => {
    // Arrange
    const runner = vi.fn();
    const backup = async () => { throw new Error(failure); };
    // Act
    const apply = applyMusic([change()], { runScript: runner, backup, output: () => {} });
    // Assert
    await expect(apply).rejects.toThrow(failure);
    expect(runner).not.toHaveBeenCalled();
  });
});
