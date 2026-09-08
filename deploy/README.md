# Deploying scrubbler

Deployment is **manual**. The sibling `feed1` service has a full GitHub Actions deploy with rollback
tags and a migration guard; that machinery is more moving parts than this three-table single-user
daemon warrants. The risks it manages are real here too, so they are handled by the steps below.

## One-time

```sh
scp -r deploy ubuntu@<host>:/tmp/
ssh ubuntu@<host> 'bash /tmp/deploy/provision.sh'
```

Then create `/opt/scrubbler/.env` from `.env.example`, `chmod 600`, and **leave
`DRY_RUN=true`**.

## Every deploy

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
