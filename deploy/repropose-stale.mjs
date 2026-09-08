// Plain ESM, and in deploy/ rather than scripts/, because the deploy rsyncs deploy/ but not
// scripts/ and `tsx` is a devDependency — `npm ci --omit=dev` leaves the box unable to run a .ts
// file. better-sqlite3 is a production dependency, so plain node works.
//
// Drops the outstanding proposals for one rule so the next full sweep re-resolves them under the
// rule's current meaning. Deletion, not a status change: checkpoint() refuses to refresh a row that
// is not `planned`, and a `planned` row is re-proposed straight from the ledger by carryOver before
// anything re-resolves it — so either status would re-post the old target.
//
//   node deploy/repropose-stale.mjs live-track            # dry run
//   node deploy/repropose-stale.mjs live-track --apply
//
// Run with the service STOPPED: a card is clickable until it is gone, and clicking one applies the
// stored edit. Retiring the Discord message is not attempted from here (no token); the orphaned
// cards are cleared by hand.
import Database from 'better-sqlite3';

const [rule, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');
const dbPath = process.env.DB_PATH ?? '.data/scrubbler.sqlite';

if (rule === undefined) {
  console.error('usage: node deploy/repropose-stale.mjs <rule> [--apply]');
  process.exit(2);
}

const db = new Database(dbPath);
const rows = db
  .prepare(
    `SELECT a.id AS approvalId, e.id AS editId, e.track_name_original AS title, e.groups
       FROM approvals a
       JOIN approval_edits ae ON ae.approval_id = a.id
       JOIN applied_edits e ON e.id = ae.applied_edit_id
      WHERE a.status = 'pending' AND (',' || e.groups || ',') LIKE ?`,
  )
  .all(`%,${rule},%`);

if (rows.length === 0) {
  console.log(`no pending proposals carry ${rule}; nothing to do`);
  process.exit(0);
}

const approvalIds = [...new Set(rows.map((r) => r.approvalId))];
console.log(`${rows.length} ledger row(s) across ${approvalIds.length} proposal(s) for ${rule}:`);
for (const r of rows) console.log(`  ${JSON.stringify(r.title)}  [${r.groups}]`);

if (!apply) {
  console.log('\ndry run — pass --apply to delete these and let the next sweep re-propose them');
  process.exit(0);
}

const drop = db.transaction((ids) => {
  for (const id of ids) {
    const editIds = db
      .prepare('SELECT applied_edit_id AS id FROM approval_edits WHERE approval_id = ?')
      .all(id)
      .map((r) => r.id);
    db.prepare('DELETE FROM approval_edits WHERE approval_id = ?').run(id);
    for (const editId of editIds) db.prepare('DELETE FROM applied_edits WHERE id = ?').run(editId);
    db.prepare('DELETE FROM approvals WHERE id = ?').run(id);
  }
});
drop(approvalIds);
console.log(`\ndeleted ${approvalIds.length} proposal(s); the next full sweep will re-propose them`);
