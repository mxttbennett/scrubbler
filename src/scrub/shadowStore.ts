import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { ShadowHit } from '../rules/shadow.js';

export interface StoredShadowHit {
  id: number;
  rule: string;
  kind: 'track' | 'album';
  artist: string;
  title: string;
  wouldBe: string;
  reportedAt: Date | null;
}

export class ShadowStore {
  constructor(private readonly db: Db) {}

  /**
   * Upserts and answers whether this hit still needs announcing. `reportedAt` is separate from
   * `seenAt` because the REST sender returns silently when Discord is unconfigured — marking a row
   * reported at record time would suppress a card that was never sent.
   */
  record(hit: ShadowHit, now = new Date()): { needsReport: boolean } {
    const existing = this.db
      .select()
      .from(schema.shadowHits)
      .where(
        and(
          eq(schema.shadowHits.rule, hit.rule),
          eq(schema.shadowHits.kind, hit.kind),
          eq(schema.shadowHits.title, hit.title),
        ),
      )
      .get();

    if (existing === undefined) {
      this.db
        .insert(schema.shadowHits)
        .values({
          rule: hit.rule,
          kind: hit.kind,
          title: hit.title,
          wouldBe: hit.wouldBe,
          sourceArtist: hit.artist,
          lastSeenAt: now,
        })
        .run();
      return { needsReport: true };
    }

    // A refined rule can produce a different answer for the same title — eight patterns changed in
    // one evening — so a changed verdict is re-announced rather than suppressed by the stale row.
    const changed = existing.wouldBe !== hit.wouldBe;
    this.db
      .update(schema.shadowHits)
      .set({
        wouldBe: hit.wouldBe,
        sourceArtist: hit.artist,
        lastSeenAt: now,
        ...(changed ? { reportedAt: null } : {}),
      })
      .where(eq(schema.shadowHits.id, existing.id))
      .run();

    return { needsReport: changed || existing.reportedAt === null };
  }

  unreported(limit: number): StoredShadowHit[] {
    if (limit <= 0) return [];
    return this.db
      .select()
      .from(schema.shadowHits)
      .where(isNull(schema.shadowHits.reportedAt))
      .orderBy(asc(schema.shadowHits.id))
      .limit(limit)
      .all()
      .map(toStored);
  }

  countUnreported(): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(schema.shadowHits)
        .where(isNull(schema.shadowHits.reportedAt))
        .get()?.n ?? 0
    );
  }

  markReported(id: number, now = new Date()): void {
    this.db
      .update(schema.shadowHits)
      .set({ reportedAt: now })
      .where(eq(schema.shadowHits.id, id))
      .run();
  }

  list(rule?: string): StoredShadowHit[] {
    const rows = this.db
      .select()
      .from(schema.shadowHits)
      .where(rule === undefined ? undefined : eq(schema.shadowHits.rule, rule))
      .orderBy(asc(schema.shadowHits.rule), asc(schema.shadowHits.title))
      .all();
    return rows.map(toStored);
  }

  countsByRule(): { rule: string; n: number }[] {
    return this.db
      .select({ rule: schema.shadowHits.rule, n: sql<number>`count(*)` })
      .from(schema.shadowHits)
      .groupBy(schema.shadowHits.rule)
      .all();
  }
}

function toStored(r: typeof schema.shadowHits.$inferSelect): StoredShadowHit {
  return {
    id: r.id,
    rule: r.rule,
    kind: r.kind,
    artist: r.sourceArtist,
    title: r.title,
    wouldBe: r.wouldBe,
    reportedAt: r.reportedAt,
  };
}
