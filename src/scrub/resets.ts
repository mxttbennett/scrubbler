import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';

/**
 * The things a reset can forget. Each is derived state the service rebuilds on its own, which is
 * why only `proposals` — the one that discards recorded decisions — asks before it runs.
 */
export const RESET_TARGETS = ['cursor', 'dead', 'proposals', 'shadow'] as const;

export type ResetTarget = (typeof RESET_TARGETS)[number];

export function isResetTarget(value: string): value is ResetTarget {
  return (RESET_TARGETS as readonly string[]).includes(value);
}

/**
 * Clears the incremental cursor so the next cycle sweeps the whole library.
 *
 * `lastFullSweepAt` is deliberately left alone: `fullDue` is `cursor === null || …`, so a null
 * cursor already forces a full sweep, and nulling both was the older CLI's redundant second half.
 */
export function clearCursor(db: Db): void {
  db.insert(schema.sweepState)
    .values({ id: 1, lastScrobbleUts: null })
    .onConflictDoUpdate({ target: schema.sweepState.id, set: { lastScrobbleUts: null } })
    .run();
}

/** Forgets the candidates learned to resolve to nothing, so they are tried again. */
export function clearDead(db: Db): number {
  const n = db.select().from(schema.deadCandidates).all().length;
  db.delete(schema.deadCandidates).run();
  return n;
}

/** Forgets recorded shadow hits, for one rule or all of them, so they are announced again. */
export function clearShadow(db: Db, rule?: string): number {
  const rows = db.select().from(schema.shadowHits).all();
  const n = rule === undefined ? rows.length : rows.filter((r) => r.rule === rule).length;
  db.delete(schema.shadowHits)
    .where(rule === undefined ? undefined : eq(schema.shadowHits.rule, rule))
    .run();
  return n;
}
