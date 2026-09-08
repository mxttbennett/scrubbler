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
 * Raw SQL, not the typed schema: Drizzle's schema object is always the latest shape, so seeding
 * through it cannot represent the database as 0004 left it.
 */
function seedThrough0004(db: ReturnType<typeof createDb>) {
  db.run(sql`
    INSERT INTO applied_edits
      (track_name_original, artist_name_original, album_name_original, album_artist_name_original,
       track_name, artist_name, album_name, album_artist_name, kind, groups, timestamp, action,
       referer_path, status, attempts)
    VALUES
      ('Disorder - 2019 Digital Master', 'Joy Division', 'Unknown Pleasures', 'Joy Division',
       'Disorder', 'Joy Division', 'Unknown Pleasures', 'Joy Division', 'track', 'remaster',
       '1772659220', '/user/u/library/edit-track', '/user/u/library/music/x', 'verified', 0),
      ('', '', 'In Utero (Deluxe Edition)', 'Nirvana',
       '', '', 'In Utero', 'Nirvana', 'album', 'edition',
       '', '/library/edit-album', '/user/u/library/music/y', 'awaiting_approval', 0)
  `);
  db.run(sql`
    INSERT INTO ignored (kind, artist, title, reason)
    VALUES ('track', 'Slint', 'Good Morning, Captain', 'rejected in discord')
  `);
}

describe('migration 0007 — album track names', () => {
  it('carries every pre-existing row forward untouched', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'scrubbler-db-')), 'ledger.sqlite');
    const db = createDb(file);
    runMigrations(db, migrationsUpTo(6));
    seedThrough0004(db);

    runMigrations(db, 'drizzle');

    const edits = db.select().from(schema.appliedEdits).all();
    expect(edits).toHaveLength(2);
    expect(edits.find((e) => e.kind === 'track')!.status).toBe('verified');
    expect(edits.find((e) => e.kind === 'album')!.status).toBe('awaiting_approval');
    expect(db.select().from(schema.ignored).all()).toHaveLength(1);
  });

  it('leaves track_names null on every pre-existing album row', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'scrubbler-db-')), 'ledger.sqlite');
    const db = createDb(file);
    runMigrations(db, migrationsUpTo(6));
    seedThrough0004(db);

    runMigrations(db, 'drizzle');

    const album = db.select().from(schema.appliedEdits).all().find((r) => r.kind === 'album')!;
    expect(album.trackNames).toBeNull();
    expect(album.albumNameOriginal).toBe('In Utero (Deluxe Edition)');
  });

  it('accepts a JSON array afterwards', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    db.insert(schema.appliedEdits)
      .values({
        trackNameOriginal: '',
        artistNameOriginal: '',
        albumNameOriginal: 'Stop Making Sense (Live)',
        albumArtistNameOriginal: 'Talking Heads',
        trackName: '',
        artistName: '',
        albumName: 'Stop Making Sense',
        albumArtistName: 'Talking Heads',
        kind: 'album',
        groups: 'live-album',
        status: 'verified',
        trackNames: JSON.stringify(['Making Flippy Floppy', 'Good Morning, Captain']),
      })
      .run();

    const row = db.select().from(schema.appliedEdits).all()[0]!;
    expect(JSON.parse(row.trackNames!)).toEqual([
      'Making Flippy Floppy',
      'Good Morning, Captain',
    ]);
  });

  it('keeps the tables added by 0005 and 0006 intact', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    expect(db.select().from(schema.customRules).all()).toEqual([]);
    expect(db.select().from(schema.shadowHits).all()).toEqual([]);
  });
});
