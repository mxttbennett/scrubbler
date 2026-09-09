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

/** A sweep_state row as 0007 left it: a live cursor and a full-sweep stamp, no cluster stamp. */
function seedThrough0007(db: ReturnType<typeof createDb>) {
  db.run(sql`
    INSERT INTO sweep_state (id, last_full_sweep_at, last_sweep_edit_count, last_scrobble_uts, paused)
    VALUES (1, 1772659220000, 7, 1772659220, 0)
  `);
}

describe('migration 0008 — cluster sweep stamp', () => {
  it('carries the existing sweep_state row forward untouched', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'scrubbler-db-')), 'ledger.sqlite');
    const db = createDb(file);
    runMigrations(db, migrationsUpTo(7));
    seedThrough0007(db);

    runMigrations(db, 'drizzle');

    const state = db.select().from(schema.sweepState).all()[0]!;
    expect(state.lastScrobbleUts).toBe(1772659220);
    expect(state.lastSweepEditCount).toBe(7);
    expect(state.paused).toBe(false);
  });

  /** Null is what makes the first cycle after an upgrade run the scan rather than skip it. */
  it('leaves the new stamp null on an upgraded row', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'scrubbler-db-')), 'ledger.sqlite');
    const db = createDb(file);
    runMigrations(db, migrationsUpTo(7));
    seedThrough0007(db);

    runMigrations(db, 'drizzle');

    expect(db.select().from(schema.sweepState).all()[0]!.lastClusterSweepAt).toBeNull();
  });

  it('round-trips a stamp afterwards', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const at = new Date(1772659220000);

    db.insert(schema.sweepState).values({ id: 1, lastClusterSweepAt: at }).run();

    expect(db.select().from(schema.sweepState).all()[0]!.lastClusterSweepAt).toEqual(at);
  });

  /** A third entity kind is a TypeScript widening only; SQLite has no CHECK to migrate. */
  it('accepts an artist row in the tables a candidate is remembered in', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    db.insert(schema.deadCandidates)
      .values({
        kind: 'artist',
        artist: 'Jim O’Rourke',
        title: 'Jim O’Rourke',
        reason: 'no scrobble rows found on library page',
        lastTriedAt: new Date(1772659220000),
      })
      .run();

    expect(db.select().from(schema.deadCandidates).all()[0]!.kind).toBe('artist');
  });
});
