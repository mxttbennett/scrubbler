import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { punctuationKey } from '../rules/fold.js';
import type { MusicLibrary } from './appleMusic.js';

export interface LovedTrack {
  artist: string;
  name: string;
}

export interface SyncResult {
  loved: number;
  /** Favorited this run (or, in a dry run, the ones that would be). */
  favorited: LovedTrack[];
  /** Loved on Last.fm but nothing in the library matches: part 2's catalog search territory. */
  notInLibrary: LovedTrack[];
  /** Already favorited in Music.app, or synced by an earlier run. */
  alreadyDone: number;
}

export const trackKey = (t: LovedTrack): string => `${punctuationKey(t.artist)}\u0000${punctuationKey(t.name)}`;

/**
 * Remembers what a run has already handled. Without it, a track the user deliberately un-favorited
 * in Music.app would be favorited again on every run for as long as it stays loved on Last.fm.
 */
export class SyncState {
  private readonly keys: Set<string>;

  constructor(private readonly path: string) {
    this.keys = new Set(existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as string[]) : []);
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {
    this.keys.add(key);
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.keys].sort()));
    renameSync(tmp, this.path);
  }
}

/**
 * Last.fm loves → Music.app favorites, one-way and library-only. Matching is on the punctuation-
 * folded artist and title, exact otherwise: a fuzzier match would favorite the wrong recording, and
 * a missed match is only reported, never wrong.
 */
export class LovedSync {
  constructor(
    private readonly library: MusicLibrary,
    private readonly state: SyncState,
    private readonly opts: { dryRun: boolean },
  ) {}

  async run(loves: AsyncIterable<LovedTrack>): Promise<SyncResult> {
    const byKey = new Map<string, { ids: string[]; anyFavorited: boolean }>();
    for (const t of await this.library.tracks()) {
      const key = trackKey({ artist: t.artist, name: t.name });
      const entry = byKey.get(key) ?? { ids: [], anyFavorited: false };
      entry.ids.push(t.persistentId);
      entry.anyFavorited ||= t.favorited;
      byKey.set(key, entry);
    }

    const result: SyncResult = { loved: 0, favorited: [], notInLibrary: [], alreadyDone: 0 };
    const toWrite: string[] = [];
    const written: string[] = [];
    const seen = new Set<string>();

    for await (const love of loves) {
      const key = trackKey(love);
      if (seen.has(key)) continue;
      seen.add(key);
      result.loved++;

      if (this.state.has(key)) {
        result.alreadyDone++;
        continue;
      }
      const match = byKey.get(key);
      if (match === undefined) {
        result.notInLibrary.push(love);
        continue;
      }
      // Recorded even when nothing needs writing, so a later un-favorite in Music.app sticks.
      written.push(key);
      if (match.anyFavorited) {
        result.alreadyDone++;
        continue;
      }
      // Every copy: a library often holds the single and the album cut of the same song.
      toWrite.push(...match.ids);
      result.favorited.push(love);
    }

    if (this.opts.dryRun) return result;

    if (toWrite.length > 0) await this.library.favorite(toWrite);
    for (const key of written) this.state.add(key);
    this.state.save();
    return result;
  }
}
