# Deploying scrubbler

Deploy with the **`deploy` workflow** (Actions -> deploy -> Run workflow). It runs the checks, takes
the pre-deploy snapshot, swaps the build in and confirms the service booted — the steps under
*Every deploy* below, which remain the manual fallback.

**Dispatch the tag you want, not the branch.** The run is titled after its ref, so
`gh workflow run deploy --ref v1.1.0` reads `deploy v1.1.0` in the run list while dispatching `main`
reads `deploy main` and deploys whatever `main` happens to be. Either way the run summary records the
version that actually came up, read back from the box rather than from `package.json`, and a
successful deploy promotes that release out of pre-release — see
[VERSIONING.md](../VERSIONING.md#pre-release-until-it-has-run). Deploying an *older* tag is a
rollback — read *Rolling back* and *Rolling back past the approval gate* first.

The trigger is `workflow_dispatch` only. The sibling `feed1` service deploys on every push to
`main`, but a merge here widens what this service rewrites on a real Last.fm account and those edits
are irreversible, so the button is the human beat before that happens.

Releases are tagged separately, on merge to `main`, by the `release` workflow — tagging writes
nothing to Last.fm, so it is safe to automate where deploying is not. **The newest tag is therefore
not necessarily what is running**; see [VERSIONING.md](../VERSIONING.md) for how to tell.

Also unlike `feed1`: no rollback-by-tag input and no migration guard. Rollback here carries two
hazards that need a human reading this file first — Drizzle being forward-only, and an old build not
recognising `awaiting_approval`. See *Rolling back past the approval gate*.

## One-time

```sh
scp -r deploy ubuntu@<host>:/tmp/
ssh ubuntu@<host> 'bash /tmp/deploy/provision.sh'
```

Then create `/opt/scrubbler/.env` from `.env.example`, `chmod 600`, and **leave
`DRY_RUN=true`**.

## Every deploy

The workflow does all of this. These are the same steps by hand, for when Actions is unavailable.

```sh
npm run build
# 1. snapshot the ledger BEFORE anything else (see note)
ssh ubuntu@<host> 'cd /opt/scrubbler && node -e "
  const D=require(\"better-sqlite3\");const d=new D(\".data/scrubbler.sqlite\");
  d.exec(\`VACUUM INTO '\''.data/backups/predeploy_\$(date +%s).sqlite'\''\`);"'
# 2. ship
rsync -az --delete dist drizzle deploy package.json package-lock.json \
  ubuntu@<host>:/opt/scrubbler/
ssh ubuntu@<host> 'cd /opt/scrubbler && npm ci --omit=dev && sudo systemctl restart scrubbler'
ssh ubuntu@<host> 'sleep 5 && systemctl is-active scrubbler'
```

**Use `VACUUM INTO`, not `cp`.** The service exits without closing the SQLite handle, so committed
frames can still be sitting in the `-wal` file and a plain copy loses them.

## First real run

Start with `DRY_RUN=true`, let one sweep finish, and read the report:

```sh
journalctl -u scrubbler -f
```

Only then set `DRY_RUN=false` and restart. The first real sweep is the irreversible one — it applies
the whole backlog at once, bounded by `MAX_EDITS_PER_RUN`.

## Rollback

1. Restore the newest `predeploy_*.sqlite` over `.data/scrubbler.sqlite`, and delete the
   stale `-wal` / `-shm` files alongside it.
2. Redeploy the previous build.

Two caveats:

- **Drizzle is forward-only** and decides what to apply from the highest `created_at` in
  `__drizzle_migrations`. Rolling code back past a migration runs old code against a newer schema
  with no error — just wrong behaviour. Restore the matching snapshot too.
- **Rollback does not undo Last.fm edits.** Those are irreversible no matter what this repo does;
  the ledger is the only record of what changed. To stop further writes immediately, set
  `DRY_RUN=true` and restart, or `sudo systemctl stop scrubbler`.

## Ops notes

- Logs: `journalctl -u scrubbler -f`. No log library; journald supplies timestamps.
- State lives entirely in `.data/`: the ledger, `session.json` (the cookie jar, mode 600), and
  `backups/`. Excluded from the deploy rsync.
- A dead session reports to the Discord webhook and the service keeps retrying on the next sweep. If
  the password changes, update `.env` and restart.

## Deploying a build that adds a dependency

`discord.js` is a runtime dependency, so the deploy is not just a file swap:

1. `systemctl stop scrubbler` and wait for it to exit — the unit allows 90s so an in-flight edit
   and its verification finish. Killing it between the Last.fm POST and the ledger row that
   records it is the one thing to avoid.
2. rsync the build, then `npm ci --omit=dev` on the box. A stale `node_modules` fails at import.
3. `systemctl start scrubbler` and check `journalctl -u scrubbler -n 30` for the startup line,
   which names the mode.

## Rolling back past the approval gate — read this first

Rollback is **unsafe by default**. `Executor.run` skips only `verified` and `applied`, so a build
from before the approval gate does not recognise `awaiting_approval` and would happily write every
queued edit without a decision. Clear the queue before deploying the old build:

1. `systemctl stop scrubbler`
2. ```sql
   UPDATE applied_edits
      SET status = 'skipped', last_error = 'rolled back before approval'
    WHERE status = 'awaiting_approval';
   ```
   Run it against `.data/scrubbler.sqlite` with `sqlite3`. Take a copy of the file first.
3. Deploy the old build and start it.

Skipping step 2 does not corrupt anything, but it applies edits you never approved — and Last.fm
edits are irreversible.

## Changing what a rule *means*

Changing a rule's tier is one thing; changing the edit a rule produces is another. Outstanding
proposals carry the edit computed under the **old** rule — `Approvals.approve()` rebuilds from the
ledger row, and its `stillThere` check confirms the entity is unchanged, not that the rule still
gives the same answer. Nor does waiting help: `expire()` returns the rows to `planned` and
`carryOver` re-proposes them from the same stored values, so the old edit is re-posted indefinitely.

So a rule-semantics change needs the stale proposals dropped, **with the service stopped** — a card
is clickable until it is gone:

```sh
ssh ubuntu@<host> 'sudo systemctl stop scrubbler'          # drains in-flight work
# snapshot (see Every deploy)
ssh ubuntu@<host> 'cd /opt/scrubbler && node deploy/repropose-stale.mjs live-track'           # dry run
ssh ubuntu@<host> 'cd /opt/scrubbler && node deploy/repropose-stale.mjs live-track --apply'
# deploy the new build, then start
```

The script deletes the `approvals`, `approval_edits` and `applied_edits` rows together, so nothing
carries the old target forward and the next full sweep re-resolves the entity. It cannot retire the
Discord cards (no token), so the orphaned messages are cleared by hand. If shadow rows exist for the
rule, `/scrub shadow-clear <rule>` drops their stale verdicts.

## Changing a rule's tier

Tiers are read once at startup, so any change needs a restart. `/scrub pause` is the live stop.

Promoting a group to `gated` is safe — its candidates simply start arriving as cards instead of
being written.

**Demoting a group from `gated` to `auto` applies its outstanding proposals.** The next cycle drains
them through the ordinary path and retires their cards, because incremental discovery only sees new
scrobbles and would otherwise leave those entities waiting for the weekly full sweep. That is the
same behaviour as turning `APPROVAL_MODE` off, but it is now reachable one group at a time — and
those cards were never answered. Answer them first if that matters, because the writes are
irreversible.

## Rolling back past custom replacements

`groups` now carries a `custom` tag alongside the catalogue names. It is read back with an unchecked
cast (`executor.ts`), so an older build will accept the value without complaining — the tag only
renders in the `rule` field of an embed, so the consequence is a wrong label, never a wrong edit. No
SQL step is needed for this migration, unlike the approval gate above.
