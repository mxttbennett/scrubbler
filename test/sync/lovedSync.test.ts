import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LibraryTrack, MusicLibrary } from '../../src/sync/appleMusic.js';
import { LovedSync, SyncState, type LovedTrack } from '../../src/sync/lovedSync.js';

class FakeLibrary implements MusicLibrary {
  written: string[] = [];
  constructor(private readonly rows: LibraryTrack[]) {}
  async tracks() {
    return this.rows;
  }
  async favorite(ids: readonly string[]) {
    this.written.push(...ids);
    return ids.length;
  }
}

const row = (id: string, artist: string, name: string, favorited = false): LibraryTrack => ({
  persistentId: id,
  artist,
  name,
  favorited,
});

async function* loves(...items: LovedTrack[]) {
  for (const i of items) yield i;
}

const statePath = () => join(mkdtempSync(join(tmpdir(), 'apple-sync-')), 'state.json');

describe('LovedSync', () => {
  it('favorites matched tracks, including every copy, and reports the rest', async () => {
    const lib = new FakeLibrary([row('A', 'Neu!', 'Hallogallo'), row('B', 'Neu!', 'Hallogallo'), row('C', 'X', 'Y')]);
    const r = await new LovedSync(lib, new SyncState(statePath()), { dryRun: false }).run(
      loves({ artist: 'Neu!', name: 'Hallogallo' }, { artist: 'Nobody', name: 'Nothing' }),
    );

    expect(lib.written).toEqual(['A', 'B']);
    expect(r.favorited).toHaveLength(1);
    expect(r.notInLibrary).toEqual([{ artist: 'Nobody', name: 'Nothing' }]);
  });

  it('matches across typographic punctuation and case', async () => {
    const lib = new FakeLibrary([row('A', 'Jim O’Rourke', 'Happy Days')]);
    await new LovedSync(lib, new SyncState(statePath()), { dryRun: false }).run(
      loves({ artist: "jim o'rourke", name: 'Happy Days' }),
    );
    expect(lib.written).toEqual(['A']);
  });

  it('does not rewrite a track that is already favorited', async () => {
    const lib = new FakeLibrary([row('A', 'a', 't', true)]);
    const r = await new LovedSync(lib, new SyncState(statePath()), { dryRun: false }).run(
      loves({ artist: 'a', name: 't' }),
    );
    expect(lib.written).toEqual([]);
    expect(r.alreadyDone).toBe(1);
  });

  it('leaves a track alone once handled, so an un-favorite sticks', async () => {
    const path = statePath();
    const first = new FakeLibrary([row('A', 'a', 't')]);
    await new LovedSync(first, new SyncState(path), { dryRun: false }).run(loves({ artist: 'a', name: 't' }));
    expect(first.written).toEqual(['A']);

    const second = new FakeLibrary([row('A', 'a', 't', false)]);
    const r = await new LovedSync(second, new SyncState(path), { dryRun: false }).run(
      loves({ artist: 'a', name: 't' }),
    );
    expect(second.written).toEqual([]);
    expect(r.alreadyDone).toBe(1);
  });

  it('writes nothing and remembers nothing in a dry run', async () => {
    const path = statePath();
    const lib = new FakeLibrary([row('A', 'a', 't')]);
    const r = await new LovedSync(lib, new SyncState(path), { dryRun: true }).run(loves({ artist: 'a', name: 't' }));
    expect(r.favorited).toHaveLength(1);
    expect(lib.written).toEqual([]);

    const again = await new LovedSync(lib, new SyncState(path), { dryRun: true }).run(loves({ artist: 'a', name: 't' }));
    expect(again.favorited).toHaveLength(1);
  });

  it('retries a not-in-library love on a later run, once the track is added', async () => {
    const path = statePath();
    await new LovedSync(new FakeLibrary([]), new SyncState(path), { dryRun: false }).run(loves({ artist: 'a', name: 't' }));
    const lib = new FakeLibrary([row('A', 'a', 't')]);
    await new LovedSync(lib, new SyncState(path), { dryRun: false }).run(loves({ artist: 'a', name: 't' }));
    expect(lib.written).toEqual(['A']);
  });
});
