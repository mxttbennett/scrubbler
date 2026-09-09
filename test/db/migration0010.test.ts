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

function seedThrough0007(db: ReturnType<typeof createDb>) {
  db.run(sql`
    INSERT INTO applied_edits
      (track_name_original, artist_name_original, album_name_original, album_artist_name_original,
       track_name, artist_name, album_name, album_artist_name, kind, groups, timestamp, action,
       referer_path, status, attempts)
    VALUES
      ('Disorder - 2019 Digital Master', 'Joy Division', 'Unknown Pleasures', 'Joy Division',
       'Disorder', 'Joy Division', 'Unknown Pleasures', 'Joy Division', 'track', 'remaster',
       '1772659220', '/user/u/library/edit-track', '/user/u/library/music/x', 'verified', 0)
  `);
  db.run(sql`
    INSERT INTO custom_rules (kind, artist, from_title, to_title, created_by)
    VALUES ('track', 'Slint', 'Good Morning, Captain (Live)', 'Good Morning, Captain', 'discord')
  `);
}

function tempDbFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'scrubbler-db-')), 'ledger.sqlite');
}

describe('migration 0008 — library mirror', () => {
  it('carries every pre-existing row forward untouched', () => {
    const db = createDb(tempDbFile());
    runMigrations(db, migrationsUpTo(7));
    seedThrough0007(db);

    runMigrations(db, 'drizzle');

    const edits = db.select().from(schema.appliedEdits).all();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.status).toBe('verified');
    expect(edits[0]!.trackNameOriginal).toBe('Disorder - 2019 Digital Master');
    expect(db.select().from(schema.customRules).all()).toHaveLength(1);
  });

  it('creates the table empty, so an upgraded database mirrors nothing until it enumerates', () => {
    const db = createDb(tempDbFile());
    runMigrations(db, migrationsUpTo(7));
    seedThrough0007(db);

    runMigrations(db, 'drizzle');

    expect(db.select().from(schema.library).all()).toEqual([]);
  });

  it('declares the entity uniqueness and both lookup indexes', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    const names = db
      .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'library'`)
      .map((r) => r.name);

    expect(names).toContain('library_entity');
    expect(names).toContain('library_album');
    expect(names).toContain('library_playcount');
  });

  it('rejects a duplicate (kind, artist, title) but allows the same title under another kind', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    db.insert(schema.library)
      .values({ kind: 'track', artist: 'Slint', title: 'Spiderland' })
      .run();
    db.insert(schema.library)
      .values({ kind: 'album', artist: 'Slint', title: 'Spiderland' })
      .run();

    expect(() =>
      db.insert(schema.library).values({ kind: 'track', artist: 'Slint', title: 'Spiderland' }).run(),
    ).toThrow();
    expect(db.select().from(schema.library).all()).toHaveLength(2);
  });

  it('defaults playcount and map_attempts to 0 and leaves the album mapping null', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    db.insert(schema.library).values({ kind: 'track', artist: 'Low', title: 'Sunflower' }).run();

    const row = db.select().from(schema.library).all()[0]!;
    expect(row.playcount).toBe(0);
    expect(row.mapAttempts).toBe(0);
    expect(row.albumTitle).toBeNull();
    expect(row.albumArtist).toBeNull();
    expect(row.albumSource).toBeNull();
    expect(row.mappedAt).toBeNull();
  });
});
