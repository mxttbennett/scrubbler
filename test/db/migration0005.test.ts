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

describe('migration 0005 — custom rules', () => {
  it('carries every pre-existing row forward untouched', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'scrubbler-db-')), 'ledger.sqlite');
    const db = createDb(file);
    runMigrations(db, migrationsUpTo(4));
    seedThrough0004(db);

    runMigrations(db, 'drizzle');

    const edits = db.select().from(schema.appliedEdits).all();
    expect(edits).toHaveLength(2);
    expect(edits.find((e) => e.kind === 'track')!.status).toBe('verified');
    expect(edits.find((e) => e.kind === 'album')!.status).toBe('awaiting_approval');
    expect(db.select().from(schema.ignored).all()).toHaveLength(1);
  });

  it('leaves the new table empty rather than backfilling anything', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'scrubbler-db-')), 'ledger.sqlite');
    const db = createDb(file);
    runMigrations(db, migrationsUpTo(4));
    seedThrough0004(db);

    runMigrations(db, 'drizzle');

    expect(db.select().from(schema.customRules).all()).toEqual([]);
  });

  it('rejects a duplicate rule for the same kind, artist and title', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    const values = {
      kind: 'album' as const,
      artist: 'Pavement',
      fromTitle: 'Wowee Zowee: Sordid Sentinels Edition',
      toTitle: 'Wowee Zowee',
    };
    db.insert(schema.customRules).values(values).run();

    expect(() => db.insert(schema.customRules).values(values).run()).toThrow(/UNIQUE/);
  });

  it('keeps the same title apart per artist, since no key column is nullable', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    db.insert(schema.customRules)
      .values({ kind: 'album', artist: 'Nirvana', fromTitle: 'Bleach', toTitle: 'Bleach [1989]' })
      .run();
    db.insert(schema.customRules)
      .values({ kind: 'album', artist: 'Soundgarden', fromTitle: 'Bleach', toTitle: 'Bleach [1988]' })
      .run();

    expect(db.select().from(schema.customRules).all()).toHaveLength(2);
  });
});
