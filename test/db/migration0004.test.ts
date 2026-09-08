import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, runMigrations, schema } from '../../src/db/index.js';

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** Builds a migrations folder truncated at `upToIdx`, so a run can start from an older schema. */
function migrationsUpTo(upToIdx: number): string {
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as Journal;
  const entries = journal.entries.filter((e) => e.idx <= upToIdx);
  const dir = mkdtempSync(join(tmpdir(), 'scrubbler-migrations-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const e of entries) copyFileSync(`drizzle/${e.tag}.sql`, join(dir, `${e.tag}.sql`));
  return dir;
}

/**
 * Seeds with raw SQL, not the Drizzle schema: the typed schema is always the *latest* shape, so
 * inserting through it against a 0003-era database would try to write columns that do not exist yet.
 */
function seedPre0004(db: ReturnType<typeof createDb>) {
  const rows: [string, string, string, string | null][] = [
    ['Silver Springs - 2004 Remaster', 'Silver Springs', 'verified', '/user/u/library/music/+noredirect/A/_/B'],
    ['Disorder - 2019 Digital Master', 'Disorder', 'planned', '/user/u/library/music/+noredirect/C/_/D'],
    ['De Do Do Do, De Da Da Da', 'De Do Do Do', 'unverified', null],
  ];
  for (const [i, [from, to, status, ref]] of rows.entries()) {
    db.run(sql`
      insert into applied_edits (
        track_name_original, artist_name_original, album_name_original, album_artist_name_original,
        track_name, artist_name, album_name, album_artist_name,
        groups, status, attempts, created_at, timestamp, action, referer_path
      ) values (
        ${from}, ${`Artist ${i}`}, ${`Album ${i}`}, ${`Artist ${i}`},
        ${to}, ${`Artist ${i}`}, ${`Album ${i}`}, ${`Artist ${i}`},
        'remaster', ${status}, 0, ${Date.now()}, '1772659220',
        '/user/u/library/edit-track?edited-variation=library-track-scrobble', ${ref}
      )`);
  }
}

describe('migration 0004 against a live-shaped database', () => {
  it('preserves every pre-existing row and defaults them to kind=track', () => {
    const db = createDb(':memory:');
    runMigrations(db, migrationsUpTo(3));
    seedPre0004(db);

    runMigrations(db, 'drizzle');

    const rows = db.select().from(schema.appliedEdits).all();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.kind === 'track')).toBe(true);
    expect(rows.map((r) => r.status).sort()).toEqual(['planned', 'unverified', 'verified']);
    // the columns 0001-0003 added must survive the ALTER
    expect(rows.find((r) => r.status === 'planned')?.refererPath).toContain('+noredirect');
    expect(rows.find((r) => r.status === 'planned')?.timestamp).toBe('1772659220');
  });

  it('still rejects a duplicate tuple after the ALTER', () => {
    const db = createDb(':memory:');
    runMigrations(db, migrationsUpTo(3));
    seedPre0004(db);
    runMigrations(db, 'drizzle');

    const dupe = db.select().from(schema.appliedEdits).all()[0]!;
    expect(() =>
      db
        .insert(schema.appliedEdits)
        .values({
          trackNameOriginal: dupe.trackNameOriginal,
          artistNameOriginal: dupe.artistNameOriginal,
          albumNameOriginal: dupe.albumNameOriginal,
          albumArtistNameOriginal: dupe.albumArtistNameOriginal,
          trackName: 'x',
          artistName: 'x',
          albumName: 'x',
          albumArtistName: 'x',
          groups: '',
          status: 'planned',
        })
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('lets an album row coexist with a track row for the same album', () => {
    const db = createDb(':memory:');
    runMigrations(db, 'drizzle');
    const common = { albumNameOriginal: 'Tim (Remastered)', albumArtistNameOriginal: 'The Replacements' };

    db.insert(schema.appliedEdits)
      .values({
        ...common,
        trackNameOriginal: 'Left of the Dial',
        artistNameOriginal: 'The Replacements',
        trackName: 'Left of the Dial',
        artistName: 'The Replacements',
        albumName: 'Tim',
        albumArtistName: 'The Replacements',
        groups: 'remaster',
        status: 'verified',
        kind: 'track',
      })
      .run();

    // the album row uses '' for the track fields, so the unique index sees a different tuple
    expect(() =>
      db
        .insert(schema.appliedEdits)
        .values({
          ...common,
          trackNameOriginal: '',
          artistNameOriginal: '',
          trackName: '',
          artistName: '',
          albumName: 'Tim',
          albumArtistName: 'The Replacements',
          groups: 'remaster',
          status: 'verified',
          kind: 'album',
        })
        .run(),
    ).not.toThrow();

    expect(db.select().from(schema.appliedEdits).all()).toHaveLength(2);
  });

  it('creates the approvals, approval_edits and ignored tables', () => {
    const db = createDb(':memory:');
    runMigrations(db, 'drizzle');
    const names = db
      .all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`)
      .map((r) => r.name);
    expect(names).toContain('approvals');
    expect(names).toContain('approval_edits');
    expect(names).toContain('ignored');
  });

  it('adds the live sweep_state fields a status command reads', () => {
    const db = createDb(':memory:');
    runMigrations(db, 'drizzle');
    db.insert(schema.sweepState).values({ id: 1 }).run();
    const row = db.select().from(schema.sweepState).all()[0]!;
    expect(row.paused).toBe(false);
    expect(row.phase).toBe('idle');
    expect(row.candidatesTotal).toBe(0);
  });
});
