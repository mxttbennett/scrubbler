import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';

const LEDGER_STATUSES = [
  'applied',
  'verified',
  'unverified',
  'failed',
  'skipped',
  'planned',
  'awaiting_approval',
  'ignored',
] as const;

type LedgerStatus = (typeof LEDGER_STATUSES)[number];
type EditKind = 'track' | 'album';
type LedgerCounts = Record<LedgerStatus, number>;

export interface DaemonStatus {
  sweep: typeof schema.sweepState.$inferSelect | undefined;
  ledger: {
    byStatus: LedgerCounts;
    byKind: Record<EditKind, LedgerCounts>;
  };
  pendingApprovals: number;
}

function emptyCounts(): LedgerCounts {
  return Object.fromEntries(LEDGER_STATUSES.map((status) => [status, 0])) as LedgerCounts;
}

export function readDaemonStatus(db: Db): DaemonStatus {
  const sweep = db
    .select()
    .from(schema.sweepState)
    .where(eq(schema.sweepState.id, 1))
    .get();
  const rows = db
    .select({
      kind: schema.appliedEdits.kind,
      status: schema.appliedEdits.status,
      n: sql<number>`count(*)`,
    })
    .from(schema.appliedEdits)
    .groupBy(schema.appliedEdits.kind, schema.appliedEdits.status)
    .all();
  const byStatus = emptyCounts();
  const byKind = { track: emptyCounts(), album: emptyCounts() };
  for (const row of rows) {
    byStatus[row.status] += row.n;
    byKind[row.kind][row.status] = row.n;
  }
  const pendingApprovals = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.approvals)
    .where(eq(schema.approvals.status, 'pending'))
    .get()?.n ?? 0;

  return { sweep, ledger: { byStatus, byKind }, pendingApprovals };
}
