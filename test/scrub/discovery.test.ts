import { describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { Planner } from '../../src/scrub/planner.js';
import type { LastfmApi } from '../../src/lastfm/api.js';
import type { GroupName } from '../../src/rules/markers.js';

const ENABLED = new Set<GroupName>(['remaster', 'edition', 'bonus']);

function db() {
  const d = createDb(':memory:');
  runMigrations(d);
  return d;
}

function api(scrobbles: { track: string; artist: string; album: string; uts: number }[]) {
  return {
    iterateRecentTracks: async function* () {
      for (const s of scrobbles) yield s;
    },
    iterateTopAlbums: async function* () {},
    iterateTopTracks: async function* () {},
  } as unknown as LastfmApi;
}

describe('incremental discovery', () => {
  it('finds a dirty album and a dirty track from new scrobbles', async () => {
    const p = new Planner(
      api([
        { track: 'Unsatisfied - Remastered', artist: 'The Replacements', album: 'Tim', uts: 100 },
        { track: 'Kiss Me on the Bus', artist: 'The Replacements', album: 'Tim (Deluxe Edition)', uts: 200 },
      ]),
      'u',
      ENABLED,
    );
    const r = await p.sweepIncremental(0);
    expect(r.candidates.map((c) => `${c.kind}:${c.title}`)).toEqual([
      'album:Tim (Deluxe Edition)',
      'track:Unsatisfied - Remastered',
    ]);
  });

  it('puts albums before tracks, matching the full sweep ordering', async () => {
    const p = new Planner(
      api([
        { track: 'Bastards of Young - Remastered', artist: 'X', album: 'Clean', uts: 10 },
        { track: 'Clean Track', artist: 'X', album: 'Dirty (Deluxe Edition)', uts: 20 },
      ]),
      'u',
      ENABLED,
    );
    expect((await p.sweepIncremental(0)).candidates.map((c) => c.kind)).toEqual(['album', 'track']);
  });

  it('reports the newest scrobble seen so the cursor can advance', async () => {
    const p = new Planner(
      api([
        { track: 'Answering Machine - Remastered', artist: 'X', album: '', uts: 500 },
        { track: 'Sixteen Blue - Remastered', artist: 'X', album: '', uts: 900 },
      ]),
      'u',
      ENABLED,
    );
    expect((await p.sweepIncremental(100)).newestUts).toBe(900);
  });

  it('deduplicates an album seen on many scrobbles', async () => {
    const p = new Planner(
      api([
        { track: 'one', artist: 'X', album: 'Same (Remastered)', uts: 1 },
        { track: 'two', artist: 'X', album: 'Same (Remastered)', uts: 2 },
        { track: 'three', artist: 'X', album: 'Same (Remastered)', uts: 3 },
      ]),
      'u',
      ENABLED,
    );
    expect((await p.sweepIncremental(0)).candidates).toHaveLength(1);
  });

  it('finds nothing when the new scrobbles are all clean', async () => {
    const p = new Planner(
      api([{ track: 'Clean', artist: 'X', album: 'Also Clean', uts: 5 }]),
      'u',
      ENABLED,
    );
    const r = await p.sweepIncremental(0);
    expect(r.candidates).toEqual([]);
    expect(r.newestUts).toBe(5);
  });
});

describe('dead-candidate memory', () => {
  const cand = { kind: 'album' as const, artist: 'Joy Division', title: "Closer (Collector's Edition)" };

  it('filters a candidate only once it has hit the attempt threshold', async () => {
    const d = db();
    const scrobbles = [{ track: 'x', artist: 'Joy Division', album: "Closer (Collector's Edition)", uts: 1 }];
    const p = new Planner(api(scrobbles), 'u', ENABLED, d, 3);

    p.recordDead(cand, 'album no longer in library under that title');
    expect((await p.sweepIncremental(0)).candidates).toHaveLength(1);

    p.recordDead(cand, 'again');
    p.recordDead(cand, 'again');
    expect((await p.sweepIncremental(0)).candidates).toEqual([]);
  });

  it('counts attempts rather than inserting duplicates', () => {
    const d = db();
    const p = new Planner(api([]), 'u', ENABLED, d, 3);
    p.recordDead(cand, 'a');
    p.recordDead(cand, 'b');
    const rows = d.select().from(schema.deadCandidates).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(2);
    expect(rows[0]!.reason).toBe('b');
  });

  it('forgets a candidate that resolves after all', async () => {
    const d = db();
    const scrobbles = [{ track: 'x', artist: 'Joy Division', album: "Closer (Collector's Edition)", uts: 1 }];
    const p = new Planner(api(scrobbles), 'u', ENABLED, d, 1);
    p.recordDead(cand, 'empty');
    expect((await p.sweepIncremental(0)).candidates).toEqual([]);

    p.clearDead(cand);
    expect((await p.sweepIncremental(0)).candidates).toHaveLength(1);
  });

  it('does nothing when no database is wired, so the planner stays usable standalone', () => {
    const p = new Planner(api([]), 'u', ENABLED);
    expect(() => p.recordDead(cand, 'x')).not.toThrow();
    expect(() => p.clearDead(cand)).not.toThrow();
  });
});
